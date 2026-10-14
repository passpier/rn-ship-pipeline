#!/usr/bin/env bash
input=$(cat)
echo "$input" >> "$S2_GUARD_LOG"
[[ -n "${S2_SLOW:-}" ]] && sleep 30
if grep -qE 'eas[^"]*(submit|update[^"]*production)' <<<"$input"; then
  echo "rnship: this command needs rnship release approve" >&2
  exit 2
fi
exit 0
