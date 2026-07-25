# End-to-end gate for install.ps1: the real installer, driven the way a user runs
# it, then uninstalled.
#
# WHY THIS EXISTS. functions.test.ps1 covers the pure helpers (PATH splitting,
# profile line matching, checksum parsing) without installing anything, and the
# release workflow downloads the published .exe and runs --version on it. Neither
# runs install.ps1 itself, so everything the installer does AROUND the binary was
# never executed on Windows even once: placing the file, writing the vey.cmd
# shim, adding the install directory to the user PATH, generating completions and
# wiring them into the PowerShell profile, the doctor self-test, and uninstall
# taking all of it back. install.sh has had that coverage on Linux for a while
# (scripts/install-tests/run-ci.sh); this is the Windows half.
#
# It installs the binary this checkout has already built, with install.ps1
# -Local, so it needs no published release and no network.
#
# WHAT IT MUTATES. Two things outside the sandbox, because the installer edits
# them for real and testing a fake would prove nothing:
#
#   * the user PATH environment variable (HKCU), via Add-ToPath
#   * the CurrentUserAllHosts PowerShell profile, via Install-Completions
#
# Both are captured before the run and restored in the finally block, and the
# uninstall assertions run BEFORE the restore, so what is checked is what the
# installer actually reclaimed rather than what this script put back. It still
# refuses to run without VEYYON_INSTALL_E2E=1, because a developer who runs the
# test suite on their own machine should not have their PATH and profile edited
# by surprise.
#
# Run: VEYYON_INSTALL_E2E=1 pwsh -File scripts/install-tests/e2e.test.ps1

$ErrorActionPreference = "Stop"

if ($env:VEYYON_INSTALL_E2E -ne "1") {
    Write-Host "install.ps1 end-to-end test refused to run." -ForegroundColor Yellow
    Write-Host "It installs and uninstalls for real, which edits your user PATH and your"
    Write-Host "PowerShell profile (both are restored afterwards). Set VEYYON_INSTALL_E2E=1"
    Write-Host "to run it. CI sets this on the windows-latest runner."
    exit 1
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:Pass = 0
$script:Fail = 0

function Check {
    param([string]$Desc, [bool]$Condition)
    if ($Condition) {
        $script:Pass++
        Write-Host "ok   $Desc"
    } else {
        $script:Fail++
        Write-Host "FAIL $Desc" -ForegroundColor Red
    }
}

function ExpectExists {
    param([string]$Path, [string]$What)
    Check "$What exists ($Path)" (Test-Path -LiteralPath $Path)
}

function ExpectAbsent {
    param([string]$Path, [string]$What)
    Check "$What is gone ($Path)" (-not (Test-Path -LiteralPath $Path))
}

function Get-UserPath {
    return [Environment]::GetEnvironmentVariable("Path", "User")
}

# The profile install.ps1 writes to, resolved the same way Get-ProfilePath does.
$profilePath = $PROFILE.CurrentUserAllHosts
$completionScript = Join-Path (Split-Path -Parent $profilePath) "veyyon-completions.ps1"

$savedPath = Get-UserPath
$savedProfile = if (Test-Path -LiteralPath $profilePath) { Get-Content -Raw -LiteralPath $profilePath } else { $null }
$installDir = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-e2e-$PID\bin"
$srcDir = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-e2e-$PID\src"

$env:VEYYON_INSTALL_DIR = $installDir
$env:VEYYON_SRC_DIR = $srcDir

# A line of the user's own, to prove the installer gives the profile back the way
# it found it. Uninstall taking the user's content with it would be worse than
# leaving its own line behind.
$ownProfileLine = "# a line this user wrote themselves"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profilePath) | Out-Null
Add-Content -LiteralPath $profilePath -Value $ownProfileLine

$installer = Join-Path $root "scripts/install.ps1"
$binPath = Join-Path $installDir "veyyon.exe"
$aliasPath = Join-Path $installDir "vey.cmd"

