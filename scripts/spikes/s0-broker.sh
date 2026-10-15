#!/usr/bin/env bash
#
# S0 broker prototype: rnship-agent's only route to GitHub. It runs as YOUR user
# (launchd WatchPaths on the spool) and holds the App key; the agent never holds a
# GitHub credential. It does two things, on two repos, and nothing else:
#
#   push  a git bundle to refs/heads/agent/*   {"op":"push","repo":R,"branch":B}
#                                              plus spool/ID.bundle
#   pr    open a PR from agent/* into main     {"op":"pr","repo":R,"branch":B,
#                                               "title":T,"body":S}
#
# There is no merge, no main, no workflow change, and no other repo. Every op mints
# its own 1-hour token, downscoped to one repo and the permissions it needs: push
# gets contents:write; pr gets pull_requests:write plus contents:read (GitHub must
# read the head ref: "not all refs are readable" otherwise), which can't merge.
#
# The agent writes spool/ID.bundle (push only), then spool/ID.json, and reads the
# reply from broker-out/ID.json. Requests are data: the broker moves each file into
# its own 0700 directory before looking at it, never follows a symlink, never runs
# git inside an agent-owned repo, and never passes request fields through a shell.
#
#   s0-broker.sh                 handle every pending request
#   s0-broker.sh --refresh REPO  write broker-out/NAME.base.bundle (main) for the agent

set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
SHARED=${RNSHIP_S0_SHARED:-/Users/Shared/rnship-s0}
SPOOL=$SHARED/spool       # you, 1733: the agent can drop files, not list or delete others
OUT=$SHARED/broker-out    # you, 0755: the agent reads replies, can't forge them
WORK=$SHARED/broker-work  # you, 0700: claimed requests, mirrors, log
AGENT_UID=${RNSHIP_S0_AGENT_UID:-$(id -u rnship-agent)}
RESULTS=${RNSHIP_S0_RESULTS:-$DIR/../../docs/spikes/S0.results.env}
MINT=${RNSHIP_S0_MINT:-$DIR/s0-app-token.sh}
REMOTE_BASE=${RNSHIP_S0_REMOTE_BASE:-https://github.com}
ALLOWED_REPOS="passpier/rnship-s6-probe passpier/Spirit-Ripple"
MAX_REQUEST=65536
MAX_BUNDLE=$((50 * 1024 * 1024))

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$WORK/broker.log"; }

# A directory the agent pre-created, or swapped for a symlink, would hand it our files.
for d in "$SPOOL" "$OUT" "$WORK"; do
  [[ -d "$d" && ! -L "$d" && "$(stat -f %u "$d")" == "$(id -u)" ]] \
    || { echo "broker: $d is missing or not yours; refusing to run" >&2; exit 1; }
done
[[ "$(stat -f %Lp "$WORK")" == 700 ]] || { echo "broker: $WORK must be 0700" >&2; exit 1; }

# Lock: launchd never runs the job twice at once, but --refresh can overlap it.
for _ in $(seq 60); do mkdir "$WORK/lock" 2>/dev/null && break; sleep 1; done
[[ -d "$WORK/lock" ]] || { echo "broker: $WORK/lock is stuck; remove it if no broker is running" >&2; exit 1; }
REQ=$(mktemp -d "$WORK/req.XXXXXX")
trap 'rm -rf "$REQ" 2>/dev/null; rmdir "$WORK/lock"' EXIT

app_id()           { grep -E '^S0_APP_ID=' "$RESULTS" | tail -n1 | cut -d= -f2-; }
app_installation() { grep -E '^S0_APP_INSTALLATION_ID=' "$RESULTS" | tail -n1 | cut -d= -f2-; }

# mint REPO PERMS_JSON sets T to a fresh token for REPO only.
mint() {
  T=$(RNSHIP_APP_ID=$(app_id) RNSHIP_APP_INSTALLATION_ID=$(app_installation) \
    "$MINT" mint "$1" "$2" | jq -r '.token // empty')
  [[ -n "$T" ]]
}

# git_t ARGS... is git with the token $T as an extra header. Your own credential
# helpers and global config are switched off, so nothing else can authenticate.
git_t() {
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  GIT_CONFIG_COUNT=2 \
  GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
  GIT_CONFIG_KEY_1="http.$REMOTE_BASE/.extraheader" \
  GIT_CONFIG_VALUE_1="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$T" | base64)" \
    git "$@"
}

