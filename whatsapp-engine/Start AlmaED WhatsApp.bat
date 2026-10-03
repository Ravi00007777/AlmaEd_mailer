@echo off
title AlmaED WhatsApp engine
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and then double-click this file again.
  start https://nodejs.org
  pause
  exit /b
)
node src\index.js
echo.
echo The engine has stopped.
pause
