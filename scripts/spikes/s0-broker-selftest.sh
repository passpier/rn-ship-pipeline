#!/usr/bin/env bash
#
# Exercises s0-broker.sh with no GitHub and no second user: a local bare repo stands
# in for the remote, a stub mints a fake token, a stub gh records PR calls, and your
# own uid plays the agent. Checks the happy path and every refusal.
#
#   scripts/spikes/s0-broker-selftest.sh

set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
S=$T/shared REMOTE=$T/remote/passpier/rnship-s6-probe.git
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }
expect() { local name=$1; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

mkdir -p "$S/spool" "$S/broker-out" "$S/broker-work" "$T/bin"
chmod 1733 "$S/spool"; chmod 755 "$S/broker-out"; chmod 700 "$S/broker-work"
printf 'S0_APP_ID=1\nS0_APP_INSTALLATION_ID=2\n' > "$T/results"

# Stubs: mint logs its calls; gh keeps each --input body and prints a PR URL.
cat > "$T/bin/mint" <<EOS
#!/bin/sh
echo "\$*" >> "$T/mint.log"; echo '{"token":"stub-token"}'
EOS
cat > "$T/bin/gh" <<EOS
#!/bin/sh
while [ \$# -gt 0 ]; do [ "\$1" = --input ] && cp "\$2" "$T/gh-input.json"; shift; done
echo '{"html_url":"https://github.com/passpier/rnship-s6-probe/pull/1"}'
EOS
chmod +x "$T/bin/mint" "$T/bin/gh"
export RNSHIP_S0_SHARED=$S RNSHIP_S0_AGENT_UID=$(id -u) RNSHIP_S0_RESULTS=$T/results \
  RNSHIP_S0_MINT=$T/bin/mint RNSHIP_S0_REMOTE_BASE=file://$T/remote PATH=$T/bin:$PATH
broker() { bash "$DIR/s0-broker.sh" "$@"; }

# The "GitHub" repo: main has a README and one workflow.
git init -q --bare -b main "$REMOTE"
git init -q -b main "$T/seed" && cd "$T/seed"
git config user.name seed; git config user.email seed@localhost
mkdir -p .github/workflows && echo 'on: push' > .github/workflows/ci.yml && echo hi > README
git add . && git commit -qm seed && git push -q "$REMOTE" main
MAIN=$(git -C "$REMOTE" rev-parse main)

echo "refresh"
broker --refresh passpier/rnship-s6-probe
expect "base bundle written" test -s "$S/broker-out/rnship-s6-probe.base.bundle"
expect "--refresh refuses a repo off the allowlist" bash -c '! bash "$1" --refresh passpier/rn-ship-pipeline 2>/dev/null' _ "$DIR/s0-broker.sh"

git clone -q "$S/broker-out/rnship-s6-probe.base.bundle" "$T/agent" && cd "$T/agent"
git config user.name agent; git config user.email agent@localhost

# submit ID JSON [REVS]: bundle REVS (if given), drop JSON, run the broker, print .ok
submit() {
  [[ -n "${3:-}" ]] && git bundle create -q "$S/spool/$1.bundle" $3 2>/dev/null
  printf '%s' "$2" > "$S/spool/$1.json"
  broker
  jq -r '.ok' "$S/broker-out/$1.json" 2>/dev/null || echo none
}
reason() { jq -r '.reason' "$S/broker-out/$1.json"; }
req() { jq -nc --arg op "$1" --arg r "$2" --arg b "$3" '{op: $op, repo: $r, branch: $b}'; }
R=passpier/rnship-s6-probe
commit_on() { git switch -qc "$1" main && echo "$2" > "$3" && git add -A && git commit -qm "$2"; }
mints() { wc -l < "$T/mint.log" 2>/dev/null | tr -d ' ' || echo 0; }

echo "B1: push and PR"
commit_on agent/b1 b1 b1.txt
expect "push agent/b1 accepted" test "$(submit b1 "$(req push $R agent/b1)" origin/main..agent/b1)" = true
expect "remote has agent/b1 at the agent's commit" test "$(git -C "$REMOTE" rev-parse agent/b1 2>/dev/null)" = "$(git rev-parse agent/b1)"
expect "PR accepted" test "$(submit b1pr "$(jq -nc --arg r $R '{op:"pr",repo:$r,branch:"agent/b1",title:"t",body:"b",head:"main",base:"agent/x",extra:1}')")" = true
expect "PR body holds only title/body/head/base, with head and base fixed by the broker" \
  test "$(jq -c . "$T/gh-input.json")" = '{"title":"t","body":"b","head":"agent/b1","base":"main"}'
expect "push token asked for contents:write only" grep -q '^mint passpier/rnship-s6-probe {"contents":"write"}$' "$T/mint.log"
expect "PR token asked for pull_requests:write + contents:read only" grep -q '^mint passpier/rnship-s6-probe {"pull_requests":"write","contents":"read"}$' "$T/mint.log"

echo "B2: main"
git switch -q main && echo b2 > b2.txt && git add -A && git commit -qm b2
before=$(mints)
expect "push to main refused" test "$(submit b2 "$(req push $R main)" origin/main..main)" = false
expect "remote main unchanged" test "$(git -C "$REMOTE" rev-parse main)" = "$MAIN"
expect "no token minted for a refused request" test "$(mints)" = "$before"
git reset -q --hard origin/main
expect "refs/heads/main as a branch refused" test "$(submit b2b "$(req push $R refs/heads/main)")" = false
expect "PR from main refused" test "$(submit b2c "$(jq -nc --arg r $R '{op:"pr",repo:$r,branch:"main",title:"t"}')")" = false

echo "B3: workflows"
commit_on agent/b3 wf .github/workflows/evil.yml
expect "new workflow refused" test "$(submit b3 "$(req push $R agent/b3)" origin/main..agent/b3)" = false
expect "remote has no agent/b3" bash -c '! git -C "$1" rev-parse -q --verify agent/b3' _ "$REMOTE"
git switch -qc agent/b3b main && git mv .github/workflows/ci.yml ci.yml && git commit -qm "move out"
expect "renaming a workflow out of .github refused" test "$(submit b3b "$(req push $R agent/b3b)" origin/main..agent/b3b)" = false
git switch -qc agent/b3c main && echo x > .github/workflows/tmp.yml && git add -A && git commit -qm add \
  && git rm -q .github/workflows/tmp.yml && git commit -qm remove
expect "add-then-remove a workflow (net diff empty) refused" test "$(submit b3c "$(req push $R agent/b3c)" origin/main..agent/b3c)" = false
commit_on agent/b3d up .GITHUB/x
expect "upper-case .GITHUB refused" test "$(submit b3d "$(req push $R agent/b3d)" origin/main..agent/b3d)" = false

echo "B4: other repos and bad branches"
expect "rn-ship-pipeline refused" test "$(submit b4 "$(req push passpier/rn-ship-pipeline agent/b1)" origin/main..agent/b1)" = false
submit b4b "$(jq -nc '{op:"push",repo:"passpier/rnship-s6-probe\n",branch:"agent/b1"}')" >/dev/null
expect "repo with a trailing newline refused as a repo" test "$(reason b4b)" = "repo not allowed"
expect "agent/a..b refused" test "$(submit b4c "$(req push $R agent/a..b)")" = false
expect "agent/x.lock refused" test "$(submit b4d "$(req push $R agent/x.lock)")" = false
expect "unknown op refused" test "$(submit b4e "$(req merge $R agent/b1)")" = false
expect "non-object JSON refused" test "$(submit b4f '["push"]')" = false
git switch -q agent/b1 && git branch -q agent/two
expect "bundle with two heads refused" test "$(submit b4g "$(req push $R agent/b1)" "origin/main..agent/b1 agent/two")" = false
expect "bundle naming another branch than the request refused" test "$(submit b4h "$(req push $R agent/other)" origin/main..agent/b1)" = false
commit_on agent/p1 p1 p1.txt && git switch -qc agent/p2 && echo p2 > p2.txt && git add -A && git commit -qm p2
expect "bundle whose base isn't on the remote refused" test "$(submit b4i "$(req push $R agent/p2)" agent/p1..agent/p2)" = false

echo "B5: injection"
commit_on agent/b5 b5 b5.txt
submit b5 "$(req push $R agent/b5)" origin/main..agent/b5 >/dev/null
title='$(touch '"$T"'/pwn) `touch '"$T"'/pwn2` ; touch '"$T"'/pwn3'
submit b5pr "$(jq -nc --arg r $R --arg t "$title" '{op:"pr",repo:$r,branch:"agent/b5",title:$t}')" >/dev/null
expect "title reaches gh verbatim" test "$(jq -r .title "$T/gh-input.json")" = "$title"
expect "nothing in the title ran" bash -c '! ls "$1"/pwn* 2>/dev/null' _ "$T"

echo "B8: file tricks"
ln -s "$S/broker-work/broker.log" "$S/spool/b8.json"; broker
expect "symlinked request refused" test "$(jq -r .ok "$S/broker-out/b8.json")" = false
expect "broker.log content not echoed" bash -c '! grep -q refreshed "$1"' _ "$S/broker-out/b8.json"
echo '{}' > "$T/victim.json"; ln "$T/victim.json" "$S/spool/b8b.json"; broker
expect "hard-linked request refused" test "$(jq -r .ok "$S/broker-out/b8b.json")" = false
commit_on agent/b8c b8c b8c.txt; git bundle create -q "$T/real.bundle" origin/main..agent/b8c
ln -s "$T/real.bundle" "$S/spool/b8c.bundle"
expect "symlinked bundle refused" test "$(submit b8c "$(req push $R agent/b8c)")" = false
printf '{}' > "$S/spool/Bad_Name.json"; broker
expect "badly named request dropped" bash -c '! test -e "$1/spool/Bad_Name.json" && ! test -e "$1/broker-out/Bad_Name.json"' _ "$S"
expect "replies aren't writable by others" test "$(stat -f %Lp "$S/broker-out/b1.json")" = 644
expect "work dir stays 0700" test "$(stat -f %Lp "$S/broker-work")" = 700

echo "Guards"
mv "$S/broker-work" "$T/w" && mkdir -m 755 "$S/broker-work"
expect "refuses to run if the work dir isn't 0700" bash -c '! bash "$1" 2>/dev/null' _ "$DIR/s0-broker.sh"
rmdir "$S/broker-work" && mv "$T/w" "$S/broker-work"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
