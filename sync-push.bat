@echo off
REM JOI — sync & push (double-click friendly wrapper)
REM Rebuilds the EXE, syncs into the clean repo, commits and pushes to GitHub.
cd /d "%~dp0"
bash sync-push.sh %*
echo.
pause
