# Veyyon Coding Agent Installer for Windows
# Usage: irm https://veyyon.dev/install.ps1 | iex
#   or:  irm https://raw.githubusercontent.com/santhreal/veyyon/main/scripts/install.ps1 | iex
#
# By default this installs the prebuilt self-contained binary
# (veyyon-windows-x64.exe): one download, no toolchain, nothing from a package
# registry. Pass -Source to build and run from a git checkout with bun instead
# (needed only to run an unreleased ref).
#
# With options:
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Source -Ref v1.0.11
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Binary -Ref v1.0.11
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Uninstall

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref,
    [switch]$NoVerify,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$Repo = "santhreal/veyyon"
$RepoUrl = "https://github.com/$Repo.git"
$Package = "@veyyon/coding-agent"
$InstallDir = if ($env:VEYYON_INSTALL_DIR) { $env:VEYYON_INSTALL_DIR } else { "$env:LOCALAPPDATA\veyyon" }
$SrcDir = if ($env:VEYYON_SRC_DIR) { $env:VEYYON_SRC_DIR } else { "$env:USERPROFILE\.veyyon\src" }
$BinName = "veyyon"
$AliasName = "vey"
$BinaryAsset = "veyyon-windows-x64.exe"
$MinimumBunVersion = "1.3.14"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        # Default profile agent dir. A legacy bare-root agent dir wins so we never
        # create both layouts at once (launch fails closed on that ambiguity);
        # veyyon migrates the legacy tree into profiles\default on next launch.
        $legacyAgentDir = Join-Path $env:USERPROFILE ".veyyon\agent"
        if (Test-Path $legacyAgentDir) {
            $settingsDir = $legacyAgentDir
        } else {
            $settingsDir = Join-Path $env:USERPROFILE ".veyyon\profiles\default\agent"
        }
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json -AsHashtable
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "OK  Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "!  No bash shell found!" -ForegroundColor Yellow
            Write-Host "   Veyyon requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "     1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "     2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "   After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "     $settingsFile" -ForegroundColor Yellow
            Write-Host '     { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "!  Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