# mirror REPO prints the path of our bare mirror of REPO, with main fetched.
# Callers test its status, which turns off set -e inside, so every step chains.
mirror() {
  local m="$WORK/mirror/${1#*/}.git"
  if [[ ! -d "$m" ]]; then
    mkdir -p "$WORK/mirror" && git init -q --bare -b main "$m" \
      && git -C "$m" remote add origin "$REMOTE_BASE/$1.git" || return 1
  fi
  git_t -C "$m" fetch -q origin +refs/heads/main:refs/heads/main 2>>"$WORK/broker.log" && printf '%s' "$m"
}

# owned_regular FILE MAX: a plain file, ours by rename but the agent's by uid,
# one link (no hard link to someone else's file), at most MAX bytes.
owned_regular() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  local uid links size
  read -r uid links size <<<"$(stat -f '%u %l %z' "$1")"
  [[ "$uid" == "$AGENT_UID" && "$links" == 1 && "$size" -le "$2" ]]
}

# respond ID OK REASON [EXTRA_JSON]: replies are built here, never echoed from input.
respond() {
  local extra=${4:-}
  [[ -n "$extra" ]] || extra='{}'
  jq -n --arg id "$1" --argjson ok "$2" --arg reason "$3" --argjson extra "$extra" \
    '{id: $id, ok: $ok, reason: $reason} + $extra' > "$OUT/.$1.tmp"
  chmod 644 "$OUT/.$1.tmp"
  mv "$OUT/.$1.tmp" "$OUT/$1.json"
  log "$1 ok=$2 $3"
}

allowed_repo() { local r; for r in $ALLOWED_REPOS; do [[ "$1" == "$r" ]] && return 0; done; return 1; }

allowed_branch() {
  [[ "$1" =~ ^agent/[a-z0-9._-]{1,64}$ ]] && git check-ref-format "refs/heads/$1"
}

# field FILE NAME prints a string field, or nothing if it's missing, not a string, or
# holds a control character ($(...) would strip a trailing newline and hide it).
field() { jq -r --arg k "$2" '.[$k] | strings | select(test("\\p{Cc}") | not)' "$1"; }

# do_push and do_pr run with set -e off (handle is called in a condition), so every
# step that matters is checked by hand, and every check fails closed.
do_push() {
  local id=$1 repo=$2 branch=$3 bundle="$REQ/$1.bundle" m heads tip paths
  owned_regular "$bundle" "$MAX_BUNDLE" || { respond "$id" false "missing bundle, or not a plain file the agent owns, or over 50 MB"; return; }
  mint "$repo" '{"contents":"write"}' || { respond "$id" false "couldn't mint a token"; return; }
  m=$(mirror "$repo") || { respond "$id" false "couldn't fetch main"; return; }
  git -C "$m" bundle verify -q "$bundle" >/dev/null 2>&1 \
    || { respond "$id" false "bundle doesn't apply on top of main"; return; }
  heads=$(git -C "$m" bundle list-heads "$bundle")
  [[ "$(printf '%s\n' "$heads" | wc -l | tr -d ' ')" == 1 && "${heads#* }" == "refs/heads/$branch" ]] \
    || { respond "$id" false "bundle must hold exactly refs/heads/$branch"; return; }
  git -C "$m" fetch -q "$bundle" "+refs/heads/$branch:refs/rnship/in/$id" 2>/dev/null \
    && tip=$(git -C "$m" rev-parse --verify -q "refs/rnship/in/$id^{commit}") \
    && [[ "$tip" =~ ^[0-9a-f]{40}$ ]] \
    || { respond "$id" false "couldn't read the bundle"; return; }
  # Workflows: any path under .github/ in any new commit (merges against each
  # parent) or in the net diff. -z, so no path is quoted past the check.
  paths=$( { git -C "$m" log -z -m --no-renames --format= --name-only "main..$tip" \
             && git -C "$m" diff -z --no-renames --name-only "main...$tip"; } | tr '\0' '\n') \
    || { git -C "$m" update-ref -d "refs/rnship/in/$id"; respond "$id" false "couldn't list changed paths"; return; }
  if grep -qi '^\.github/' <<<"$paths"; then
    git -C "$m" update-ref -d "refs/rnship/in/$id"
    respond "$id" false "changes under .github/ are not allowed"; return
  fi
  if git_t -C "$m" push -q origin "+$tip:refs/heads/$branch" 2>>"$WORK/broker.log"; then
    respond "$id" true "pushed" "$(jq -nc --arg sha "$tip" '{sha: $sha}')"
  else
    respond "$id" false "push rejected by GitHub"
  fi
  git -C "$m" update-ref -d "refs/rnship/in/$id"
}

