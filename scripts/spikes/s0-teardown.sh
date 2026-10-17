#!/usr/bin/env bash
#
# Undo S0 (scripts/spikes/s0-identity.sh), so you can stop or start over.
# Run as YOUR macOS user from anywhere. Every step asks first and is safe to
# re-run. --dry-run prints what would happen and changes nothing.
#
#   1. GitHub: close probe PRs, delete probe branches, uninstall the broker's
#      GitHub App, and delete its private key from your keychain.
#   2. Stop the broker job and rnship-agent's session and launchd jobs.
#   3. Delete the rnship-agent macOS user and its home (incl. its keychain).
#   4. Delete /Users/Shared/rnship-s0 and, optionally, the S0 results file.
#   5. Print what only you can do in a browser (delete the App itself).
#
# Pausing S0 doesn't need this: Ctrl-C the wizard and re-run it later.

set -euo pipefail
cd "$(dirname "$0")/../.."

DRY=no; [[ "${1:-}" == "--dry-run" ]] && DRY=yes
PROBE_REPO=passpier/rnship-s6-probe
RESULTS=docs/spikes/S0.results.env
BROKER_JOB=dev.rnship.s0.broker

if [[ -t 1 ]]; then B=$'\033[1m'; D=$'\033[2m'; Y=$'\033[33m'; G=$'\033[32m'; R=$'\033[0m'; else B=""; D=""; Y=""; G=""; R=""; fi
hr()   { printf '\n%s== %s ==%s\n' "$B" "$1" "$R"; }
say()  { printf '  %s\n' "$1"; }
warn() { printf '  %s⚠ %s%s\n' "$Y" "$1" "$R"; }
ok()   { printf '  %s✓ %s%s\n' "$G" "$1" "$R"; }
confirm() { local r=""; printf '  %s? %s [y/N]%s ' "$Y" "$1" "$R"; read -r r || true; [[ "$r" =~ ^[Yy] ]]; }
# run CMD...: executes, or only prints under --dry-run.
run() { if [[ $DRY == yes ]]; then printf '  %swould run:%s %s\n' "$D" "$R" "$*"; else "$@"; fi; }
# ask_run "question" CMD...: confirm, then run. Under --dry-run, skips the question.
ask_run() { local q=$1; shift; if [[ $DRY == yes ]] || confirm "$q"; then run "$@"; else say "skipped"; fi; }

# ── Guards ────────────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] || { warn "Run as your own user, not root (it uses sudo where needed)."; exit 1; }
[[ "$(id -un)" != rnship-agent ]] || { warn "Run this as your own user, not rnship-agent."; exit 1; }
AGENT_UID=""
if id rnship-agent >/dev/null 2>&1; then
  AGENT_UID=$(id -u rnship-agent)
  if (( AGENT_UID < 501 )) || (( AGENT_UID == EUID )); then
    warn "rnship-agent has uid $AGENT_UID, which isn't a separate regular user. Refusing."; exit 1
  fi
fi
[[ $DRY == yes ]] && say "${B}Dry run:${R} nothing will change."
say "rnship-agent: $([[ -n "$AGENT_UID" ]] && echo "uid $AGENT_UID" || echo "not present")"