# Write a `vey.cmd` shim next to the binary so `vey` launches Veyyon, mirroring
# the `vey` symlink the Unix installer creates.
function Install-Alias {
    param([string]$Target)
    try {
        $shim = Join-Path $InstallDir "$AliasName.cmd"
        Set-Content -Path $shim -Value "@echo off`r`n`"$Target`" %*" -Encoding ASCII
        Write-Host "OK  linked '$AliasName' -> $BinName" -ForegroundColor Green
    } catch {
        Write-Host "!  could not create '$AliasName' shim (launch with '$BinName')" -ForegroundColor Yellow
    }
}

# Split a raw PATH string into its entries, dropping empties. An empty entry in
# Windows PATH means "current directory", which is clutter and a hazard, so we
# never emit one.
function Split-PathEntries {
    param([string]$Raw)
    if ([string]::IsNullOrEmpty($Raw)) { return @() }
    return @($Raw -split ';' | Where-Object { $_ -ne '' })
}

# True when $Dir is already a distinct entry of $Raw. A substring test is wrong:
# "C:\a\bin" is a substring of "C:\a\bin2" and of "C:\a\bin;..." with wildcard
# metacharacters, so a naive -like falsely reports the dir is present (or absent)
# and either skips a needed add or double-adds. Compare whole entries, trimmed of
# a trailing separator, case-insensitively (Windows paths are case-insensitive).
function Test-PathContainsDir {
    param([string]$Raw, [string]$Dir)
    $target = $Dir.TrimEnd('\')
    foreach ($entry in (Split-PathEntries $Raw)) {
        if ($entry.TrimEnd('\') -ieq $target) { return $true }
    }
    return $false
}

# Pure: return $Raw with $Dir appended as a distinct entry, or $Raw unchanged
# when $Dir is already present. Never introduces a leading/duplicate ';' (a null
# or empty existing PATH used to yield ";C:\...\bin", i.e. an empty "current
# directory" entry). Extracted so it can be unit-tested without touching the
# machine's real environment.
function Get-PathWithDir {
    param([string]$Raw, [string]$Dir)
    if (Test-PathContainsDir $Raw $Dir) { return $Raw }
    return ((@(Split-PathEntries $Raw) + $Dir) -join ';')
}

# Add the install dir to the user PATH if it is not already there. Returns $true
# when a new entry was added (so the caller can tell the user to restart).
function Add-ToPath {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not (Test-PathContainsDir $UserPath $InstallDir)) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", (Get-PathWithDir $UserPath $InstallDir), "User")
        $env:Path = Get-PathWithDir $env:Path $InstallDir
        return $true
    }
    return $false
}

# Post-install self-check: prove the thing actually runs. Fails loud (throws) if
# the installed command cannot report its version.
function Invoke-Doctor {
    param([string]$Command)
    Write-Host ""
    Write-Host "doctor:"
    $ver = $null
    try {
        $ver = & $Command --version 2>$null
    } catch {
        $ver = $null
    }
    if ($LASTEXITCODE -eq 0 -and $ver) {
        Write-Host "OK  $BinName runs - $ver" -ForegroundColor Green
    } else {
        throw "$BinName did not run after install ('$Command --version' failed)"
    }
}

# Veyyon's packages resolve one another through Bun workspace and catalog
# protocols, which only work inside a full checkout. A source install therefore
# keeps a real clone under $SrcDir, installs the workspace once, and points a
# veyyon.cmd shim at the committed launcher (packages\coding-agent\scripts\veyyon.cmd).
# The launcher runs straight from TypeScript, so there is no build step; -Ref
# pins a tag, branch, or commit.
# A stamp unique enough that two installer runs in the same second do not collide
# on a backup branch/dir name ($PID disambiguates).
function Get-BackupStamp {
    return "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PID"
}

# Commit any uncommitted local edits in a source checkout onto a durable backup
# branch BEFORE the update resets over them. The update path runs
# `git reset --hard origin/<ref>`, which would otherwise silently discard a
# user's local edits to a tracked file (this is how an edited ~/.veyyon/src
# AGENTS.md kept vanishing on every update). Uses `git commit-tree` so the backup
# commit is built from the staged tree without moving HEAD, leaving the checkout
# exactly as it was for the reset that follows. `git add -A` honors .gitignore, so
# build artifacts are not swept in. Returns $true on success or when there is
# nothing to preserve; $false if preservation cannot complete, so the caller can
# refuse to reset rather than risk destroying the changes (fail closed).
function Preserve-LocalSrcChanges {
    param([string]$Src = $SrcDir)
    if (-not (Test-Path (Join-Path $Src ".git"))) { return $true }
    Push-Location $Src
    try {
        $status = git status --porcelain 2>$null
        if ([string]::IsNullOrWhiteSpace(($status -join "`n"))) { return $true }
        $stamp = Get-BackupStamp
        $branch = "veyyon-local-$stamp"
        git add -A 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }
        $tree = (git write-tree 2>$null)
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tree)) { return $false }
        $parent = (git rev-parse -q --verify HEAD 2>$null)
        $msg = "veyyon: preserve local changes before update ($stamp)"
        if ($parent) {
            $commit = (git -c user.name=veyyon-installer -c user.email=installer@veyyon.dev commit-tree $tree -p $parent -m $msg 2>$null)
        } else {
            $commit = (git -c user.name=veyyon-installer -c user.email=installer@veyyon.dev commit-tree $tree -m $msg 2>$null)
        }
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commit)) { return $false }
        git branch $branch $commit 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $false }
        Write-Host "preserved your local changes on branch '$branch'" -ForegroundColor Yellow
        Write-Host "recover them with: git -C $Src checkout $branch" -ForegroundColor Yellow
        return $true
    } finally {
        Pop-Location
    }
}

