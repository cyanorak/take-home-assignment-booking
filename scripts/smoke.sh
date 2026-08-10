#!/usr/bin/env bash
#
# Smoke test against a RUNNING server (`npm run dev` in another terminal).
#
# Why this exists: the integration suite drives the Hono app via app.request(),
# which bypasses Nitro entirely. During V1 that let 12 green tests coexist with
# a server that returned 500 to every request, because nitro.config.ts had the
# wrong handler format. The test suite structurally cannot catch that class of
# bug. This script can, and it doubles as the curl walkthrough the brief asks
# for.
#
# Usage:  ./scripts/smoke.sh [base-url]
set -uo pipefail

BASE="${1:-http://localhost:3000}"
RUN_ID="smoke-$(date +%s)-$RANDOM"
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n         %s\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }

check() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}

# Emits the response body followed by a final line holding the status code.
# The caller splits it; a `STATUS=` assignment inside here would happen in the
# command-substitution subshell and never reach the caller.
book() { # idempotency-key offer amount
  curl -s -w '\n%{http_code}' -X POST "$BASE/bookings" \
    -H 'content-type: application/json' \
    -H "Idempotency-Key: $1" \
    -d "{\"offerId\":\"$2\",\"amountCents\":$3,\"currency\":\"GBP\"}"
}

send() { # idempotency-key offer amount -> sets BODY and STATUS in the caller
  local raw
  raw=$(book "$@")
  STATUS=$(printf '%s' "$raw" | tail -n1)
  BODY=$(printf '%s' "$raw" | sed '$d')
}

jget() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=process.argv[1].split(".");let v=j;for(const k of p)v=v?.[k];console.log(v??"")}catch{console.log("")}})' "$2"; }

echo "Smoke testing $BASE"
echo

# --- health ------------------------------------------------------------------
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health" || echo 000)
if [ "$STATUS" != "200" ]; then
  echo "  Server not reachable at $BASE (status $STATUS). Start it with: npm run dev"
  exit 1
fi
pass "GET /health"

# --- happy path --------------------------------------------------------------
send "$RUN_ID-happy" "offer-$RUN_ID" 12500
check "POST /bookings returns 201" "201" "$STATUS"
check "state is confirmed" "confirmed" "$(jget "$BODY" state)"
check "requiresIntervention is false" "false" "$(jget "$BODY" requiresIntervention)"
FIRST_ID=$(jget "$BODY" bookingId)
[ -n "$FIRST_ID" ] && pass "bookingId returned ($FIRST_ID)" || fail "bookingId returned" "empty"
[ -n "$(jget "$BODY" chargeId)" ] && pass "chargeId returned" || fail "chargeId returned" "empty"

# --- replay ------------------------------------------------------------------
send "$RUN_ID-happy" "offer-$RUN_ID" 12500
check "replay returns 201" "201" "$STATUS"
check "replay returns the SAME bookingId" "$FIRST_ID" "$(jget "$BODY" bookingId)"

# --- fingerprint conflict ----------------------------------------------------
send "$RUN_ID-happy" "offer-$RUN_ID" 99900
check "same key + different body returns 409" "409" "$STATUS"
check "error code is idempotency_key_reuse" "idempotency_key_reuse" "$(jget "$BODY" error.code)"

# --- request contract --------------------------------------------------------
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/bookings" \
  -H 'content-type: application/json' \
  -d '{"offerId":"o","amountCents":100,"currency":"GBP"}')
check "missing Idempotency-Key returns 400" "400" "$STATUS"

send "$RUN_ID-bad" "offer-$RUN_ID-bad" 0
check "amountCents=0 returns 400" "400" "$STATUS"
check "error code is invalid_amount" "invalid_amount" "$(jget "$BODY" error.code)"

# --- concurrency over real HTTP ---------------------------------------------
KEY="$RUN_ID-concurrent"
OFFER="offer-$RUN_ID-concurrent"
for i in 1 2 3 4; do
  curl -s -X POST "$BASE/bookings" \
    -H 'content-type: application/json' -H "Idempotency-Key: $KEY" \
    -d "{\"offerId\":\"$OFFER\",\"amountCents\":4200,\"currency\":\"GBP\"}" \
    > "/tmp/smoke-$RUN_ID-$i.json" &
done
wait
UNIQUE=$(cat /tmp/smoke-"$RUN_ID"-*.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const ids=[...s.matchAll(/"bookingId":"([^"]+)"/g)].map(m=>m[1]);console.log(new Set(ids).size)})')
rm -f /tmp/smoke-"$RUN_ID"-*.json
check "4 concurrent requests yield ONE bookingId" "1" "$UNIQUE"

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mAll smoke checks passed.\033[0m\n'
else
  printf '\033[31m%s smoke check(s) failed.\033[0m\n' "$FAILURES"
fi
exit "$FAILURES"
