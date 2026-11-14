@echo off
chcp 65001 >nul
title Live Arena - launcher
start "Live Arena server" cmd /c "%~dp0START.bat"
timeout /t 3 /nobreak >nul
start "Live Arena FiveM" cmd /c "%~dp0START_FIVEM.bat"
echo.
echo  Both servers are starting in their own windows.
echo  Open FiveM, press F8 and type:  connect 127.0.0.1:30120
echo.
timeout /t 8