# Move an existing tree aside instead of deleting it. The clone path used to
# `Remove-Item -Recurse -Force $SrcDir` before cloning, which destroys any files a
# user put there (or a partial/corrupt checkout with no .git). Moving to
# `<dir>.bak-<stamp>` preserves everything and lets the fresh clone proceed. An
# empty directory is simply removed. Fail closed: if the move cannot happen, throw
# rather than fall back to a destructive delete.
function Move-AsideExistingSrc {
    param([string]$Src = $SrcDir)
    if (-not (Test-Path $Src)) { return }
    if ((Test-Path $Src -PathType Container) -and -not (Get-ChildItem -Force -Path $Src -ErrorAction SilentlyContinue)) {
        Remove-Item -Recurse -Force $Src -ErrorAction SilentlyContinue
        return
    }
    $stamp = Get-BackupStamp
    $backup = "$Src.bak-$stamp"
    Move-Item -Path $Src -Destination $backup -ErrorAction Stop
    Write-Host "moved existing $Src aside to $backup (nothing was deleted)" -ForegroundColor Yellow
}

# Whether a source checkout holds work the installer did not create and must not
# delete on uninstall: uncommitted edits, commits on a local branch that live on
# no remote (this includes `veyyon-local-*` preservation branches, so a preserved
# AGENTS.md is never silently deleted by -Uninstall), or a non-git but non-empty
# tree. $false means the tree is pristine and safe to remove outright.
function Test-SrcHasLocalWork {
    param([string]$Src = $SrcDir)
    if (-not (Test-Path $Src -PathType Container)) { return $false }
    if (-not (Test-Path (Join-Path $Src ".git"))) {
        return [bool](Get-ChildItem -Force -Path $Src -ErrorAction SilentlyContinue)
    }
    Push-Location $Src
    try {
        $status = git status --porcelain 2>$null
        if (-not [string]::IsNullOrWhiteSpace(($status -join "`n"))) { return $true }
        $unpushed = git log --branches --not --remotes --oneline 2>$null
        if (-not [string]::IsNullOrWhiteSpace(($unpushed -join "`n"))) { return $true }
        return $false
    } finally {
        Pop-Location
    }
}

function Fetch-SourceTree {
    if (Test-Path (Join-Path $SrcDir ".git")) {
        Write-Host "Updating veyyon source in $SrcDir..."
        # Commit local edits to a backup branch before resetting. If that fails,
        # refuse the update rather than destroy uncommitted work.
        if (-not (Preserve-LocalSrcChanges $SrcDir)) {
            throw "refusing to update: could not preserve local changes in $SrcDir"
        }
        Push-Location $SrcDir
        try {
            git fetch --tags --force origin
            if ($LASTEXITCODE -ne 0) { throw "failed to update $SrcDir" }
            $ref = $Ref
            if (-not $ref) {
                $remoteHead = (git remote show origin 2>$null | Select-String 'HEAD branch:')
                if ($remoteHead) { $ref = ($remoteHead -replace '.*HEAD branch:\s*', '').Trim() }
                if (-not $ref) { $ref = "main" }
            }
            git checkout --force $ref
            if ($LASTEXITCODE -ne 0) { throw "failed to check out '$ref' in $SrcDir" }
            git reset --hard "origin/$ref" 2>$null
            if ($LASTEXITCODE -ne 0) { git reset --hard $ref | Out-Null }
        } finally {
            Pop-Location
        }
    } else {
        Write-Host "Cloning veyyon source into $SrcDir..."
        $parent = Split-Path -Parent $SrcDir
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        # Never rm -rf an existing tree: move it aside so nothing is lost.
        Move-AsideExistingSrc $SrcDir
        if ($Ref) {
            git clone --depth 1 --branch $Ref $RepoUrl $SrcDir 2>$null
            if ($LASTEXITCODE -ne 0) {
                git clone $RepoUrl $SrcDir
                if ($LASTEXITCODE -ne 0) { throw "failed to clone $RepoUrl" }
                Push-Location $SrcDir
                try {
                    git checkout $Ref
                    if ($LASTEXITCODE -ne 0) { throw "ref not found: $Ref" }
                } finally { Pop-Location }
            }
        } else {
            git clone --depth 1 $RepoUrl $SrcDir 2>$null
            if ($LASTEXITCODE -ne 0) {
                git clone $RepoUrl $SrcDir
                if ($LASTEXITCODE -ne 0) { throw "failed to clone $RepoUrl" }
            }
        }
    }

    if (Test-GitLfsInstalled) {
        Push-Location $SrcDir
        try { git lfs pull | Out-Null } finally { Pop-Location }
    }
}

