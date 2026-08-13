@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "Tender Radar" /min cmd /k "npm run radar"
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"