try {
    Write-Host ""
    Write-Host "=== install (-Local) ==="
    & pwsh -NoProfile -File $installer -Local
    Check "the installer exited 0" ($LASTEXITCODE -eq 0)

    ExpectExists $binPath "the binary itself"
    ExpectExists $aliasPath "the vey launch shim"
    ExpectExists $completionScript "the generated completion script"

    # The shim must actually point at our binary, not merely exist: an empty or
    # stale vey.cmd would satisfy a presence check and fail every invocation.
    $shim = Get-Content -Raw -LiteralPath $aliasPath
    Check "the vey shim invokes the installed binary" ($shim -match [regex]::Escape("veyyon.exe"))

    # The PATH entry, which is what makes `veyyon` work in the next shell. This
    # is the half the release verify jobs cannot see, because they run the .exe
    # by explicit path.
    Check "the install dir is on the user PATH" ((Get-UserPath) -split ';' -contains $installDir)

    # The profile dot-source line, under the installer's marker.
    $profileNow = Get-Content -Raw -LiteralPath $profilePath
    Check "the profile dot-sources the completion script" ($profileNow -match [regex]::Escape($completionScript))
    Check "the profile line carries the installer marker" ($profileNow -match [regex]::Escape("# added by the veyyon installer"))

    # The installed binary runs. --version proves the native addon loads, which
    # is the failure a Windows build most often has and which no amount of file
    # checking would catch.
    $version = (& $binPath --version | Out-String).Trim()
    Check "the installed binary reports a version" ($LASTEXITCODE -eq 0 -and $version.Length -gt 0)
    & $binPath --smoke-test | Out-Null
    Check "the installed binary passes --smoke-test" ($LASTEXITCODE -eq 0)

    Write-Host ""
    Write-Host "=== reinstall over an existing install ==="
    & pwsh -NoProfile -File $installer -Local
    Check "the reinstall exited 0" ($LASTEXITCODE -eq 0)

    # Idempotence, which is what an upgrade actually is. A second PATH entry or a
    # second profile line is the classic installer bug: nothing breaks, the litter
    # just accumulates one line per upgrade forever.
    $pathEntries = @((Get-UserPath) -split ';' | Where-Object { $_ -eq $installDir })
    Check "the PATH entry was not duplicated" ($pathEntries.Count -eq 1)
    $profileAfterReinstall = @(Get-Content -LiteralPath $profilePath | Where-Object { $_ -match [regex]::Escape($completionScript) })
    Check "the profile line was not duplicated" ($profileAfterReinstall.Count -eq 1)

    # No staging litter: the installer stages beside the target and moves into
    # place, and a failed or interrupted move must not leave the staged file.
    $litter = @(Get-ChildItem -Path $installDir -Force -File | Where-Object { $_.Name -like ".veyyon.*" -or $_.Name -like "*.old" })
    Check "no staging files were left behind" ($litter.Count -eq 0)

    Write-Host ""
    Write-Host "=== uninstall ==="
    & pwsh -NoProfile -File $installer -Uninstall
    Check "the uninstaller exited 0" ($LASTEXITCODE -eq 0)

    ExpectAbsent $binPath "the binary after uninstall"
    ExpectAbsent $aliasPath "the vey shim after uninstall"
    ExpectAbsent $completionScript "the completion script after uninstall"

    Check "the install dir is off the user PATH" (-not ((Get-UserPath) -split ';' -contains $installDir))

    $profileAfterUninstall = Get-Content -Raw -LiteralPath $profilePath
    Check "the profile dot-source line is gone" (-not ($profileAfterUninstall -match [regex]::Escape($completionScript)))
    # The decisive one. Reclaiming its own line must not take the user's with it.
    Check "the user's own profile content survived" ($profileAfterUninstall -match [regex]::Escape($ownProfileLine))

    $remaining = @(Get-ChildItem -Path $installDir -Force -ErrorAction SilentlyContinue)
    Check "the install directory is empty" ($remaining.Count -eq 0)
} finally {
    # Put the machine back the way it was, whatever happened above. The
    # assertions have already run against the installer's own cleanup, so
    # restoring here cannot make a failing uninstall look like a passing one.
    [Environment]::SetEnvironmentVariable("Path", $savedPath, "User")
    if ($null -eq $savedProfile) {
        Remove-Item -LiteralPath $profilePath -Force -ErrorAction SilentlyContinue
    } else {
        Set-Content -LiteralPath $profilePath -Value $savedProfile -NoNewline
    }
    Remove-Item -Recurse -Force (Split-Path -Parent $installDir) -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "install.ps1 end-to-end: $script:Pass passed, $script:Fail failed"
if ($script:Fail -gt 0) { exit 1 }
