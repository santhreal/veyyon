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

rem Everything below this point runs bun: both self-heal steps and the launch
rem itself. A source install is the one shape where bun has to be on PATH at RUN
rem time, not just at install time, and it drops off routinely. Without this the
rem user gets cmd's bare "'bun' is not recognized" from a command they installed
rem successfully, with nothing naming the cause or the fix.
where bun >nul 2>&1
if errorlevel 1 (
  echo veyyon: bun is not on PATH, and this is a source install that runs veyyon through bun. 1>&2
  echo veyyon: install bun ^(https://bun.sh^) and make sure it is on PATH, or reinstall the standalone binary: irm https://veyyon.dev/install.ps1 ^| iex 1>&2
  exit /b 1
)

rem The checkout itself has to still be there. install.ps1 -Source points a shim
rem in the install dir at this file; if that tree is moved or partly deleted the
rem shim still resolves here, which then hands bun a path to nothing.
if not exist "%cli%" (
  echo veyyon: the source checkout this command points at is incomplete ^(%cli% is missing^). 1>&2
  echo veyyon: reinstall it with: ^& ^([scriptblock]::Create^(^(irm https://veyyon.dev/install.ps1^)^)^) -Source 1>&2
  exit /b 1
)

rem Self-heal gitignored build artifacts a bare `git pull` leaves missing —
rem the parity twin of the POSIX launcher's self-heal. tool-views.generated.js
rem is resolved at module PARSE time, and the native addon is version-checked
rem at boot; without either, veyyon dies before main() with a raw resolve dump.
if not exist "%scripts_dir%..\src\export\html\tool-views.generated.js" (
  echo veyyon: regenerating missing build artifact ^(tool-views.generated.js^)... 1>&2
  call bun --cwd="%scripts_dir%..\..\collab-web" run gen:tool-views 1>&2
  if errorlevel 1 (
    echo veyyon: could not regenerate it. Run: bun install in the checkout root. 1>&2
    exit /b 1
  )
)
if not exist "%scripts_dir%..\..\natives\native\veyyon_natives.win32-x64*.node" (
  call bun "%scripts_dir%..\..\natives\scripts\ensure-native.ts" 1>&2
  if errorlevel 1 exit /b 1
)

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
