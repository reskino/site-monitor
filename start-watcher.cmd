@echo off
REM Double-click to start the real-time Site Monitor watcher.
REM It checks your sites every 60 seconds, shows a live dashboard, and pops a
REM desktop notification whenever a site goes down, recovers, or is expiring.
REM Close this window (or press Ctrl+C) to stop.

cd /d "%~dp0"
title Site Monitor - live watcher
echo Starting the Site Monitor live watcher...
echo Dashboard will open at http://localhost:8787
echo Close this window to stop.
echo.
node watch.mjs --open
pause
