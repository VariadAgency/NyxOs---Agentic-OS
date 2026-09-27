#!/usr/bin/env bash
# Checks a fresh installation end to end without a browser: server and bridge run, the one-time
# sign-in link works, and the onboarding can be completed through the same API the web app uses.
set -euo pipefail
NYXOS_HOME="${NYXOS_HOME:-$HOME/.nyxos}"
NYXOS="$NYXOS_HOME/bin/nyxos"
NODE="$NYXOS_HOME/runtime/node/bin/node"
PORT="$("$NODE" -e 'try{console.log(require(process.argv[1]).port)}catch{console.log(47800)}' "$NYXOS_HOME/nyxos.json" 2>/dev/null || echo 47800)"
BASE="http://127.0.0.1:$PORT"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT
fail() { echo "SMOKE FAIL: $*" >&2; "$NYXOS" logs | tail -n 60 >&2 || true; exit 1; }

echo "· nyxos status"; "$NYXOS" status || fail "status"
echo "· health"; curl -fsS "$BASE/health" >/dev/null || fail "health"
echo "· web app"; curl -fsS "$BASE/" | grep -q '<div id="root"' || fail "web app not served"

echo "· sign-in link"
URL="$(NYXOS_NO_BROWSER=1 "$NYXOS" open | grep -oE 'http://127\.0\.0\.1:[0-9]+/auth/local\?[^ ]+')" || fail "no sign-in link"
curl -fsS -c "$JAR" -o /dev/null "$URL" || fail "sign-in"
CSRF="$(curl -fsS -b "$JAR" "$BASE/api/auth/status" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.authenticated)process.exit(1);console.log(j.csrf)})')" || fail "not signed in"

echo "· onboarding"
curl -fsS -b "$JAR" "$BASE/api/setup" >/dev/null || fail "setup state"
curl -fsS -b "$JAR" -X PUT -H "content-type: application/json" -H "x-nyxos-csrf: $CSRF" \
  -d '{"userName":"Test","onboardingDone":true,"lang":"en"}' "$BASE/api/app/settings" >/dev/null || fail "finish onboarding"
curl -fsS "$BASE/api/app/info" | grep -q '"onboardingDone":true' || fail "onboarding not stored"

echo "· dashboard data"
for path in /api/sessions /api/entries /api/overview; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE$path")"
  [ "$code" = 200 ] || fail "$path → $code"
done
echo "SMOKE OK"
