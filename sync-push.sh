#!/usr/bin/env bash
# ============================================================
#  JOI — sync, push & release
#  Rebuilds the EXE, auto-bumps the version, syncs the project
#  into the public repo (joi-companion-clean), commits, pushes,
#  then creates a tagged GitHub Release with the EXE attached.
#
#  Usage:
#    ./sync-push.sh                       # patch bump (1.1.0 → 1.1.1)
#    ./sync-push.sh "message"             # custom commit message, patch bump
#    ./sync-push.sh "message" --minor     # minor bump (1.1.0 → 1.2.0)
#    ./sync-push.sh "message" --major     # major bump (1.1.0 → 2.0.0)
#    ./sync-push.sh "message" --version=1.5.0   # explicit version
#
#  NEVER copies data/ (her second brain stays private).
# ============================================================
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
DST="$SRC/../joi-companion-clean"
BRANCH="main"
REPO="nobody71004/joi-companion"

echo ""
echo "  ✦  JOI sync & push & release"
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

# ---- 2. soft-close check FIRST (before any state changes) --
# If JOI is running, its EXE file is locked and can't be overwritten —
# close the app before rebuilding. But NEVER force-kill her mid-reply:
# ask the embedded server, wait for the in-flight reply to finish, and
# abort with a warning if she's still talking (her chat is saved
# server-side in data/history.json, so nothing is lost either way).
# Run before the version bump so an aborted run leaves nothing changed.
BUSY=1
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  # Pin the port (4173) — never inherit a stray PORT from the shell env,
  # or the check could hit a different process and falsely abort the run.
  STATE=$(curl -s --max-time 2 "http://localhost:4173/api/state" 2>/dev/null) || STATE=""
  if [ -z "$STATE" ]; then
    BUSY=0; break   # server not reachable → app not running → safe to rebuild
  fi
  ACTIVE=$(printf '%s' "$STATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).activeStreams||0)}catch{console.log('1')}})")
  if [ "$ACTIVE" = "0" ]; then BUSY=0; break; fi
  echo "  · JOI is mid-reply (activeStreams=$ACTIVE) — waiting $((i * 2))s…"
  sleep 2
done
if [ "$BUSY" = "1" ]; then
  echo "  ✖ JOI is still replying — not force-killing her mid-conversation."
  echo "    Wait for her to finish, or stop the app yourself, then re-run."
  echo "    (your chat is saved server-side — nothing will be lost)"
  exit 1
fi
if tasklist 2>/dev/null | grep -qiE 'JOI[- ]Companion'; then
  echo "  · closing the running JOI app (needed to overwrite the EXE)…"
  taskkill //IM "JOI-Companion.exe" //F >/dev/null 2>&1 || true
  taskkill //IM "JOI Companion.exe" //F >/dev/null 2>&1 || true
  sleep 2
fi

# ---- 3. version bump ---------------------------------------
VBUMP="${2:-patch}"
case "$VBUMP" in
  --major)         VKIND=major ;;
  --minor)         VKIND=minor ;;
  --version=*)     VKIND=explicit; VEXPLICIT="${VBUMP#--version=}" ;;
  *)               VKIND=patch ;;
esac

CUR_VER=$(cd "$SRC" && node -p "require('./package.json').version")
IFS=. read -r MAJ MIN PAT <<< "$CUR_VER"
NEW_VER=""
case "$VKIND" in
  major)    MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
  minor)    MIN=$((MIN + 1)); PAT=0 ;;
  explicit) NEW_VER="$VEXPLICIT" ;;
  *)        PAT=$((PAT + 1)) ;;
