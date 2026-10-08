@echo off
rem ---------------------------------------------------------------------------
rem  Melora - start the web interface on Windows.
rem
rem  Double-click this file. It checks Node is installed, installs the
rem  dependencies the first time, starts the server and opens the interface in
rem  your browser once it is answering.
rem
rem  Anything you type after it is passed straight to the server, so
rem  `start.bat --port 5000` works; in that case open the address it prints
rem  yourself, since the config file is no longer the whole story.
rem ---------------------------------------------------------------------------

setlocal EnableExtensions
cd /d "%~dp0"

rem A second copy of this file runs alongside the server, waiting for the port
rem to answer before opening the browser. That copy jumps straight there.
if /i "%~1"=="--open-when-ready" goto openwhenready

title Melora

where node >nul 2>nul
if errorlevel 1 goto nonode

set "NODEMAJOR="
set "NODEMINOR="
for /f "usebackq tokens=1,2 delims=." %%a in (`node -p "process.versions.node" 2^>nul`) do (
  set "NODEMAJOR=%%a"
  set "NODEMINOR=%%b"
)
if not defined NODEMAJOR goto nonode
if %NODEMAJOR% LSS 20 goto oldnode
if %NODEMAJOR% EQU 20 if %NODEMINOR% LSS 11 goto oldnode

if not exist "node_modules\express\package.json" (
  echo Installing dependencies. This happens once, and needs the internet.
  echo.
  call npm install
  if errorlevel 1 goto installfailed
  echo.
)

rem Only open a browser for a plain double-click. With arguments of your own,
rem the address the server prints is the one that is true.
if "%~1"=="" start "Melora browser" /min "%~f0" --open-when-ready

echo Starting Melora. Press Ctrl+C to stop it.
echo.
node src/cli.js serve %*
set "STOPPED=%ERRORLEVEL%"
echo.
if not "%STOPPED%"=="0" echo Melora stopped with exit code %STOPPED%.
echo Melora is no longer running. Close this window, or run start.bat again.
pause
exit /b %STOPPED%

rem ---------------------------------------------------------------------------

:openwhenready
call :resolveurl
if not defined URL exit /b 0
rem Wait for the port to answer rather than guessing at a delay: the first
rem start of the day can spend a moment on a drive that is still waking up.
node -e "const net=require('net');const u=new URL(process.argv[1]);const until=Date.now()+30000;function tick(){const s=net.connect({host:u.hostname,port:u.port});s.on('connect',function(){s.destroy();process.exit(0)});s.on('error',function(){s.destroy();if(Date.now()>until){process.exit(1)}setTimeout(tick,250)})}tick()" "%URL%"
if errorlevel 1 exit /b 0
start "" "%URL%"
exit /b 0

:resolveurl
set "URL="
for /f "usebackq tokens=* delims=" %%u in (`node -e "import('./src/config.js').then(m=>{const c=m.loadConfig();const h=c.server.host;const shown=h==='0.0.0.0'?'127.0.0.1':h;console.log('http://'+shown+':'+c.server.port)})" 2^>nul`) do set "URL=%%u"
goto :eof

:nonode
echo.
echo Melora needs Node.js 20.11 or newer, and there is no node on this computer.
echo Install the LTS build from https://nodejs.org and run start.bat again.
echo.
pause
exit /b 1

:oldnode
echo.
echo This computer has Node.js %NODEMAJOR%.%NODEMINOR%, and Melora needs 20.11 or newer.
echo Install the current LTS build from https://nodejs.org and run start.bat again.
echo.
pause
exit /b 1

:installfailed
echo.
echo npm install did not finish, so there is nothing to start yet.
echo The reason is somewhere above. On Windows it is usually better-sqlite3 or
echo sharp falling back to compiling from source because no prebuilt binary
echo matches this Node version - Node 20, 22 and 24 all have one.
echo.
pause
exit /b 1
