@echo off
title JOI - Stop Server
echo Stopping JOI server on http://127.0.0.1:4173 ...
curl -s -X POST http://127.0.0.1:4173/api/server/stop
echo.
echo Done. Run Start-JOI.bat to bring her back.
timeout /t 3 /nobreak >nul