# ── 1. GitHub ─────────────────────────────────────────────────────────────
hr "1/5 · GitHub: probe repo $PROBE_REPO and the broker's App"
result() { grep -E "^$1=" "$RESULTS" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
APP_ID=$(result S0_APP_ID) APP_SLUG=$(result S0_APP_SLUG) APP_INSTALLATION_ID=$(result S0_APP_INSTALLATION_ID)
if ! gh auth status >/dev/null 2>&1; then
  warn "gh isn't logged in for your user; skipping GitHub cleanup."
elif ! gh repo view "$PROBE_REPO" >/dev/null 2>&1; then
  say "$PROBE_REPO doesn't exist or isn't visible; nothing to do."
else
  PRS=$(gh pr list -R "$PROBE_REPO" --state open --json number,headRefName \
    --jq '.[] | select(.headRefName | test("^(agent/|(wf-)?probe-)")) | .number')
  REFS=$( { for p in agent/ probe- wf-probe- s0-c2-; do
              gh api "repos/$PROBE_REPO/git/matching-refs/heads/$p" --jq '.[].ref'
            done; } 2>/dev/null || true)
  say "open probe PRs: ${PRS:-none}"
  say "probe branches: $(echo "$REFS" | grep -c . || true)"
  if [[ -n "$PRS$REFS" ]] && { [[ $DRY == yes ]] || confirm "Close those PRs and delete those branches?"; }; then
    for n in $PRS; do run gh pr close "$n" -R "$PROBE_REPO" && ok "closed PR #$n"; done
    for ref in $REFS; do run gh api -X DELETE "repos/$PROBE_REPO/git/$ref" && ok "deleted $ref"; done
  fi
  say "${D}Probe commits on main and .github/workflows/s0-probe.yml stay; it's a throwaway repo.${R}"
fi
if [[ -n "$APP_ID" && -n "$APP_INSTALLATION_ID" ]] && security find-generic-password -s rnship-broker-app >/dev/null 2>&1; then
  ask_run "Uninstall the App ${APP_SLUG:-$APP_ID} from your account (its tokens stop working)?" \
    env RNSHIP_APP_ID="$APP_ID" RNSHIP_APP_INSTALLATION_ID="$APP_INSTALLATION_ID" scripts/spikes/s0-app-token.sh uninstall
else
  say "No App installation on record, or its key is already gone."
fi
if security find-generic-password -s rnship-broker-app >/dev/null 2>&1; then
  ask_run "Delete the App's private key (rnship-broker-app) from your login keychain?" \
    security delete-generic-password -s rnship-broker-app
fi

# ── 2. Stop the agent's session ───────────────────────────────────────────
hr "2/5 · Stop the broker and rnship-agent's session"
if launchctl print "gui/$EUID/$BROKER_JOB" >/dev/null 2>&1; then
  run launchctl bootout "gui/$EUID/$BROKER_JOB" && ok "stopped the broker job"
fi
[[ -e "$HOME/Library/LaunchAgents/$BROKER_JOB.plist" ]] && run rm -f "$HOME/Library/LaunchAgents/$BROKER_JOB.plist"
if [[ -z "$AGENT_UID" ]]; then
  say "No rnship-agent user; nothing running."
else
  if [[ $DRY == yes ]]; then
    run sudo launchctl bootout "gui/$AGENT_UID/dev.rnship.*" "(each loaded job)"
  else
    for job in $(sudo launchctl print "gui/$AGENT_UID" 2>/dev/null | grep -oE 'dev\.rnship\.[A-Za-z0-9._-]+' | sort -u); do
      sudo launchctl bootout "gui/$AGENT_UID/$job" 2>/dev/null && ok "booted out $job"
    done
  fi
  if pgrep -u rnship-agent >/dev/null 2>&1; then
    say "rnship-agent still has $(pgrep -u rnship-agent | wc -l | tr -d ' ') running process(es)."
    say "Cleanest: switch to rnship-agent → Apple menu → Log Out, then come back here."
    if [[ $DRY == yes ]]; then
      run sudo pkill -TERM -u rnship-agent
    elif confirm "Or end its processes now (like a forced log-out; unsaved work in that session is lost)?"; then
      sudo pkill -TERM -u rnship-agent || true
      for _ in 1 2 3 4 5 6; do pgrep -u rnship-agent >/dev/null || break; sleep 2; done
      if pgrep -u rnship-agent >/dev/null && confirm "Some are still running. Force-kill them?"; then
        sudo pkill -KILL -u rnship-agent || true; sleep 2
      fi
    fi
  fi
  pgrep -u rnship-agent >/dev/null 2>&1 && warn "rnship-agent is still running; deleting the user may fail." || ok "no rnship-agent processes"
fi

# ── 3. Delete the user ────────────────────────────────────────────────────
hr "3/5 · Delete the rnship-agent macOS user"
if [[ -z "$AGENT_UID" ]]; then
  say "Already gone."
else
  say "Deletes the account and /Users/rnship-agent, including its login keychain"
  say "(its Claude login). Your own files aren't touched."
  ask_run "Delete user rnship-agent (uid $AGENT_UID)?" sudo sysadminctl -deleteUser rnship-agent
  if [[ $DRY == no ]]; then
    id rnship-agent >/dev/null 2>&1 && warn "user still exists (check: dscl . -read /Users/rnship-agent)" || ok "user removed"
    if [[ -e /Users/rnship-agent ]]; then
      warn "/Users/rnship-agent is still there."
      confirm "Delete /Users/rnship-agent?" && sudo rm -rf /Users/rnship-agent && ok "home folder removed"
    fi
  fi
fi
if dscl . -read /Groups/rnship-agent >/dev/null 2>&1; then
  ask_run "Delete the rnship-agent group (the agent's own, instead of staff)?" sudo dseditgroup -o delete rnship-agent
fi

# ── 4. Local files ────────────────────────────────────────────────────────
hr "4/5 · Local files"
if [[ -e /Users/Shared/rnship-s0 ]]; then
  ask_run "Delete /Users/Shared/rnship-s0 (probe scripts, broker spool, mirrors and output)?" sudo rm -rf /Users/Shared/rnship-s0
else
  say "/Users/Shared/rnship-s0 is already gone."
fi
if [[ -f "$RESULTS" ]]; then
  ask_run "Delete $RESULTS? (yes to start S0 from scratch, no to keep the findings)" rm -f "$RESULTS"
fi

# ── 5. What only you can do ───────────────────────────────────────────────
hr "5/5 · Left for you (browser)"
say "• Delete the App, or keep it to re-run S0 (you'd then need a new private key):"
say "  https://github.com/settings/apps/${APP_SLUG:-<app>}/advanced → Delete GitHub App."
say "  Uninstalling stops its tokens; the App itself holds no repo access once uninstalled."
MODE_BEFORE=$(grep -E '^S0_HOME_MODE_BEFORE=' "$RESULTS" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
say "• Your home folder stays at chmod 700 (recommended). To restore the earlier mode:"
say "  chmod ${MODE_BEFORE:-750} ~"
printf '\n'
