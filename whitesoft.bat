@echo off
rem ============================================================================
rem  WhiteSoft - local whiteboard launcher for Windows
rem
rem    whitesoft.bat                 start on 127.0.0.1:8787 and open the browser
rem    whitesoft.bat --open          also open the default browser
rem    whitesoft.bat --port 9000     use another port, default is 8787
rem    whitesoft.bat --auto-port     if the port is taken, try the next free one
rem
rem  Boards are read and written by the browser itself, so there is no directory
rem  to pass. The server only hosts the UI. The script lives in the repository
rem  root and works from any working directory. Double-clicking works too.
rem
rem  Any option this script does not recognise is forwarded to node server.mjs.
rem
rem  Keep this file ASCII-only. cmd.exe reads .bat files using the console code
rem  page, so non-ASCII bytes in comments or echo lines get mis-decoded into
rem  bogus commands. cmd's UTF-8 handling is not reliable either.
rem ============================================================================

setlocal enabledelayedexpansion

rem --- how was this started? -------------------------------------------------
rem A double-click runs the file with no arguments in a fresh console that
rem vanishes when the script ends. That case opens the browser and waits for a
rem key at the end, so an error stays readable instead of flashing past.
set "SHELL_CALL=1"
if "%~1"=="" set "SHELL_CALL=0"

rem --- defaults ---------------------------------------------------------------
rem the PORT environment variable seeds the default port, like whitesoft.sh
set "PORT_DEFAULT=8787"
if defined PORT (set "PORT=%PORT%") else (set "PORT=%PORT_DEFAULT%")
set "HOST=127.0.0.1"
rem A double-click has nothing else to do afterwards, so it opens the browser.
rem From a shell the URL is printed and nothing is opened unless --open is given.
if "%SHELL_CALL%"=="0" (set "OPEN=1") else (set "OPEN=0")
set "AUTO_PORT=0"
set "EXTRA="
set "NO_COLOR=0"

rem directory this script lives in, %~dp0 already ends with a backslash
set "APP_DIR=%~dp0"
set "SERVER=%APP_DIR%server.mjs"

rem --- parse arguments -------------------------------------------------------
:parse
if "%~1"=="" goto parse_done
if /i "%~1"=="-h"          ( call :usage & goto exit_ok )
if /i "%~1"=="--help"      ( call :usage & goto exit_ok )
if /i "%~1"=="/?"          ( call :usage & goto exit_ok )
if /i "%~1"=="--open"      ( set "OPEN=1" & shift & goto parse )
if /i "%~1"=="--no-open"   ( set "OPEN=0" & shift & goto parse )
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
rem --port without a value leaves PORT empty, that is an error
if "%PORT%"=="" goto bad_port
if "%HOST%"=="" set "HOST=127.0.0.1"

