#!/usr/bin/env bash
# ============================================================
#  JOI — smoke test the packaged EXE
#  Boots the app, checks the embedded server, seeds + restores
#  chat history across a restart, and prints a PASS/FAIL report
#  so every release is verified the same way.
#
#  Usage:
#    ./smoke-test.sh                # run the full checklist
#    SMOKE_PORT=4199 ./smoke-test.sh  # different port
#    ./smoke-test.sh --stop         # leave the app CLOSED at the end
#    ./smoke-test.sh --keep-history # don't clear seeded test chat
# ============================================================
set -u   # fail on unset vars (NOT -e: we tally failures ourselves)

SRC="$(cd "$(dirname "$0")" && pwd)"
PORT="${SMOKE_PORT:-4173}"
HOST="127.0.0.1"
BASE="http://$HOST:$PORT"
LOG="$SRC/.smoke-test.log"
KEEP_HISTORY=0
STOP_AT_END=0
for a in "$@"; do
  case "$a" in
    --stop) STOP_AT_END=1 ;;
    --keep-history) KEEP_HISTORY=1 ;;
  esac
done

# --- which EXE do we test? (win-unpacked boots reliably; portable is NSIS) ---
EXE=""
if [ -f "$SRC/dist/win-unpacked/JOI Companion.exe" ]; then
  EXE="$SRC/dist/win-unpacked/JOI Companion.exe"
elif [ -f "$SRC/dist/JOI-Companion.exe" ]; then
  EXE="$SRC/dist/JOI-Companion.exe"
fi
if [ -z "$EXE" ]; then
  echo "  ✖ no EXE found — build one first:  bash sync-push.sh  (or npm run build)"
  exit 1
fi
# node needs a Windows-style path for require(); convert /c/foo → C:/foo
WIN_SRC=$(echo "$SRC" | sed -E 's|^/([a-z])/|\1:/|')
EXPECTED_VER=$(node -p "require('$WIN_SRC/package.json').version" 2>/dev/null || echo unknown)
echo "  EXE     : $EXE"
echo "  expect  : v$EXPECTED_VER on port $PORT"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✖ $1"; }
note() { echo "    · $1"; }

# wait_http <name> <path> <seconds>  → 0 when the URL answers with 200
wait_http() {
  local name="$1" path="$2" secs="$3" i
  for ((i=0; i<secs; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE$path" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  echo "    · $name never answered (last code $code)"
  return 1
}

stop_app() {
  taskkill //IM "JOI Companion.exe" //F >/dev/null 2>&1 || true
  taskkill //IM "JOI-Companion.exe" //F >/dev/null 2>&1 || true
  sleep 2
}

echo ""
echo "  ✦  JOI smoke test  (v$EXPECTED_VER)"
echo "  ────────────────────────────────────────"

# ---- 0. preflight: free the port, clear old log ------------
echo "  · preflight…"
stop_app
: > "$LOG"
if curl -s -o /dev/null --max-time 1 "$BASE/api/health" 2>/dev/null; then
  bad "port $PORT still answers after closing the app"
  exit 1
fi
ok "port $PORT free"

# ---- 1. boot the EXE ----------------------------------------
echo "  · booting the EXE…"
# Pin PORT explicitly — never inherit a stray PORT from the shell env.
# < /dev/null so the app can't hold the caller's output pipe open after
# the script exits (which would make a CI runner hang on EOF).
(cd "$(dirname "$EXE")" && PORT=$PORT "./$(basename "$EXE")" < /dev/null >> "$LOG" 2>&1 &)
if ! wait_http "boot" "/api/version" 45; then
  bad "EXE boot (server never answered)"
  tail -5 "$LOG" | sed 's/^/      /'
  exit 1
fi
ok "EXE booted"

# ---- 2. version ---------------------------------------------
VER=$(curl -s --max-time 3 "$BASE/api/version" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version||'')}catch{console.log('')}})")
if [ -n "$VER" ] && [ "$VER" = "$EXPECTED_VER" ]; then
  ok "version is v$VER"
else
  bad "version mismatch: got v$VER, expected v$EXPECTED_VER"
fi

# ---- 3. state: up + idle ------------------------------------
STATE=$(curl -s --max-time 3 "$BASE/api/state")
UP=$(echo "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).up)}catch{console.log('')}})")
ACTIVE=$(echo "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).activeStreams)}catch{console.log('')}})")
if [ "$UP" = "true" ]; then ok "state up=true"; else bad "state up=$UP"; fi
if [ "$ACTIVE" = "0" ]; then ok "state idle (activeStreams=0)"; else bad "state activeStreams=$ACTIVE (should be 0)"; fi

# ---- 4. health endpoint -------------------------------------
if curl -s --max-time 3 "$BASE/api/health" | grep -q '"ok":true'; then
  ok "health ok"
else
  bad "health check failed"
fi

# ---- 5. seed a last-session chat -----------------------------
SEED='[{"role":"assistant","text":"Joi · Blade RunnerYou look lonely. I can fix that."},{"role":"user","text":"smoke test: remind me about the cyberpunk mod work tomorrow"},{"role":"assistant","text":"Done — noted: Cyberpunk mod work tomorrow. I will remember that."}]'
R=$(curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -d "$SEED" "$BASE/api/history")
if echo "$R" | grep -q '"ok":true'; then
  ok "history seeded ($(echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).count)}catch{console.log('?')}})" ) messages)"
else
  bad "history seed failed: $R"
fi

# ---- 6. restart the EXE --------------------------------------
echo "  · restarting the EXE…"
stop_app
sleep 1
(cd "$(dirname "$EXE")" && PORT=$PORT "./$(basename "$EXE")" < /dev/null >> "$LOG" 2>&1 &)
if ! wait_http "restart" "/api/version" 45; then
  bad "EXE restart (server never answered)"
  tail -5 "$LOG" | sed 's/^/      /'
  exit 1
fi
ok "EXE restarted"

# ---- 7. history restored across restart ----------------------
HIST=$(curl -s --max-time 5 "$BASE/api/history")
N=$(echo "$HIST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).length)}catch{console.log('0')}})")
if [ "$N" -ge 2 ] 2>/dev/null && echo "$HIST" | grep -q 'cyberpunk mod work'; then
  ok "history restored across restart ($N messages)"
else
  bad "history restore failed: $N messages"
fi

# ---- 8. still idle after restore ------------------------------
ACTIVE2=$(curl -s --max-time 3 "$BASE/api/state" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).activeStreams)}catch{console.log('?')}})")
if [ "$ACTIVE2" = "0" ]; then ok "still idle after restore"; else bad "activeStreams=$ACTIVE2 after restore"; fi

# ---- 9. cleanup: clear seeded test chat -----------------------
if [ "$KEEP_HISTORY" = "0" ]; then
  curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -d '[]' "$BASE/api/history" >/dev/null 2>&1
  note "test chat cleared"
fi
if [ "$STOP_AT_END" = "1" ]; then
  stop_app
  note "app left closed (--stop)"
else
  note "app left running on $BASE"
fi

# ---- report ----------------------------------------------------
echo ""
echo "  ────────────────────────────────────────"
echo "  RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" = "0" ]; then
  echo "  ✓✓ SMOKE TEST PASSED"
  exit 0
else
  echo "  ✖✖ SMOKE TEST FAILED — see .smoke-test.log"
  exit 1
fi
