@echo off
title Poker Party Server
cd /d "%~dp0"
echo.
echo  Starting the Poker Party server...
echo  (If Windows Firewall asks, click "Allow access" for Private networks
echo   so friends on your Wi-Fi can connect.)
echo.
start "" http://localhost:8766
node server.js
pause