rem --- colours ---------------------------------------------------------------
rem ASCII only, so a console without ANSI support just prints plain text
set "ESC="
set "C_RESET="
set "C_BOLD="
set "C_RED="
set "C_YELLOW="
set "C_CYAN="
if "%NO_COLOR%"=="0" (
  rem ask PowerShell for one real ESC byte 0x1B instead of embedding it here
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

rem --- port validation: digits only, 1..65535 --------------------------------
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
rem  Every failure prints, waits for a key when this was a double-click, and
rem  then exits. The block is repeated rather than shared through a subroutine:
rem  a `call` here would return into the code that follows and the script would
rem  carry on starting up, which is exactly the bug this replaces.
set "MSG=port must be a number between 1 and 65535, got: %PORT%"
goto fail

:port_done
rem --- prerequisites: node exists, is 18 or newer, server.mjs is next to us ---
where node >nul 2>nul
if errorlevel 1 goto fail_no_node
rem call node: it may be a .cmd shim such as nvm or scoop, whose exit /b would
rem otherwise end this script early
call node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto node_too_old
goto node_ok

:node_too_old
call :node_version
set "MSG=Node.js is too old, found !NODE_VER!. Version 18 or newer is required."
goto fail

:node_ok
if not exist "%SERVER%" goto fail_no_server

rem --- is the port already taken? --------------------------------------------
rem bind it with the .NET TcpListener, a failed bind means something listens there
call :check_port !PORT!
if errorlevel 1 goto port_busy
goto port_free

:port_busy
if not "%AUTO_PORT%"=="1" goto fail_port_busy
set "START=!PORT!"
set "TRIES=0"

:auto_port
call :check_port !PORT!
if not errorlevel 1 goto auto_port_found
set /a TRIES+=1
if !TRIES! GEQ 50 goto fail_ports_exhausted
set /a PORT+=1
goto auto_port

:fail_no_node
set "MSG=node not found. Install Node.js 18 or newer from nodejs.org, then run this again."
goto fail

:fail_no_server
set "MSG=server file not found: %SERVER%"
goto fail

:fail_port_busy
set "MSG=port !PORT! is already in use. Use --port to pick another one, or --auto-port to advance automatically."
goto fail

:fail_ports_exhausted
set "MSG=50 ports from !START! onwards are all in use. Pass --port to choose one."
goto fail

:auto_port_found
echo !C_YELLOW!port !START! is in use, using !PORT! instead.!C_RESET!

:port_free
set "URL=http://!HOST!:!PORT!/"

rem --- banner ----------------------------------------------------------------
echo(
echo !C_BOLD!WhiteSoft!C_RESET! - local whiteboard
echo ----------------------------------------------
echo URL      : !C_CYAN!!URL!!C_RESET!
echo Boards   : pick your .note / .pdf with "Open" in the UI
echo Stop     : Ctrl+C, or close this window
echo ----------------------------------------------
echo(

rem --- open the browser once the server has had a moment to come up ----------
rem `start "" url` uses the shell's default handler for the URL. The rundll32
rem call this script used before is what Windows protection flags as dangerous.
if "%OPEN%"=="1" (
  start "" /b cmd /c ">nul ping -n 2 127.0.0.1 & start """" ""!URL!"""
)

rem --- start the server ------------------------------------------------------
cd /d "%APP_DIR%"
call node "%SERVER%" --port !PORT! --host !HOST! !EXTRA!
set "EXIT_CODE=!errorlevel!"

echo(
if not "!EXIT_CODE!"=="0" (
  echo !C_RED!server stopped with error code !EXIT_CODE!.!C_RESET!
) else (
  echo server stopped.
)
rem A double-clicked window would vanish before anyone could read the message,
rem so it waits for a key. A shell call returns straight away.
if "%SHELL_CALL%"=="0" (
  echo Press any key to close this window.
  pause >nul
)
exit /b !EXIT_CODE!

rem ============================================================================
rem  subroutines
rem ============================================================================

:usage
echo WhiteSoft - local whiteboard launcher for Windows
echo(
echo   whitesoft.bat                 start on 127.0.0.1:8787 and open the browser
echo   whitesoft.bat --open          also open the default browser
echo   whitesoft.bat --port 9000     use another port
echo   whitesoft.bat --auto-port     if the port is taken, try the next free one
echo(
echo Boards are read and written by the browser itself, so the server only hosts
echo the UI and needs no directory. Unrecognised options are forwarded to
echo node server.mjs.
echo(
echo Options:
echo   -p, --port ^<n^>     listening port, default 8787 or the PORT variable
echo   -H, --host ^<addr^>  listening address, default 127.0.0.1
echo       --open          open the default browser once the server is up
echo       --no-open       do not open a browser, just serve
echo       --auto-port     advance to the next free port when this one is taken
echo       --no-color      disable ANSI colours
echo   -h, --help          show this help
goto :eof

:collect_all
rem  everything after -- is forwarded verbatim
if "%~1"=="" goto :eof
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
goto :eof

:check_port
rem  %1 = port. returns 0 when the port is free, 1 when something holds it.
powershell -NoProfile -Command "try{$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,%~1);$l.Start();$l.Stop();exit 0}catch{exit 1}" >nul 2>nul
goto :eof

:fail
rem  Reached by `goto fail` with MSG set. Prints, keeps the window open when this
rem  was a double-click, and exits. Every caller jumps here, never calls, so the
rem  script cannot fall through into a half-started state.
echo(
echo !C_RED!!MSG!!C_RESET!
echo(
if "%SHELL_CALL%"=="0" (
  echo WhiteSoft could not start. Press any key to close this window.
  pause >nul
)
endlocal & exit /b 1

:exit_ok
endlocal & exit /b 0
