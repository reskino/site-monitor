@echo off
REM Background launcher used by the Windows Startup shortcut. Runs the live
REM watcher and pushes updates to the public dashboard. No browser popup.
REM (To run it with a dashboard window instead, use start-watcher.cmd.)
cd /d "%~dp0"
title Site Monitor (background)
:loop
node watch.mjs --push
REM If node ever exits (crash, network stack reset), wait and restart.
timeout /t 15 /nobreak >nul
goto loop
