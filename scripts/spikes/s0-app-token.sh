#!/usr/bin/env bash
#
# GitHub App credentials for the S0 broker. Run as YOUR user, never as rnship-agent.
# The App's private key lives in your login keychain, base64 on one line, under the
# service rnship-broker-app. No secret goes on argv (other users' ps can read argv)
# or to disk: the key reaches openssl through a pipe, the JWT reaches curl through
# a config fd.
#
#   s0-app-token.sh app                    the App's slug, id and permissions (JWT auth)
#   s0-app-token.sh installation           the installation id on passpier
#   s0-app-token.sh mint REPO [PERMS_JSON] a 1-hour installation token, downscoped to
#                                          REPO ("-" for every installed repo) and,
#                                          if given, to PERMS_JSON; prints
#                                          {token, expires_at, permissions, repositories}
#   s0-app-token.sh uninstall              removes the installation (teardown)
#
# Needs RNSHIP_APP_ID; mint and uninstall also need RNSHIP_APP_INSTALLATION_ID.

set -euo pipefail

KC_SERVICE=rnship-broker-app
OWNER=passpier
API=https://api.github.com

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# jwt prints a 9-minute App JWT (GitHub caps it at 10).
jwt() {
  local now h p key
  : "${RNSHIP_APP_ID:?set RNSHIP_APP_ID}"
  key=$(security find-generic-password -s "$KC_SERVICE" -w 2>/dev/null) \
    || { echo "no $KC_SERVICE item in your login keychain" >&2; return 1; }
  now=$(date +%s)
  h=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  p=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$RNSHIP_APP_ID" | b64url)
  printf '%s.%s.%s' "$h" "$p" \
    "$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -sign <(printf '%s' "$key" | base64 -d) | b64url)"
}

# app_api METHOD PATH [BODY] calls the API as the App itself.
app_api() {
  local bearer
  bearer=$(jwt)
  curl -sS --fail-with-body -X "$1" "$API$2" \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$bearer") \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    ${3:+--data-binary "$3"}
}

case "${1:-}" in
  app)
    app_api GET /app | jq '{slug, id, permissions}'
    ;;
  installation)
    app_api GET "/users/$OWNER/installation" | jq -r .id
    ;;
  mint)
    : "${RNSHIP_APP_INSTALLATION_ID:?set RNSHIP_APP_INSTALLATION_ID}"
    repo=${2:?usage: mint REPO [PERMS_JSON]}
    body=$(jq -nc --arg r "${repo#*/}" --argjson p "${3:-null}" \
      '(if $r == "-" then {} else {repositories: [$r]} end) + (if $p then {permissions: $p} else {} end)')
    app_api POST "/app/installations/$RNSHIP_APP_INSTALLATION_ID/access_tokens" "$body" \
      | jq '{token, expires_at, permissions, repositories: [.repositories[]?.full_name]}'
    ;;
  uninstall)
    : "${RNSHIP_APP_INSTALLATION_ID:?set RNSHIP_APP_INSTALLATION_ID}"
    app_api DELETE "/app/installations/$RNSHIP_APP_INSTALLATION_ID" >/dev/null
    ;;
  *)
    sed -n '3,17p' "$0" >&2; exit 2
    ;;
esac
