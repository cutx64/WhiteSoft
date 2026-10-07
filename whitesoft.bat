@echo off
rem ============================================================================
rem  WhiteSoft - local whiteboard launcher for Windows (same options as whitesoft.sh)
rem
rem    whitesoft.bat                 start on 127.0.0.1:8787 and print the URL
rem    whitesoft.bat --open          also open the default browser
rem    whitesoft.bat --port 9000     use another port (default is 8787)
rem    whitesoft.bat --auto-port     if the port is taken, try the next free one
rem
rem  Boards are read and written by the browser itself, so there is no directory
rem  to pass: the server only hosts the UI.  The script lives in the repository
rem  root and works from any working directory (double-clicking also works).
rem
rem  Any option this script does not recognise is forwarded to node server.mjs.
rem
rem  Keep this file ASCII-only: cmd.exe reads .bat files using the console code
rem  page, so non-ASCII bytes in comments or echo lines get mis-decoded into
rem  bogus commands (and cmd's UTF-8 handling is not reliable either).
rem ============================================================================

setlocal enabledelayedexpansion

rem --- defaults ---------------------------------------------------------------
rem the PORT environment variable seeds the default port, like whitesoft.sh
set "PORT_DEFAULT=8787"
if defined PORT (set "PORT=%PORT%") else (set "PORT=%PORT_DEFAULT%")
set "HOST=127.0.0.1"
set "OPEN=0"
set "AUTO_PORT=0"
set "EXTRA="
set "NO_COLOR=0"

rem directory this script lives in (%~dp0 already ends with a backslash)
set "APP_DIR=%~dp0"
set "SERVER=%APP_DIR%server.mjs"

rem --- parse arguments (unrecognised ones are forwarded to node server.mjs) ---
:parse
if "%~1"=="" goto parse_done
if /i "%~1"=="-h"          ( call :usage & exit /b 0 )
if /i "%~1"=="--help"      ( call :usage & exit /b 0 )
if /i "%~1"=="/?"          ( call :usage & exit /b 0 )
if /i "%~1"=="--open"      ( set "OPEN=1" & shift & goto parse )
if /i "%~1"=="--auto-port" ( set "AUTO_PORT=1" & shift & goto parse )
if /i "%~1"=="--no-color"  ( set "NO_COLOR=1" & shift & goto parse )
if /i "%~1"=="/no-color"   ( set "NO_COLOR=1" & shift & goto parse )
if /i "%~1"=="-p"          ( set "PORT=%~2" & shift & shift & goto parse )
if /i "%~1"=="--port"      ( set "PORT=%~2" & shift & shift & goto parse )
if /i "%~1"=="-H"          ( set "HOST=%~2" & shift & shift & goto parse )
if /i "%~1"=="--host"      ( set "HOST=%~2" & shift & shift & goto parse )
if /i "%~1"=="--"          ( shift & call :collect_all & goto parse_done )
if /i "%~1"=="--port=*"    ( set "PORT=!%~1:*--port=!" & shift & goto parse )
if /i "%~1"=="--host=*"    ( set "HOST=!%~1:*--host=!" & shift & goto parse )
set "EXTRA=!EXTRA! %~1"
shift
goto parse

:parse_done
rem --port without a value leaves PORT empty; that is an error
if "%PORT%"=="" goto bad_port
if "%HOST%"=="" set "HOST=127.0.0.1"

rem --- colours: ASCII only, so a console without ANSI just prints plain text ---
set "ESC="
set "C_RESET="
set "C_BOLD="
set "C_RED="
set "C_YELLOW="
set "C_CYAN="
if "%NO_COLOR%"=="0" (
  rem ask PowerShell for one real ESC byte (0x1B) instead of embedding it here
  set "ESC_FILE=%TEMP%\whitesoft_esc_%RANDOM%%RANDOM%.tmp"
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%ESC_FILE%',[string][char]27,[Text.Encoding]::ASCII)" >nul 2>nul
  if exist "%ESC_FILE%" (
    set /p "ESC="<"%ESC_FILE%"
    del "%ESC_FILE%" >nul 2>nul
  )
  if defined ESC (
    set "C_RESET=!ESC![0m"
    set "C_BOLD=!ESC![1m"
    set "C_RED=!ESC![31m"
    set "C_YELLOW=!ESC![33m"
    set "C_CYAN=!ESC![36m"
  )
)

rem --- port validation: digits only, 1..65535 ---------------------------------
set "chk=%PORT%"
:port_digits
if "%chk%"=="" goto port_range
set "d=%chk:~0,1%"
if "!d!" LSS "0" goto bad_port
if "!d!" GTR "9" goto bad_port
set "chk=!chk:~1!"
goto port_digits

:port_range
if !PORT! LSS 1 goto bad_port
if !PORT! GTR 65535 goto bad_port
goto port_done

:bad_port
call :fail "port must be a number between 1 and 65535, got: %PORT%"
exit /b 1

:port_done
rem --- prerequisites: node exists, is >= 18, and server.mjs is next to us -----
where node >nul 2>nul
if errorlevel 1 (
  call :fail "node not found. Please install Node.js 18 or newer."
  exit /b 1
)
rem call node: it may be a .cmd shim (nvm, scoop, ...) whose exit /b would
rem otherwise end this script early.
call node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto node_too_old
goto node_ok

:node_too_old
call :node_version
call :fail "Node.js is too old (found !NODE_VER!), version 18 or newer is required."
exit /b 1

:node_ok
if not exist "%SERVER%" (
  call :fail "server file not found: %SERVER%"
  exit /b 1
)

rem --- is the port already taken? ---------------------------------------------
rem bind it with .NET's TcpListener: a failed bind means something is listening
call :check_port !PORT!
if errorlevel 1 goto port_busy
goto port_free

:port_busy
if not "%AUTO_PORT%"=="1" (
  call :fail "port !PORT! is already in use. Use --port to pick another one, or --auto-port to advance automatically."
  exit /b 1
)
set "START=!PORT!"
set "TRIES=0"

:auto_port
call :check_port !PORT!
if not errorlevel 1 goto auto_port_found
set /a TRIES+=1
if !TRIES! GEQ 50 (
  call :fail "50 ports from !START! onwards are all in use; please pass --port."
  exit /b 1
)
set /a PORT+=1
goto auto_port

:auto_port_found
echo !C_YELLOW!port !START! is in use, using !PORT! instead.!C_RESET!

:port_free
set "URL=http://!HOST!:!PORT!/"

rem --- banner -----------------------------------------------------------------
echo(
echo !C_BOLD!WhiteSoft!C_RESET! - local whiteboard
echo ----------------------------------------------
echo URL      : !C_CYAN!!URL!!C_RESET!
echo Boards   : pick your .note / .pdf with "Open" in the UI (files are never copied or uploaded)
echo Stop     : Ctrl+C
echo ----------------------------------------------
echo(

rem --- open the browser a moment later, so the server is up first ------------
if "%OPEN%"=="1" (
  start "" /b cmd /c ">nul ping -n 2 127.0.0.1 & rundll32 url.dll,FileProtocolHandler ""!URL!"""
)

rem --- start the server -------------------------------------------------------
cd /d "%APP_DIR%"
call node "%SERVER%" --port !PORT! --host !HOST! !EXTRA!
exit /b %errorlevel%

rem ============================================================================
rem  subroutines
rem ============================================================================

:usage
echo WhiteSoft - local whiteboard launcher for Windows
echo(
echo   whitesoft.bat                 start on 127.0.0.1:8787 and print the URL
echo   whitesoft.bat --open          also open the default browser
echo   whitesoft.bat --port 9000     use another port
echo   whitesoft.bat --auto-port     if the port is taken, try the next free one
echo(
echo Boards are read and written by the browser itself, so the server only hosts
echo the UI and needs no directory.  Unrecognised options are forwarded to
echo node server.mjs.
echo(
echo Options:
echo   -p, --port ^<n^>     listening port (default 8787, or the PORT variable)
echo   -H, --host ^<addr^>  listening address (default 127.0.0.1)
echo       --open          open the default browser once the server is up
echo       --auto-port     advance to the next free port when this one is taken
echo       --no-color      disable ANSI colours
echo   -h, --help          show this help
exit /b 0

:collect_all
rem  everything after -- is forwarded verbatim
if "%~1"=="" exit /b 0
set "EXTRA=!EXTRA! %~1"
shift
goto collect_all

:node_version
rem  put "node -v" into NODE_VER, only to make the error message specific.
rem  uses a temp file rather than for /f, which does not handle .cmd shims.
set "NODE_VER="
set "VER_FILE=%TEMP%\whitesoft_ver_%RANDOM%%RANDOM%.tmp"
if exist "%VER_FILE%" del "%VER_FILE%" >nul 2>nul
call node -v >"%VER_FILE%" 2>nul
if exist "%VER_FILE%" (
  set /p "NODE_VER="<"%VER_FILE%"
  del "%VER_FILE%" >nul 2>nul
)
exit /b 0

:check_port
rem  %1 = port.  returns 0 when the port is free, 1 when something holds it.
powershell -NoProfile -Command "try{$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,%~1);$l.Start();$l.Stop();exit 0}catch{exit 1}" >nul 2>nul
exit /b %errorlevel%

:fail
rem  %1 = message.  prints it in red on stderr; the caller must follow with exit /b 1
echo !C_RED!%~1!C_RESET! 1>&2
exit /b 1