do_pr() {
  local id=$1 repo=$2 branch=$3 req="$REQ/$1.json" body="$REQ/$1.pr.json" url
  jq -e '(.title | type == "string" and length > 0 and length <= 256)
         and ((.body // "") | type == "string" and length <= 60000)' "$req" >/dev/null 2>&1 \
    || { respond "$id" false "title must be 1-256 chars, body a string up to 60000"; return; }
  # Only these four fields reach GitHub; head and base are fixed here, not by the agent.
  jq --arg head "$branch" '{title, body: (.body // ""), head: $head, base: "main"}' "$req" > "$body" \
    || { respond "$id" false "couldn't build the PR"; return; }
  mint "$repo" '{"pull_requests":"write","contents":"read"}' || { respond "$id" false "couldn't mint a token"; return; }
  # GitHub's error body goes to our log only; the agent gets a fixed reason.
  if url=$(GH_TOKEN=$T gh api -X POST "repos/$repo/pulls" --input "$body" 2>>"$WORK/broker.log" \
      | tee -a "$WORK/broker.log" | jq -r '.html_url // empty') && [[ -n "$url" ]]; then
    respond "$id" true "PR opened" "$(jq -nc --arg u "$url" '{pr_url: $u}')"
  else
    respond "$id" false "GitHub refused the PR"
  fi
}

handle() {
  local id=$1 req op repo branch
  # Claim by rename into our 0700 dir first: rename moves a symlink, never its
  # target, and once inside, the agent can't swap the file under us.
  mv "$SPOOL/$id.json" "$REQ/$id.json" 2>/dev/null || return 0
  if [[ -e "$SPOOL/$id.bundle" || -L "$SPOOL/$id.bundle" ]]; then mv "$SPOOL/$id.bundle" "$REQ/$id.bundle"; fi
  req="$REQ/$id.json"
  owned_regular "$req" "$MAX_REQUEST" || { respond "$id" false "request is not a plain file the agent owns, or over 64 KB"; return; }
  jq -e 'type == "object"' "$req" >/dev/null 2>&1 || { respond "$id" false "request is not a JSON object"; return; }
  op=$(field "$req" op); repo=$(field "$req" repo); branch=$(field "$req" branch)
  allowed_repo "$repo" || { respond "$id" false "repo not allowed"; return; }
  allowed_branch "$branch" || { respond "$id" false "branch must match agent/[a-z0-9._-]{1,64}"; return; }
  case "$op" in
    push) do_push "$id" "$repo" "$branch" ;;
    pr)   do_pr "$id" "$repo" "$branch" ;;
    *)    respond "$id" false "unknown op" ;;
  esac
}

if [[ "${1:-}" == --refresh ]]; then
  repo=${2:?usage: --refresh REPO}
  allowed_repo "$repo" || { echo "broker: $repo is not allowed" >&2; exit 1; }
  mint "$repo" '{"contents":"read"}' || { echo "broker: couldn't mint a token" >&2; exit 1; }
  m=$(mirror "$repo")
  git -C "$m" bundle create -q "$OUT/.base.tmp" HEAD main 2>/dev/null
  chmod 644 "$OUT/.base.tmp" && mv "$OUT/.base.tmp" "$OUT/${repo#*/}.base.bundle"
  log "refreshed $repo"
  exit 0
fi

for f in "$SPOOL"/*.json; do
  [[ -e "$f" || -L "$f" ]] || continue
  id=$(basename "$f" .json)
  if [[ "$id" =~ ^[a-z0-9-]{1,40}$ ]]; then
    handle "$id" || respond "$id" false "internal error"
  else
    rm -f "$f"; log "dropped badly named request"
  fi
done
