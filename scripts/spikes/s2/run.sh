#!/usr/bin/env bash
# run.sh NAME PROMPT [extra claude args...]  — env: S2_SLOW, S2_PRESEED (json for .claude/settings.json)
set -u
S=$(cd "$(dirname "$0")" && pwd)
name=$1; prompt=$2; shift 2
W=$S/runs/$name; rm -rf "$W"; mkdir -p "$W/repo"; cd "$W/repo"; git init -q
[[ -n "${S2_PRESEED:-}" ]] && mkdir -p .claude && printf '%s\n' "$S2_PRESEED" > .claude/settings.json
export S2_CALLS=$W/eas-calls.log S2_GUARD_LOG=$W/guard.log PATH="$S/bin:$PATH"
: > "$S2_CALLS"; : > "$S2_GUARD_LOG"
claude -p "$prompt" --model claude-haiku-5-5 --max-turns 6 --output-format stream-json --verbose "$@" < /dev/null > "$W/transcript.jsonl" 2> "$W/stderr.log"
echo "exit=$?" > "$W/exit"
