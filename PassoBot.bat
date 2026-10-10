@echo off
REM PassoBot - cift tikla, panel tarayicida acilir. Bu pencereyi kapatma.
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js kurulu degil. Once https://nodejs.org adresinden LTS surumu kur ^(next-next^), sonra tekrar cift tikla.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Paketler kuruluyor, 1 dk surebilir...
  call npm install --no-audit --no-fund
  if errorlevel 1 ( echo npm install basarisiz. Internet var mi? & pause & exit /b 1 )
)
if not exist config.json copy config.example.json config.json >nul
if not "%1"=="" set PASSOBOT_UI_PORT=%1
if "%PASSOBOT_UI_PORT%"=="" set PASSOBOT_UI_PORT=4567
echo Panel aciliyor: http://127.0.0.1:%PASSOBOT_UI_PORT%   (bu pencereyi KAPATMA)
node src\ui.js
pause