function Install-FromSource {
    if (-not (Test-GitInstalled)) {
        throw "git is required to install veyyon from source"
    }
    Write-Host "Installing veyyon from source (bun)..."
    Fetch-SourceTree

    $pkgDir = Join-Path $SrcDir "packages\coding-agent"
    if (-not (Test-Path $pkgDir)) {
        throw "expected package at $pkgDir"
    }
    $launcher = Join-Path $pkgDir "scripts\veyyon.cmd"
    if (-not (Test-Path $launcher)) {
        throw "source launcher not found: $launcher"
    }

    Write-Host "Installing workspace dependencies (bun install)..."
    Push-Location $SrcDir
    try {
        bun install
        if ($LASTEXITCODE -ne 0) { throw "failed to install workspace dependencies" }
    } finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Shim in the install dir that forwards to the committed launcher (the
    # Windows analogue of the Unix symlink into the source tree).
    $shim = Join-Path $InstallDir "$BinName.cmd"
    Set-Content -Path $shim -Value "@echo off`r`n`"$launcher`" %*" -Encoding ASCII
    Write-Host "OK  installed $BinName (source) -> $launcher" -ForegroundColor Green

    Install-Alias -Target $shim
    $needsRestart = Add-ToPath
    Configure-BashShell
    Invoke-Doctor -Command $shim

    Write-Host ""
    if ($needsRestart) {
        Write-Host "Restart your terminal, then run '$BinName' (or '$AliasName') to get started!"
    } else {
        Write-Host "Run '$BinName' (or '$AliasName') to get started!"
    }
}

# Parse a `.sha256` sidecar body ("<hex>  <filename>") into the lowercased hash.
# Returns $null when the body is empty or has no leading token, so the caller can
# fail closed rather than compare against an empty expected value. Splits on any
# whitespace (matches the POSIX installer's `awk '{print $1}'`).
function ConvertFrom-Sha256Sidecar {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $token = ($Text.Trim() -split '\s+')[0]
    if ([string]::IsNullOrWhiteSpace($token)) { return $null }
    return $token.ToLower()
}

# Compute the SHA-256 of a file and compare it, case-insensitively, to $Expected.
# Returns $true only on an exact match (fail closed on empty/mismatch).
function Test-FileSha256 {
    param([string]$Path, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Expected)) { return $false }
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
    return ($actual -eq $Expected.ToLower())
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Ref" -TimeoutSec 60
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
    } else {
        Write-Host "Fetching latest release..."
        $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -TimeoutSec 60
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary. A mid-stream failure (network drop, timeout) leaves a
    # partial file behind, so remove it before rethrowing — the install must never
    # leave a truncated veyyon.exe in place (mirrors install.sh's EXIT/INT/TERM
    # trap on its temp download). A same-run partial that still completes the
    # request is caught afterwards by the checksum verification below.
    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryAsset"
    Write-Host "Downloading $BinaryAsset..."
    $OutPath = Join-Path $InstallDir "$BinName.exe"
    try {
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $OutPath -TimeoutSec 900
    } catch {
        Remove-Item $OutPath -ErrorAction SilentlyContinue
        throw "download failed ($BinaryAsset not published for this release, or the connection dropped) - try -Source. ($_)"
    }

    # Verify checksum against the release's .sha256 sidecar. Fail closed: a
    # missing or unparseable sidecar refuses the install unless -NoVerify is
    # passed (only needed for old pre-sidecar releases).
    if ($NoVerify) {
        Write-Host "!  checksum verification skipped (-NoVerify)" -ForegroundColor Yellow
    } else {
        $expected = $null
        try {
            $expected = ConvertFrom-Sha256Sidecar (Invoke-RestMethod -Uri "$BinaryUrl.sha256" -TimeoutSec 30)
        } catch {
            Remove-Item $OutPath -ErrorAction SilentlyContinue
            throw "no published checksum for $BinaryAsset ($Latest) - refusing to install unverified. Current releases publish .sha256 sidecars; for an old pre-sidecar release, pass -NoVerify to override."
        }
        if (-not $expected) {
            Remove-Item $OutPath -ErrorAction SilentlyContinue
            throw "published checksum for $BinaryAsset is empty/unparseable - refusing to install (pass -NoVerify to override)"
        }
        if (-not (Test-FileSha256 -Path $OutPath -Expected $expected)) {
            $actual = (Get-FileHash -Path $OutPath -Algorithm SHA256).Hash.ToLower()
            Remove-Item $OutPath -ErrorAction SilentlyContinue
            throw "checksum mismatch for $BinaryAsset (expected $expected, got $actual)"
        }
        Write-Host "OK  checksum verified" -ForegroundColor Green
    }

    Install-Alias -Target $OutPath

    Write-Host ""
    Write-Host "OK  Installed veyyon to $OutPath" -ForegroundColor Green

    $needsRestart = Add-ToPath
    Configure-BashShell
    Invoke-Doctor -Command $OutPath

    Write-Host ""
    if ($needsRestart) {
        Write-Host "Restart your terminal, then run '$BinName' (or '$AliasName') to get started!"
    } else {
        Write-Host "Run '$BinName' (or '$AliasName') to get started!"
    }
}

function Uninstall-Veyyon {
    $removed = $false
    foreach ($f in @("$BinName.exe", "$BinName.cmd", "$AliasName.cmd")) {
        $p = Join-Path $InstallDir $f
        if (Test-Path $p) {
            Remove-Item -Force $p
            Write-Host "OK  removed $p" -ForegroundColor Green
            $removed = $true
        }
    }
    if (Test-BunInstalled) {
        bun remove -g $Package 2>$null | Out-Null
    }
    if (Test-Path $SrcDir) {
        # Never delete a checkout that holds uncommitted edits or unpushed local
        # branches (e.g. a veyyon-local-* preservation branch carrying the user's
        # AGENTS.md). Move it aside so uninstall can never destroy work the
        # installer did not create; only a pristine tree is deleted outright.
        if (Test-SrcHasLocalWork $SrcDir) {
            Move-AsideExistingSrc $SrcDir
        } else {
            Remove-Item -Recurse -Force $SrcDir
            Write-Host "OK  removed source checkout $SrcDir" -ForegroundColor Green
        }
        $removed = $true
    }
    if ($removed) {
        Write-Host "veyyon uninstalled."
    } else {
        Write-Host "nothing to uninstall."
    }
}

# Main logic. Guarded so the test harness can dot-source this file to exercise
# the helper functions in isolation without running a real install: set
# $env:VEYYON_INSTALL_SOURCED=1 before sourcing (mirrors install.sh).
if (-not $env:VEYYON_INSTALL_SOURCED) {
    if ($Uninstall) {
        Uninstall-Veyyon
        return
    }

    # Default to source when a ref is pinned.
    if ($Ref -and -not $Source -and -not $Binary) {
        $Source = $true
    }

    if ($Source) {
        if (-not (Test-BunInstalled)) {
            Write-Host "Installing bun..."
            irm bun.sh/install.ps1 | iex
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        }
        Assert-BunVersion $MinimumBunVersion
        Install-FromSource
    } else {
        Install-Binary
    }
}
