@echo off
REM JOI — sync, push & release (double-click friendly wrapper)
REM Rebuilds the EXE, bumps the version, syncs into the clean repo,
REM commits, pushes and creates a tagged GitHub Release with the EXE.
REM Args: message [--minor|--major|--version=X.Y.Z]
cd /d "%~dp0"
bash sync-push.sh %*
echo.
pause
