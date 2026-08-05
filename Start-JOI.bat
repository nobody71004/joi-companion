@echo off
title JOI - Holographic Companion
cd /d "%~dp0"
echo.
echo   **************************************************
echo     JOI - holographic companion
echo     Starting server on http://127.0.0.1:4173
echo     Close this window (or press Ctrl+C) to stop her.
echo   **************************************************
echo.
node server.js
pause
