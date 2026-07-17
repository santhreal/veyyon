# Behavior tests for scripts/install.ps1 helper functions — the destructive
# (Uninstall-Veyyon) path, run without any real install. Mirror of
# functions.test.sh. Dot-sources install.ps1 with VEYYON_INSTALL_SOURCED=1 so
# the installer main logic does not run.
#
# Run: pwsh scripts/install-tests/functions.test.ps1
$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("veyyon-ps1-test-" + [System.Guid]::NewGuid().ToString("N"))

# Isolate everything the uninstaller touches: install dir, the fake home whose
# .bun\bin it sweeps, and PATH (emptied of bun so `bun remove -g` never runs
# against the real machine). All env changes are process-scoped.
$env:VEYYON_INSTALL_DIR = Join-Path $sandbox "bin"
$env:USERPROFILE = Join-Path $sandbox "home"
$bunBin = Join-Path $env:USERPROFILE ".bun\bin"
New-Item -ItemType Directory -Force -Path $env:VEYYON_INSTALL_DIR, $bunBin | Out-Null
$savedPath = $env:PATH
$env:PATH = $sandbox

$script:pass = 0
$script:fail = 0
function Check {
    param([string]$Desc, $Actual, $Expected)
    if ("$Actual" -eq "$Expected") {
        $script:pass++
    } else {
        $script:fail++
        Write-Host "FAIL: $Desc`n  expected [$Expected]`n  got      [$Actual]"
    }
}

try {
    $env:VEYYON_INSTALL_SOURCED = "1"
    . (Join-Path $root "scripts\install.ps1")

    # --- Uninstall-Veyyon: removes binary + alias shim from install dir and bun bin ---
    foreach ($f in @("veyyon.exe", "vey.cmd")) {
        Set-Content -Path (Join-Path $InstallDir $f) -Value "fake"
        Set-Content -Path (Join-Path $bunBin $f) -Value "fake"
    }
    Uninstall-Veyyon | Out-Null
    Check "uninstall removed veyyon.exe from install dir" (Test-Path (Join-Path $InstallDir "veyyon.exe")) $false
    Check "uninstall removed vey.cmd from install dir" (Test-Path (Join-Path $InstallDir "vey.cmd")) $false
    Check "uninstall removed veyyon.exe from bun bin" (Test-Path (Join-Path $bunBin "veyyon.exe")) $false
    Check "uninstall removed vey.cmd from bun bin" (Test-Path (Join-Path $bunBin "vey.cmd")) $false

    # --- Uninstall-Veyyon: clean tree reports nothing, never throws ---
    # Write-Host output lives on the information stream; redirect 6> to capture it.
    $out = Uninstall-Veyyon 6>&1 | Out-String
    Check "second uninstall reports nothing to remove" ($out -like "*nothing to uninstall*") $true

    # --- Install-Alias: writes a vey.cmd shim delegating to the binary ---
    $target = Join-Path $InstallDir "veyyon.exe"
    Set-Content -Path $target -Value "fake"
    Install-Alias -Target $target | Out-Null
    $shim = Join-Path $InstallDir "vey.cmd"
    Check "Install-Alias created the vey.cmd shim" (Test-Path $shim) $true
    Check "shim delegates to the binary" ((Get-Content $shim -Raw) -like "*$target*") $true
} finally {
    $env:PATH = $savedPath
    Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
}

Write-Host "install.ps1 function tests: $script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