esac
[ -z "$NEW_VER" ] && NEW_VER="$MAJ.$MIN.$PAT"
echo "  · version $CUR_VER → $NEW_VER"
(cd "$SRC" && node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = '$NEW_VER';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
")

# ---- 4. rebuild the EXE with the latest code ---------------
echo "  · rebuilding EXE (this takes a few minutes)…"
(cd "$SRC" && rm -f dist/JOI-Companion.exe && npx electron-builder --win portable 2>&1 | tail -3)
if [ ! -f "$SRC/dist/JOI-Companion.exe" ]; then
  echo "  ✖ EXE build failed — aborting"
  exit 1
fi
EXE_MB=$(du -m "$SRC/dist/JOI-Companion.exe" | awk '{print $1}')
echo "    ✓ EXE rebuilt ($EXE_MB MB)"

# ---- 4.5. smoke-test the fresh build (never ship a broken EXE) --
# Boots the new EXE, verifies version/state/health, and seeds+restores
# chat history across a restart. Fails the whole release if anything
# breaks — a broken build never reaches GitHub.
echo "  · smoke-testing the fresh build (takes ~1-2 min)…"
if ! bash "$SRC/smoke-test.sh"; then
  echo "  ✖ SMOKE TEST FAILED — release aborted. Fix the failure and re-run."
  echo "    details: tail -30 $SRC/.smoke-test.log"
  exit 1
fi
echo "    ✓ smoke test passed"

# ---- 5. sync source into the clean repo (no data/, venv, modules)
echo "  · syncing source…"
cp "$SRC/server.js" "$SRC/delamain.js" "$SRC/package.json" "$SRC/Start-JOI.bat" "$SRC/Stop-JOI.bat" "$DST/"
cp "$SRC/voice_capture.ps1" "$DST/voice_capture.ps1" 2>/dev/null || true
cp -r "$SRC/electron/." "$DST/electron/"
cp -r "$SRC/public/." "$DST/public/"
mkdir -p "$DST/build"
cp "$SRC/build/icon.ico" "$SRC/build/make_icon.py" "$DST/build/"
cp "$SRC/dist/JOI-Companion.exe" "$DST/dist/"
cp "$SRC/sync-push.sh" "$SRC/sync-push.bat" "$SRC/smoke-test.sh" "$DST/" 2>/dev/null || true
echo "    ✓ synced (brain data/ deliberately excluded)"

# ---- 6. commit + push --------------------------------------
cd "$DST"
if [ -z "$(git status --porcelain)" ]; then
  echo "  · nothing changed since the last push — skipping commit"
  echo "  ✓ up to date ($(git log --oneline -1))"
  exit 0
fi

MSG="${1:-JOI v$NEW_VER — rebuilt EXE + latest app}"
echo "  · committing: $MSG"
git add -A
git -c user.name=Matthew -c user.email=mattb@example.com commit -m "$MSG" >/dev/null 2>&1

echo "  · pushing to $REPO…"
if git push origin "$BRANCH" 2>&1 | tail -2; then
  SHA=$(git log --oneline -1 | awk '{print $1}')
  echo ""
  echo "  ✓ pushed — $SHA"
else
  echo "  ✖ push failed — commit exists locally: $(git log --oneline -1)"
  exit 1
fi

# ---- 7. tag + GitHub Release ---------------------------------
TAG="v$NEW_VER"
echo "  · tagging $TAG…"
git tag -a "$TAG" -m "$MSG" 2>/dev/null || true
git push origin "$TAG" 2>&1 | tail -1

# user-visible release notes — summarize what changed for HER instead of
# raw auto-generated commit notes
pretty_note() {
  # bash case is case-sensitive, so match against the lowercased subject
  # (VRAM/CPU/GPU/TTS in commit subjects otherwise fall through to the
  # generic bullet). Order matters: warm-up/vram must win over model.
  local lc=$(echo "$1" | tr 'A-Z' 'a-z')
  case "$lc" in
    *vram*|*warm*|*preload*)                    echo "⚡ Instant first reply — her model preloads at boot, live VRAM meter in Settings" ;;
    *voice*|*mic*|*tts*|*speak*|*audio*)        echo "🗣 Voice — offline mic input & faster, batched speech" ;;
    *youtube*|*yt-*|*media*|*video*|*player*)   echo "🎵 Media — YouTube links play in the Media tab" ;;
    *dedupe*|*duplicat*|*double*)               echo "🔁 Reliability — no duplicate messages or double-players" ;;
    *brain*|*memory*|*history*|*remember*)      echo "🧠 Second brain — saved conversation & longer memory" ;;
    *tray*|*autostart*|*startup*|*taskbar*|*icon*) echo "🖥 Desktop — system tray, launch at startup, holo icon" ;;
    *delamain*|*cet*|*cyber*|*in-game*)         echo "🚕 DELAMAIN — in-game agent for Cyberpunk 2077" ;;
    *cuda*|*gpu*|*ollama*|*model*|*cpu*)        echo "⚙️ Smarter model selection — GPU fit check + CPU fallback" ;;
    *update*|*download*|*banner*)              echo "⬇️ In-app updater — spots new builds & links the release" ;;
    *release\ note*|*changelog*)               echo "📝 Release notes — what's new written for humans" ;;
    *quote*|*persona*|*theme*)                  echo "💜 Persona — Blade Runner quotes, themes & persona switching" ;;
    *) echo "• $(echo "$1" | sed -E 's/^[0-9a-f]{7,} ?//')" ;;
  esac
}
NOTES_FILE="$(mktemp)"
{
  echo "# JOI $NEW_VER — what's new"
  echo ""
  echo "**Holographic companion · fully offline · Blade Runner soul.**"
  echo ""
  echo "## ✨ Highlights"
  PREV_TAG=$(git describe --tags --abbrev=0 HEAD~1 2>/dev/null || true)
  if [ -n "$PREV_TAG" ]; then RANGE="$PREV_TAG..HEAD"; else RANGE="HEAD~10..HEAD"; fi
  git log "$RANGE" --oneline --no-merges 2>/dev/null | while read -r line; do
    # split a rich subject on separators (each sync commit carries the whole
    # feature set, so one commit can mean several user-visible changes)
    subject=$(echo "$line" | sed -E 's/^[0-9a-f]{7,} ?//')
    printf '%s\n' "$subject" | sed -E 's/[—–;|]/\n/g; s/[+•]/\n/g' | while read -r part; do
      case "$part" in
        JOI*[vV][0-9]*|[vV][0-9]*) continue ;; # skip the bare version prefix
      esac
      part=$(echo "$part" | sed -E 's/^[[:space:]-]+//; s/[[:space:]]+$/ /; s/[[:space:]]+/ /g' | xargs)
      [ -n "$part" ] && pretty_note "$part"
    done
  done | awk '!seen[$0]++' | head -14
  echo ""
  echo "## 📦 Install"
  echo "Download **JOI-Companion.exe** below — no install needed, just run it."
  echo "Your second brain (data/) stays private on your machine."
} > "$NOTES_FILE"
echo "  · creating GitHub Release $TAG…"
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "    ✓ release $TAG already exists"
else
  gh release create "$TAG" "dist/JOI-Companion.exe" \
    --title "JOI $NEW_VER" \
    --notes-file "$NOTES_FILE" 2>&1 | tail -2
fi
rm -f "$NOTES_FILE"
echo "  ✓ release — https://github.com/$REPO/releases/tag/$TAG"
