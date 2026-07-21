@echo off
setlocal
rem Windows dev launcher for the veyyon CLI — the native counterpart of the
rem POSIX `scripts/veyyon` launcher. The install.ps1 `-Source` path points a
rem `veyyon.cmd` shim in the install dir at this file.
rem
rem Problem it solves: Bun reads `bunfig.toml` from the *current working
rem directory* at startup and evaluates its `preload` entries before running the
rem script, so a bun-shebang bin inherits whatever `preload` the directory you
rem happen to be in declares — and crashes if that preload cannot resolve.
rem Bun only reads the exact cwd (it does not walk parents), so the fix is to
rem launch Bun from an empty, bunfig-free directory and restore the real cwd
rem inside the process via the `veyyon.ts` preload shim alongside this file.

set "scripts_dir=%~dp0"
set "cli=%scripts_dir%..\src\cli.ts"
set "preload=%scripts_dir%veyyon.ts"
set "timing_preload=%scripts_dir%..\..\utils\src\module-timer.ts"

if not defined VEYYON_DEV_LAUNCH_DIR set "VEYYON_DEV_LAUNCH_DIR=%USERPROFILE%\.veyyon\.dev-cwd"
if not exist "%VEYYON_DEV_LAUNCH_DIR%" mkdir "%VEYYON_DEV_LAUNCH_DIR%" >nul 2>&1

set "VEYYON_LAUNCH_CWD=%CD%"
cd /d "%VEYYON_DEV_LAUNCH_DIR%"
if defined VEYYON_TIMING (
  bun --preload "%preload%" --preload "%timing_preload%" "%cli%" %*
) else (
  bun --preload "%preload%" "%cli%" %*
)
exit /b %ERRORLEVEL%
