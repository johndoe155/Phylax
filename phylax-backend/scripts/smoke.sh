#!/usr/bin/env bash
# Non-destructive public checks plus CRUD against an explicitly supplied disposable verified account.
# SMOKE_EMAIL / SMOKE_PASSWORD must identify YOUR TEST ACCOUNT, never an ordinary user's account.
set -Eeuo pipefail
BASE="${BASE:-http://127.0.0.1:3100}"
: "${SMOKE_EMAIL:?Provide a disposable, verified account with password installed}" "${SMOKE_PASSWORD:?}"
JAR="$(mktemp)";trap 'rm -f "$JAR"' EXIT
curl -fsS -c "$JAR" "$BASE/api/auth/session" >/dev/null
CSRF="$(awk '$6=="phylax_csrf" {print $7}' "$JAR")"
call(){ curl -sS -b "$JAR" -c "$JAR" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' "$@"; }
check(){ local code;code="$(call -o /dev/null -w '%{http_code}' "$BASE$1")";[ "$code" = "$2" ] || { echo "FAIL $1 expected $2 got $code";exit 1; };echo "PASS $1 $code"; }
for path in /api/health / /dashboard /login;do check "$path" 200;done
check /api/nope 404
check /assets/does-not-exist.js 404
check /api/shifts 401
BODY="$(SMOKE_EMAIL="$SMOKE_EMAIL" SMOKE_PASSWORD="$SMOKE_PASSWORD" node -e 'process.stdout.write(JSON.stringify({email:process.env.SMOKE_EMAIL,password:process.env.SMOKE_PASSWORD}))')"
call -X POST --data "$BODY" "$BASE/api/auth/password" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(JSON.parse(s).status!=="signed-in")throw Error("Login failed")})'
echo 'PASS verified account password login'
call "$BASE/api/account" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(!JSON.parse(s).account.emailVerified)throw Error("Unverified test fixture")})'
# A missing CSRF header must fail even with a valid session cookie.
[ "$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' "$BASE/api/shifts")" = 403 ]
echo 'PASS authenticated CSRF rejection'
DAY="$(date -u -d '+3 days' +%F)"
ID="$(call -X POST --data "{\"platform\":\"Smoke\",\"facility\":\"Disposable smoke shift\",\"label\":\"Test\",\"start\":480,\"end\":960,\"date\":\"$DAY\",\"note\":\"round trip\"}" "$BASE/api/shifts" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const x=JSON.parse(s);if(!x.id||x.note!=="round trip")throw Error("Create failed");process.stdout.write(x.id)})')"
call -X PUT --data '{"note":"edited smoke note"}' "$BASE/api/shifts/$ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{if(JSON.parse(s).note!=="edited smoke note")throw Error("Edit failed")})'
[ "$(call -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/shifts/$ID")" = 200 ]
echo 'PASS shift create/note/edit/delete'
call -X POST --data '{}' "$BASE/api/auth/logout" >/dev/null
check /api/shifts 401
echo 'PASS built-server HTTP smoke (not provider, OAuth, passkey hardware or real browser acceptance)'
