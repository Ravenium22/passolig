@echo off
REM Usage: start-chrome.bat [profileName] [port]
REM Opens a dedicated Google Chrome window for the bot. Log in to Passo in THIS window.
setlocal
set PROFILE=%1
if "%PROFILE%"=="" set PROFILE=me
set PORT=%2
if "%PORT%"=="" set PORT=9222
set UDD=%LOCALAPPDATA%\PassoBot\%PROFILE%
if not exist "%UDD%" mkdir "%UDD%"
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
if "%CHROME%"=="" (
  echo Google Chrome bulunamadi / not found. Install Chrome first.
  pause
  exit /b 1
)
echo Starting Chrome profile "%PROFILE%" on port %PORT% ...
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%UDD%" --no-first-run --no-default-browser-check --window-size=1600,1000 "https://www.passo.com.tr/tr/login"
echo.
echo 1) Log in to Passo in the window that just opened.
echo 2) Keep that window open. Then run:  npm run preflight   (or npm start)
endlocal
