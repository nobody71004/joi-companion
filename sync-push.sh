#!/usr/bin/env bash
# ============================================================
#  JOI — sync & push
#  Rebuilds the EXE, syncs the project into the public repo
#  (joi-companion-clean), commits and pushes to GitHub.
#
#  Usage:
#    ./sync-push.sh                 # default commit message
#    ./sync-push.sh "message text"  # custom commit message
#
#  NEVER copies data/ (her second brain stays private).
# ============================================================
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$SRC/../joi-companion-clean"
BRANCH="main"
REPO="nobody71004/joi-companion"

echo ""
echo "  ✦  JOI sync & push"
echo "  ─────────────────────────────────────"
echo "  source : $SRC"
echo "  target : $DST"

# ---- 0. sanity: both folders exist -------------------------
if [ ! -d "$DST" ] || [ ! -d "$DST/.git" ]; then
  echo "  ✖ clean repo missing at $DST"
  echo "    clone it first: gh repo clone $REPO $DST"
  exit 1
fi

# ---- 1. syntax-check every JS file we ship -----------------
echo "  · syntax-checking…"
(cd "$SRC" && for f in server.js electron/main.js electron/preload.js public/js/*.js; do
  node --check "$f" || { echo "  ✖ syntax error in $f"; exit 1; }
done)
echo "    ✓ all JS clean"

# ---- 2. rebuild the EXE with the latest code ---------------
# If JOI is running, its EXE file is locked and can't be overwritten —
# close the app first (your chat + brain are safe on the server).
if tasklist 2>/dev/null | grep -qiE 'JOI[- ]Companion'; then
  echo "  · closing the running JOI app (needed to overwrite the EXE)…"
  taskkill //IM "JOI-Companion.exe" //F >/dev/null 2>&1 || true
  taskkill //IM "JOI Companion.exe" //F >/dev/null 2>&1 || true
  sleep 2
fi
echo "  · rebuilding EXE (this takes a few minutes)…"
(cd "$SRC" && rm -f dist/JOI-Companion.exe && npx electron-builder --win portable 2>&1 | tail -3)
if [ ! -f "$SRC/dist/JOI-Companion.exe" ]; then
  echo "  ✖ EXE build failed — aborting"
  exit 1
fi
EXE_MB=$(du -m "$SRC/dist/JOI-Companion.exe" | awk '{print $1}')
echo "    ✓ EXE rebuilt ($EXE_MB MB)"

# ---- 3. sync source into the clean repo (no data/, venv, modules)
echo "  · syncing source…"
cp "$SRC/server.js" "$SRC/package.json" "$SRC/Start-JOI.bat" "$SRC/Stop-JOI.bat" "$DST/"
cp -r "$SRC/electron/." "$DST/electron/"
cp -r "$SRC/public/." "$DST/public/"
mkdir -p "$DST/build"
cp "$SRC/build/icon.ico" "$SRC/build/make_icon.py" "$DST/build/"
cp "$SRC/dist/JOI-Companion.exe" "$DST/dist/"
cp "$SRC/sync-push.sh" "$SRC/sync-push.bat" "$DST/" 2>/dev/null || true
echo "    ✓ synced (brain data/ deliberately excluded)"

# ---- 4. commit + push --------------------------------------
cd "$DST"
if [ -z "$(git status --porcelain)" ]; then
  echo "  · nothing changed since the last push — skipping commit"
  echo "  ✓ up to date ($(git log --oneline -1))"
  exit 0
fi

MSG="${1:-JOI update — rebuilt EXE + latest app}"
echo "  · committing: $MSG"
git add -A
git -c user.name=Matthew -c user.email=mattb@example.com commit -m "$MSG" >/dev/null 2>&1

echo "  · pushing to $REPO…"
if git push origin "$BRANCH" 2>&1 | tail -2; then
  SHA=$(git log --oneline -1 | awk '{print $1}')
  echo ""
  echo "  ✓ pushed — $SHA"
  echo "    https://github.com/$REPO"
else
  echo "  ✖ push failed — commit exists locally: $(git log --oneline -1)"
  exit 1
fi
