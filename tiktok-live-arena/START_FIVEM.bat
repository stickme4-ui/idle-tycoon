@echo off
chcp 65001 >nul
title Live Arena - FiveM server
cd /d "%~dp0fivem-server"

if not exist "artifacts\FXServer.exe" (
  echo.
  echo  FXServer is missing.
  echo  1. A download page will open - click the newest "recommended" build ^(server.7z^).
  echo  2. Extract it into:  %~dp0fivem-server\artifacts
  echo     so that this file exists:  fivem-server\artifacts\FXServer.exe
  echo  3. Run START_FIVEM.bat again.
  echo.
  start "" "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/"
  pause
  exit /b 1
)

if not exist "license.cfg" (
  echo.
  echo  You need a free server key from Cfx.re ^(one time^).
  echo  A page will open: log in, click "Generate key", any name, IP 127.0.0.1.
  echo.
  start "" "https://portal.cfx.re/servers/registration-keys"
  set /p KEY=Paste the key here and press Enter: 
  call :writekey
)

echo Starting FiveM server... In FiveM press F8 and type:  connect 127.0.0.1:30120
"artifacts\FXServer.exe" +exec server.cfg
pause
exit /b 0

:writekey
> license.cfg echo sv_licenseKey "%KEY%"
exit /b 0
