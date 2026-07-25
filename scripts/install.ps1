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
#
# -Local installs the binary this checkout has already built
# (packages\coding-agent\dist\vey.exe) instead of downloading a release. It is
# the Windows counterpart of install.sh's --local, and it is what lets the real
# installer be driven end to end without a published release: everything after
# the binary is placed (the alias shim, the PATH entry, completions, the doctor
# self-test, and uninstall reclaiming all of it) is the same code the download
# path runs.

param(
    [switch]$Source,
    [switch]$Binary,
    [switch]$Local,
    [string]$Ref,
    [switch]$NoVerify,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$Repo = "santhreal/veyyon"
$RepoUrl = "https://github.com/$Repo.git"
$InstallDir = if ($env:VEYYON_INSTALL_DIR) { $env:VEYYON_INSTALL_DIR } else { "$env:LOCALAPPDATA\veyyon" }
$SrcDir = if ($env:VEYYON_SRC_DIR) { $env:VEYYON_SRC_DIR } else { "$env:USERPROFILE\.veyyon\src" }
$BinName = "veyyon"
$AliasName = "vey"
$BinaryAsset = "veyyon-windows-x64.exe"
$MinimumBunVersion = "1.3.14"
# Whether the `vey` shim next to the binary is one THIS installer owns.
#
# One owner: Install-Alias makes the call (it is the only code that inspects and
# writes the shim) and records it here; Install-Completions reads it rather than
# re-deriving. Mirrors ALIAS_IS_OURS in install.sh. Starts false, so nothing
# assumes an ownership it has not checked.
$Script:AliasIsOurs = $false

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

# The first path this checkout tracks through Git LFS, or $null when it tracks
# none. `:(attr:filter=lfs)` is git's own pathspec magic (git >= 2.18) and needs
# no git-lfs installed, so it answers the question on the very machine that is
# missing the tool. Returns the string 'unknown' when git could not answer: the
# caller must treat that as UNKNOWN, never as "no".
function Get-LfsTrackedFile {
    param([Parameter(Mandatory = $true)][string]$SrcDir)
    Push-Location $SrcDir
    try {
        $out = git ls-files ':(attr:filter=lfs)' 2>$null
        if ($LASTEXITCODE -ne 0) { return 'unknown' }
        if ($null -eq $out) { return $null }
        return (@($out) | Where-Object { $_ -ne '' } | Select-Object -First 1)
    } finally {
        Pop-Location
    }
}

# Materialize Git LFS content in a source checkout.
#
# This used to be `if (Test-GitLfsInstalled) { git lfs pull | Out-Null }`, whose
# every failure mode is silent: with git-lfs missing the pull never runs, and
# with it present a failing pull was swallowed by Out-Null and an unchecked
# $LASTEXITCODE. Either way every LFS-tracked file stays a ~130-byte pointer
# TEXT file, the install reports success, and veyyon fails later on a file that
# looks present. .gitattributes puts *.wasm under LFS, so this is live the
# moment a wasm asset lands. Mirrors fetch_lfs_assets in install.sh.
function Get-LfsAssets {
    param([Parameter(Mandatory = $true)][string]$SrcDir)
    $tracked = Get-LfsTrackedFile -SrcDir $SrcDir
    if ($tracked -eq 'unknown') {
        # git is too old to answer. Fall back to the declaration in
        # .gitattributes: conservative, and loud about why. Never assume "no
        # LFS" from a check that did not run.
        $attrs = Join-Path $SrcDir '.gitattributes'
        if (-not (Test-Path $attrs)) { return }
        if (-not (Select-String -Path $attrs -Pattern 'filter=lfs' -Quiet)) { return }
        Write-Host "  !!  this git cannot list LFS-tracked paths; assuming .gitattributes' LFS declaration applies"
    } elseif ([string]::IsNullOrEmpty($tracked)) {
        return
    }
    if (-not (Test-GitLfsInstalled)) {
        throw "this checkout tracks files with Git LFS but git-lfs is not installed - those files would be left as pointer text and veyyon would fail at runtime. Install git-lfs (https://git-lfs.com), then re-run this installer"
    }
    Write-Host "Fetching Git LFS assets..."
    Push-Location $SrcDir
    try {
        git lfs pull | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "git lfs pull failed in $SrcDir - LFS-tracked files are still pointer text. Fix the network/credential problem and re-run this installer"
        }
    } finally {
        Pop-Location
    }
}

# The bun installer, fetched over an EXPLICIT https URL and checked before it is
# executed.
#
# This was `irm bun.sh/install.ps1 | iex`. A URL with no scheme is not a URL:
# PowerShell fills in `http://`, so the first request for a script that is about
# to be executed went out in plaintext and depended on bun.sh's redirect to get
# back to TLS — which is exactly the request an attacker on the path would
# answer themselves. Nothing checked the body either, so an empty or truncated
# response was piped into iex as a silent no-op "install".
function Install-Bun {
    $url = "https://bun.sh/install.ps1"
    try {
        $script = Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 120
    } catch {
        throw "could not download the bun installer from $url ($($_.Exception.Message)) - check your network, or install bun yourself (https://bun.sh) and re-run this installer"
    }
    if ([string]::IsNullOrWhiteSpace($script)) {
        throw "the bun installer downloaded empty from $url - retry, or install bun yourself (https://bun.sh) and re-run this installer"
    }
    Invoke-Expression $script
}

# Put a verified download in place of the installed binary, without ever leaving
# the user with neither.
#
# Windows keeps a running executable's image locked, so overwriting or deleting
# it fails while a session is open. Renaming it is permitted, so the previous
# binary is moved aside first and the staged one renamed into the freed path;
# if that second step fails the old one is put straight back. The moved-aside
# copy cannot be deleted while it is still mapped, so it is swept on the next
# run instead of failing an otherwise-good install.
function Move-StagedBinaryIntoPlace {
    param([string]$StagingPath, [string]$TargetPath)
    # Refuse a zero-byte staged file, exactly as install.sh's finalize_binary
    # does. Invoke-WebRequest writes the file before it knows the body is empty,
    # and with -NoVerify no checksum runs, so without this an empty asset
    # installed cleanly and the user got a veyyon that could not start. The
    # staged file is removed rather than left for the caller to sweep, because
    # this function owns it from here on.
    $staged = Get-Item -LiteralPath $StagingPath -ErrorAction SilentlyContinue
    if (-not $staged -or $staged.Length -eq 0) {
        Remove-Item $StagingPath -Force -ErrorAction SilentlyContinue
        throw "the binary staged at $StagingPath is empty - refusing to install; the download did not complete, retry or use -Source"
    }
    if (-not (Test-Path $TargetPath)) {
        Move-Item -Path $StagingPath -Destination $TargetPath -Force
        return
    }
    $asideName = "$([System.IO.Path]::GetFileName($TargetPath)).$PID.old"
    $aside = Join-Path ([System.IO.Path]::GetDirectoryName($TargetPath)) $asideName
    Move-Item -Path $TargetPath -Destination $aside -Force
    try {
        Move-Item -Path $StagingPath -Destination $TargetPath -Force
    } catch {
        # Put the working binary back before reporting; a failed install must
        # not be an uninstall.
        Move-Item -Path $aside -Destination $TargetPath -Force
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
        throw "could not replace $TargetPath ($($_.Exception.Message)); your previous $BinName is untouched"
    }
    Remove-Item $aside -ErrorAction SilentlyContinue
}

# Reclaim moved-aside binaries whose owning process has since exited. Deleting
# one that is still mapped fails, which is fine: it is retried next run.
# Remove artifacts a previous install left behind: a moved-aside `.old` binary and
# a staged `.download` that never made it into place.
#
# The `.download` half is why this exists. Nothing survives a killed process, and
# until now only Uninstall-Veyyon ever swept those files, so an install that kept
# being killed accumulated a full copy of the binary (~100 MB) per attempt in the
# user's install directory, hidden, with nothing on screen to explain them. Both
# names carry the writer's $PID, so a file whose process is STILL RUNNING belongs
# to a concurrent installer and is left alone: the pid is in the path precisely so
# two installers cannot truncate each other's download. Every removal is
# announced, because deleting files in a directory the user owns is a visible
# change and not something to do quietly. Mirrors sweep_stale_staging in install.sh.
function Clear-StaleInstallArtifacts {
    param([string]$Dir, [string]$BaseName, [string]$BinName)
    if (-not (Test-Path $Dir)) { return }
    foreach ($leftover in @(Get-ChildItem -Path $Dir -Filter "$BaseName.*.old" -File -ErrorAction SilentlyContinue) +
                          @(Get-ChildItem -Path $Dir -Filter ".$BinName.*.download" -File -Force -ErrorAction SilentlyContinue)) {
        # `<base>.<pid>.old` / `.<bin>.<pid>.download` - the pid is the token
        # before the extension. Anything else was not written by this installer.
        $parts = $leftover.Name.Split('.')
        $pidToken = if ($parts.Length -ge 2) { $parts[$parts.Length - 2] } else { "" }
        $ownerPid = 0
        if (-not [int]::TryParse($pidToken, [ref]$ownerPid)) { continue }
        if ($ownerPid -ne $PID -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
            Write-Host "    leaving $($leftover.FullName) alone - another installer (pid $ownerPid) is using it"
            continue
        }
        Remove-Item $leftover.FullName -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $leftover.FullName)) {
            Write-Host "OK  removed $($leftover.FullName) left by an interrupted install (pid $ownerPid)" -ForegroundColor Green
        }
    }
}

# PATH with $Dir removed, comparing entries the same way Test-PathContainsDir
# does (case-insensitive, trailing backslash ignored). Returns the original
# string when the entry is not present, so the caller can tell nothing changed.
function Get-PathWithoutDir {
    param([string]$Raw, [string]$Dir)
    $want = $Dir.TrimEnd('\')
    $kept = @(Split-PathEntries $Raw | Where-Object { $_.TrimEnd('\') -ine $want })
    return ($kept -join ';')
}

# Take the install dir back out of the user PATH.
#
# Uninstall never did this: every install added the directory and nothing ever
# removed it, so a user who installed and removed veyyon kept a PATH entry
# pointing at a directory veyyon no longer occupies. Only an EXACT entry match
# is removed, so a different directory that merely shares a prefix stays.
function Remove-FromPath {
    # Raw, for the same reason Add-ToPath reads raw: taking our entry back out
    # must not flatten the user's `%VAR%` entries on the way.
    $userPath = (Get-RawUserPath).Value
    if (-not (Test-PathContainsDir $userPath $InstallDir)) { return $false }
    Set-RawUserPath (Get-PathWithoutDir $userPath $InstallDir)
    $env:Path = Get-PathWithoutDir $env:Path $InstallDir
    return $true
}

# ---- PowerShell completions ----
#
# The POSIX installer writes a file each shell autoloads by command name.
# PowerShell has no such directory: completion is registered at runtime by
# Register-ArgumentCompleter, so the generated script has to be dot-sourced from
# the user's profile. Windows users therefore had no tab completion at all until
# this was added.
#
# The dot-source line is written under a marker comment and matched exactly on
# removal, the same contract install.sh uses for its PATH line.
$CompletionMarker = "# added by the veyyon installer"

# The profile that loads in every host (console, ISE, the VS Code terminal),
# rather than the current host's profile alone.
function Get-ProfilePath {
    return $PROFILE.CurrentUserAllHosts
}

function Get-CompletionScriptPath {
    return (Join-Path (Split-Path -Parent (Get-ProfilePath)) "$BinName-completions.ps1")
}

# The exact line the profile must contain. One owner, read by both the install
# and the removal, so the two can never disagree about what to match.
function Get-CompletionSourceLine {
    param([string]$ScriptPath)
    return ". `"$ScriptPath`""
}

# Add the dot-source line to the profile unless it is already there.
function Add-CompletionSourceLine {
    param([string]$ProfilePath, [string]$Line)
    if (Test-Path $ProfilePath) {
        $existing = @(Get-Content -LiteralPath $ProfilePath -ErrorAction SilentlyContinue)
        if ($existing -contains $Line) { return $false }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ProfilePath) | Out-Null
    }
    Add-Content -LiteralPath $ProfilePath -Value @("", $CompletionMarker, $Line)
    return $true
}

# Drop the exact dot-source line, plus the marker comment directly above it.
# Only that pair is touched: a profile is a file the user also edits by hand.
function Remove-CompletionSourceLine {
    param([string]$ProfilePath, [string]$Line)
    if (-not (Test-Path $ProfilePath)) { return $false }
    $lines = @(Get-Content -LiteralPath $ProfilePath -ErrorAction SilentlyContinue)
    if (-not ($lines -contains $Line)) { return $false }
    $kept = New-Object System.Collections.Generic.List[string]
    $pending = $null
    foreach ($l in $lines) {
        if ($l -eq $Line) { $pending = $null; continue }
        if ($null -ne $pending) { $kept.Add($pending) }
        $pending = if ($l -eq $CompletionMarker) { $l } else { $null }
        if ($null -eq $pending) { $kept.Add($l) }
    }
    if ($null -ne $pending) { $kept.Add($pending) }
    # Set-Content truncates before it writes, so a failure partway leaves the
    # user's profile empty with no copy of what was in it. Take one first, and
    # keep it if the rewrite fails (mirrors remove_path_line_from_rc in
    # install.sh, which had exactly this defect).
    $backup = "$ProfilePath.veyyon-uninstall.$PID"
    try {
        Copy-Item -LiteralPath $ProfilePath -Destination $backup -Force
    } catch {
        Write-Host "!!  could not back up $ProfilePath ($($_.Exception.Message)); left it alone" -ForegroundColor Yellow
        return $false
    }
    try {
        Set-Content -LiteralPath $ProfilePath -Value $kept.ToArray()
    } catch {
        Write-Host "!!  could not rewrite $ProfilePath ($($_.Exception.Message)); its previous contents are in $backup" -ForegroundColor Yellow
        Write-Host "    restore it with: Copy-Item '$backup' '$ProfilePath'" -ForegroundColor Yellow
        return $false
    }
    Remove-Item -Force $backup -ErrorAction SilentlyContinue
    return $true
}

# Generate the completion script from the binary just installed and wire it into
# the profile. Best effort and loud: a build without the `completions` command,
# or a profile that cannot be written, is reported rather than silently skipped.
function Install-Completions {
    param([string]$BinPath)
    $scriptPath = Get-CompletionScriptPath
    # The generated script registers the completer for the alias as well as the
    # binary, so an alias this installer declined to create would still get OUR
    # subcommands completing THEIR tool. Ask the binary not to bind it.
    if ($Script:AliasIsOurs) {
        $generated = & $BinPath completions powershell 2>$null
    } else {
        $generated = & $BinPath completions powershell --no-alias 2>$null
    }
    if ($LASTEXITCODE -ne 0 -or -not $generated) {
        Write-Host "!!  could not generate PowerShell completions (tab completion unavailable)" -ForegroundColor Yellow
        return
    }
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $scriptPath) | Out-Null
        # Write through a temp file: the profile dot-sources this at every shell
        # start, and a half-written script would break every new session.
        $staging = "$scriptPath.$PID.new"
        Set-Content -LiteralPath $staging -Value $generated
        Move-Item -LiteralPath $staging -Destination $scriptPath -Force
    } catch {
        Write-Host "!!  could not write $scriptPath ($($_.Exception.Message)); tab completion unavailable" -ForegroundColor Yellow
        return
    }
    Write-Host "OK  installed PowerShell completions to $scriptPath" -ForegroundColor Green
    try {
        if (Add-CompletionSourceLine -ProfilePath (Get-ProfilePath) -Line (Get-CompletionSourceLine $scriptPath)) {
            Write-Host "OK  added the completion line to $(Get-ProfilePath)" -ForegroundColor Green
        }
    } catch {
        Write-Host "!!  could not update $(Get-ProfilePath) ($($_.Exception.Message)); add  . `"$scriptPath`"  yourself" -ForegroundColor Yellow
    }
}

# Take back exactly what Install-Completions wrote.
function Remove-Completions {
    $removed = $false
    $scriptPath = Get-CompletionScriptPath
    if (Remove-CompletionSourceLine -ProfilePath (Get-ProfilePath) -Line (Get-CompletionSourceLine $scriptPath)) {
        Write-Host "OK  removed the completion line from $(Get-ProfilePath)" -ForegroundColor Green
        $removed = $true
    }
    if (Test-Path $scriptPath) {
        Remove-Item -Force $scriptPath
        Write-Host "OK  removed $scriptPath" -ForegroundColor Green
        $removed = $true
    }
    return $removed
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
# Whether a `vey.cmd` is a shim THIS installer wrote: one that forwards to the
# binary beside it. Install-Alias only ever writes that form and refuses to
# overwrite anything else, so anything else is the user's own command.
#
# Matched on the forwarded path rather than on the whole file, so a shim written
# by an older installer version (different header, same target) is still
# recognized as ours instead of being orphaned on the user's PATH forever.
function Test-AliasShimIsOurs {
    param([string]$ShimPath, [string]$BinDir)
    $body = Get-Content -Raw -LiteralPath $ShimPath -ErrorAction SilentlyContinue
    if (-not $body) { return $false }
    foreach ($target in @((Join-Path $BinDir "$BinName.exe"), (Join-Path $BinDir "$BinName.cmd"))) {
        if ($body.Contains($target)) { return $true }
    }
    return $false
}

function Install-Alias {
    param([string]$Target)
    $Script:AliasIsOurs = $false
    try {
        $shim = Join-Path $InstallDir "$AliasName.cmd"
        $wanted = "@echo off`r`n`"$Target`" %*"
        # Set-Content overwrote whatever was at the alias path, so a user's own
        # vey.cmd was silently destroyed. Only rewrite a shim this installer
        # could have written — one that already forwards to our binary (mirrors
        # link_alias in install.sh).
        if (Test-Path $shim) {
            $existing = (Get-Content -Raw -Path $shim -ErrorAction SilentlyContinue)
            if ($existing -and $existing.Trim() -eq $wanted.Trim()) {
                $Script:AliasIsOurs = $true
                Write-Host "OK  '$AliasName' already points at $BinName" -ForegroundColor Green
                return
            }
            if (-not ($existing -and $existing.Contains($Target))) {
                Write-Host "!  left '$AliasName' alone: $shim already exists and was not created by this installer. Remove it yourself if you want '$AliasName' to launch $BinName; meanwhile launch with '$BinName'." -ForegroundColor Yellow
                return
            }
        }
        Set-Content -Path $shim -Value $wanted -Encoding ASCII
        $Script:AliasIsOurs = $true
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
# PATH with $Dir at the FRONT, or unchanged when it is already an entry.
#
# It used to append. PATH order decides which copy of a name actually runs, so
# appending put the fresh install behind every older veyyon already on PATH (a
# previous manual copy, a leftover from another install location) — which meant
# the installer created the shadowing it then warned about in its own doctor
# step, on every single install. install.sh has always prepended
# (`export PATH="$dir:$PATH"`); this is the same rule.
function Get-PathWithDir {
    param([string]$Raw, [string]$Dir)
    if (Test-PathContainsDir $Raw $Dir) { return $Raw }
    return ((@($Dir) + @(Split-PathEntries $Raw)) -join ';')
}

# ---- reading and writing the user PATH without flattening it ----
#
# WHY THIS IS NOT [Environment]::GetEnvironmentVariable/SetEnvironmentVariable.
# The user PATH in HKCU\Environment is normally REG_EXPAND_SZ, which is what lets
# a person write `%JAVA_HOME%\bin` and have it follow the variable. The .NET
# accessors do not preserve that: the getter EXPANDS the value, and the setter
# writes a plain REG_SZ. Reading and writing that pair therefore froze every
# `%VAR%` entry in the user's PATH to whatever it happened to expand to at
# install time, permanently, and nothing on screen said so. Installing veyyon
# damaged an environment veyyon does not own.
#
# So the raw value is read with DoNotExpandEnvironmentNames and written back with
# the kind it already had.

# The registry kind to write, given the kind the value already has (or $null when
# there is no value yet) and the string about to be stored. Pure, so the decision
# is testable without a registry.
function Resolve-PathValueKind {
    param([object]$ExistingKind, [string]$Value)
    # Preserve what is there. A REG_SZ that happens to contain a literal `%FOO%`
    # is not a mistake to correct: Windows will not expand it, and silently
    # promoting it would change how that entry resolves.
    if ($null -ne $ExistingKind -and "$ExistingKind" -ne "Unknown" -and "$ExistingKind" -ne "None") {
        return $ExistingKind
    }
    # No value yet. Windows creates the user PATH as REG_EXPAND_SZ, so match it:
    # anything the user adds later that references a variable will then work.
    return [Microsoft.Win32.RegistryValueKind]::ExpandString
}

# The user PATH exactly as stored, with `%VAR%` tokens intact, plus the kind it
# is stored under. Returns an empty value and a $null kind when the key or the
# value does not exist yet (a fresh profile).
function Get-RawUserPath {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
    if ($null -eq $key) { return @{ Value = ""; Kind = $null } }
    try {
        $value = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) { return @{ Value = ""; Kind = $null } }
        $kind = $null
        try { $kind = $key.GetValueKind("Path") } catch { $kind = $null }
        return @{ Value = [string]$value; Kind = $kind }
    } finally {
        $key.Dispose()
    }
}

# Tell the running desktop that the environment changed.
#
# SetEnvironmentVariable did this for us; a raw registry write does not, so an
# already-open Explorer or terminal would keep the old PATH until the next
# logon. Best effort and LOUD: if the broadcast cannot be made, the PATH edit
# still succeeded and the only cost is that a new terminal is needed, which is
# said out loud rather than assumed.
function Publish-EnvironmentChange {
    try {
        if (-not ("VeyyonEnvBroadcast" -as [type])) {
            Add-Type -Namespace "" -Name "VeyyonEnvBroadcast" -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
"@
        }
        $HWND_BROADCAST = [System.IntPtr]0xffff
        $WM_SETTINGCHANGE = 0x1a
        $SMTO_ABORTIFHUNG = 0x2
        $result = [System.UIntPtr]::Zero
        [void][VeyyonEnvBroadcast]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [System.UIntPtr]::Zero, "Environment", $SMTO_ABORTIFHUNG, 5000, [ref]$result)
    } catch {
        Write-Host "!  could not announce the PATH change to running programs ($($_.Exception.Message)); open a new terminal to pick it up" -ForegroundColor Yellow
    }
}

# Store the user PATH, keeping the kind it already had.
function Set-RawUserPath {
    param([string]$Value)
    $current = Get-RawUserPath
    $kind = Resolve-PathValueKind -ExistingKind $current.Kind -Value $Value
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try {
        $key.SetValue("Path", $Value, $kind)
    } finally {
        $key.Dispose()
    }
    Publish-EnvironmentChange
}

# Add the install dir to the user PATH if it is not already there. Returns $true
# when a new entry was added (so the caller can tell the user to restart).
function Add-ToPath {
    $UserPath = (Get-RawUserPath).Value
    if (-not (Test-PathContainsDir $UserPath $InstallDir)) {
        Write-Host "Adding $InstallDir to PATH..."
        Set-RawUserPath (Get-PathWithDir $UserPath $InstallDir)
        $env:Path = Get-PathWithDir $env:Path $InstallDir
        return $true
    }
    return $false
}

# Post-install self-check: prove the thing actually runs. Fails loud (throws) if
# the installed command cannot report its version.
function ConvertFrom-VersionOutput {
    # Pull the semver out of a --version line ("veyyon/1.0.37" -> "1.0.37").
    # Returns $null when the line carries no x.y.z token, so a format change is
    # visible as a failed check rather than a silent pass (mirrors
    # version_from_output in install.sh).
    param([string]$Text)
    if (-not $Text) { return $null }
    foreach ($tok in ($Text -split '\s+')) {
        $cand = $tok -replace '^.*/', ''
        if ($cand -match '^\d+\.\d+\.\d+') { return $cand }
    }
    return $null
}

# Prove the native addon loads, not just that the binary starts. Mirrors
# doctor_natives in install.sh.
#
# --version is served entirely by the JS entry point, so it succeeds on an
# install whose native addon is missing or was staged for the wrong
# architecture. The user then gets a clean "veyyon runs" and a failure on their
# first real command. `grep` is the cheapest command that goes through the
# native walker and returns a result worth checking, against a file this
# function writes and knows the contents of.
# $Phase names the run, because this happens twice on a binary install and the
# two runs answer different questions. The first is a PREFLIGHT on the staged
# download: it throws before the binary is moved into place, before the alias,
# the PATH edit and the completion script, so a release with no build for this
# architecture leaves the machine exactly as it was. The second proves the
# finished install works from where it now lives. Mirrors install.sh's
# doctor_natives $2.
function Test-NativeAddon {
    param([string]$Command, [string]$Phase = "installed")
    # An older build with no `grep` subcommand is not a broken install.
    & $Command grep --help *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "!!  this build has no 'grep' command - skipping the native addon self-test" -ForegroundColor Yellow
        return
    }
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-doctor.$PID"
    try {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Set-Content -LiteralPath (Join-Path $dir "probe.txt") -Value "veyyon-native-self-test"
    } catch {
        Write-Host "!!  could not stage $dir - skipping the native addon self-test" -ForegroundColor Yellow
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
        return
    }
    try {
        $out = (& $Command grep veyyon-native-self-test $dir 2>&1 | Out-String)
        $status = $LASTEXITCODE
    } finally {
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    }
    if ($status -ne 0) {
        throw "the $Phase $BinName starts but cannot run a search: '$BinName grep' exited $status. The native addon did not load, which usually means the release has no build for this architecture. Install from source instead: & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Source. Output was: $out"
    }
    # Exit 0 is not enough on its own: a walker that returns nothing exits 0 too.
    if ($out -notmatch 'probe\.txt') {
        throw "$BinName ran a search but did not find a file it was pointed at. The install is not usable. Output was: $out"
    }
    Write-Host "OK  native addon loads ($Phase) - search returned the expected match" -ForegroundColor Green
}

function Invoke-Doctor {
    param([string]$Command, [string]$ExpectedTag)
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
    # The checksum proved the bytes match the published asset; this proves the
    # published asset is the version the release claims. A release that uploaded
    # a mismatched binary, or a stale cached download, otherwise installs
    # "successfully" and silently runs the wrong version forever.
    if ($ExpectedTag) {
        $want = $ExpectedTag -replace '^v', ''
        $got = ConvertFrom-VersionOutput -Text ([string]$ver)
        if (-not $got) {
            throw "could not read a version from '$Command --version' output: $ver"
        }
        if ($got -eq $want) {
            Write-Host "OK  reported version matches the $ExpectedTag release" -ForegroundColor Green
        } else {
            throw "installed $BinName reports $got but the $ExpectedTag release was requested - the release may have published a mismatched binary. The file at $Command is NOT the version you asked for; re-run the installer or pin with -Ref."
        }
    }
    Test-NativeAddon -Command $Command
    # Both names the user might type must reach the copy just installed (mirrors
    # check_not_shadowed in install.sh).
    $binDir = Split-Path -Parent $Command
    Test-NotShadowed -Name $BinName -WantDir $binDir
    # ...but the alias only when it is ours. If Install-Alias declined because
    # the user already had their own vey.cmd, the shadow check would report that
    # THEIR command shadows "the copy just installed" and tell them to remove it,
    # for an alias this installer deliberately never created. Install-Alias
    # already said the true thing; contradicting it here is worse than silence.
    if (Test-AliasPointsAtUs -BinPath $Command) {
        Test-NotShadowed -Name $AliasName -WantDir $binDir
    } else {
        Write-Host "OK  '$AliasName' is not ours - launch with '$BinName'" -ForegroundColor Green
    }
}

# True when the alias shim next to $BinPath is one we wrote (it forwards to our
# binary). Mirrors alias_points_at_us in install.sh.
function Test-AliasPointsAtUs {
    param([string]$BinPath)
    $shim = Join-Path (Split-Path -Parent $BinPath) "$AliasName.cmd"
    if (-not (Test-Path $shim)) { return $false }
    $existing = (Get-Content -Raw -Path $shim -ErrorAction SilentlyContinue)
    return [bool]($existing -and $existing.Contains($BinPath))
}

# Report whether `$Name` on PATH is the copy just installed into `$WantDir`.
# A stale copy earlier on PATH (a previous `bun add -g`, an old manual install)
# silently wins every future invocation, so mere presence on PATH is not enough:
# the resolved location is compared and a mismatch is reported LOUDLY. Compared
# by directory because the alias shim and the binary are different files in the
# same directory. Not fatal: the binary itself is fine and the user fixes PATH.
function Test-NotShadowed {
    param([string]$Name, [string]$WantDir)
    $found = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found -or -not $found.Source) {
        Write-Host "!!  '$Name' not on PATH yet (open a new terminal, or add $WantDir to PATH)" -ForegroundColor Yellow
        return
    }
    $gotDir = Split-Path -Parent $found.Source
    if ($gotDir -and $WantDir -and ($gotDir.TrimEnd('\') -ieq $WantDir.TrimEnd('\'))) {
        Write-Host "OK  '$Name' on PATH resolves to this install" -ForegroundColor Green
    } else {
        Write-Host "!!  '$Name' on PATH resolves to $($found.Source), NOT the copy just installed in $WantDir - that older copy shadows this one and will keep running instead. Remove it, or put $WantDir earlier in PATH." -ForegroundColor Yellow
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
            # `origin/$ref` is the normal case; a ref with no remote-tracking
            # branch (a tag, a commit passed to -Ref) falls back to the ref
            # itself. The fallback's exit code used to go unchecked, so a
            # checkout that reset to NEITHER carried on to `bun install` and
            # installed the old tree under the new version's name.
            git reset --hard "origin/$ref" 2>$null
            if ($LASTEXITCODE -ne 0) {
                git reset --hard $ref | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "failed to reset $SrcDir to '$ref'" }
            }
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

    Get-LfsAssets -SrcDir $SrcDir
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
        # A fresh clone lacks BOTH gitignored build artifacts, so provision them
        # eagerly here (install.sh --source does the same, in the same order).
        # Without this a Windows source install handed over an incomplete tree:
        # the native addon was missing and the first launch either limped through
        # the launcher self-heal or died at boot.
        Write-Host "Generating tool views (packages/collab-web)..."
        bun --cwd=packages/collab-web run gen:tool-views
        if ($LASTEXITCODE -ne 0) { throw "failed to generate tool views (bun --cwd=packages/collab-web run gen:tool-views)" }
        Write-Host "Ensuring native addon (packages/natives)..."
        bun --cwd=packages/natives run ensure
        if ($LASTEXITCODE -ne 0) { throw "failed to provision the native addon (bun --cwd=packages/natives run ensure)" }
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
    Install-Completions -BinPath $shim
    Invoke-Doctor -Command $shim

    Write-Host ""
    if ($needsRestart) {
        Write-Host "Restart your terminal, then run '$BinName' (or '$AliasName') to get started!"
    } else {
        Write-Host "Run '$BinName' (or '$AliasName') to get started!"
    }
}

# Parse a `.sha256` sidecar body ("<64-hex>  <filename>") into the lowercased hash.
# Returns $null when the body holds no digest, so the caller fails closed rather
# than comparing against something that is not a checksum.
#
# Strict on purpose, and deliberately identical to the TypeScript owner in
# packages/natives/src/sha256-sidecar.ts and to install.sh's
# parse_sha256_sidecar: a token that is not exactly 64 hex characters means the
# response is not a checksum at all (an HTML error page, a rate-limit body, a
# sidecar truncated by a dropped connection). Passing that token through would
# report a checksum mismatch, which tells the user their download is corrupt
# when the download was fine and the sidecar was not.
function ConvertFrom-Sha256Sidecar {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $token = (($Text -split "`n")[0].Trim() -split '\s+')[0]
    if ($token -notmatch '^[0-9a-fA-F]{64}$') { return $null }
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

    $BinaryUrl = "https://github.com/$Repo/releases/download/$Latest/$BinaryAsset"
    Write-Host "Downloading $BinaryAsset..."
    $OutPath = Join-Path $InstallDir "$BinName.exe"
    # Stage the download beside the target and only move it into place once it
    # has been verified (mirrors install.sh's staging_path + finalize_binary).
    #
    # This used to download STRAIGHT ONTO $OutPath, which made every failure
    # destructive: a dropped connection, a missing sidecar, or a checksum
    # mismatch each ran `Remove-Item $OutPath` and left the user with no veyyon
    # at all, having started from a working one. On top of that Windows locks a
    # running image, so upgrading from an open session failed at the download
    # and then tried to delete the binary it could not write. The path is
    # per-process so two installers cannot truncate each other's download.
    Clear-StaleInstallArtifacts -Dir $InstallDir -BaseName "$BinName.exe" -BinName $BinName
    $StagingPath = Join-Path $InstallDir ".$BinName.$PID.download"
    try {
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $StagingPath -TimeoutSec 900
    } catch {
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
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
            Remove-Item $StagingPath -ErrorAction SilentlyContinue
            throw "no published checksum for $BinaryAsset ($Latest) - refusing to install unverified. Current releases publish .sha256 sidecars; for an old pre-sidecar release, pass -NoVerify to override."
        }
        if (-not $expected) {
            Remove-Item $StagingPath -ErrorAction SilentlyContinue
            throw "published checksum for $BinaryAsset is empty/unparseable - refusing to install (pass -NoVerify to override)"
        }
        if (-not (Test-FileSha256 -Path $StagingPath -Expected $expected)) {
            $actual = (Get-FileHash -Path $StagingPath -Algorithm SHA256).Hash.ToLower()
            Remove-Item $StagingPath -ErrorAction SilentlyContinue
            throw "checksum mismatch for $BinaryAsset (expected $expected, got $actual)"
        }
        Write-Host "OK  checksum verified" -ForegroundColor Green
    }

    # Prove the download RUNS before it is allowed to touch anything. The
    # checksum proves the bytes match what was published; it cannot tell you the
    # release has no build for this architecture. Failing here costs a staged
    # file that is removed on the way out.
    try {
        Test-NativeAddon -Command $StagingPath -Phase "downloaded"
    } catch {
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
        throw
    }

    Move-StagedBinaryIntoPlace -StagingPath $StagingPath -TargetPath $OutPath

    Install-Alias -Target $OutPath

    Write-Host ""
    Write-Host "OK  Installed veyyon to $OutPath" -ForegroundColor Green

    $needsRestart = Add-ToPath
    Configure-BashShell
    Install-Completions -BinPath $OutPath
    Invoke-Doctor -Command $OutPath -ExpectedTag $Latest

    Write-Host ""
    if ($needsRestart) {
        Write-Host "Restart your terminal, then run '$BinName' (or '$AliasName') to get started!"
    } else {
        Write-Host "Run '$BinName' (or '$AliasName') to get started!"
    }
}

function Install-LocalBinary {
    # The binary this checkout has already built. Three candidate locations are
    # searched because the installer can be invoked from the repo root or from
    # inside the package, and bun appends .exe on Windows targets while a
    # cross-built artifact may not carry it.
    $candidates = @(
        (Join-Path $PWD "packages\coding-agent\dist\vey.exe"),
        (Join-Path $PWD "packages\coding-agent\dist\vey"),
        (Join-Path $PWD "dist\vey.exe"),
        (Join-Path $PWD "dist\vey")
    )
    $localBin = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $localBin) {
        throw "local compiled binary not found - run 'bun scripts/build-binary.ts' in packages/coding-agent first"
    }
    # Name the one that won: a stale dist\ in the current directory otherwise
    # shadows a fresh package build with nothing on screen to explain which
    # binary was actually installed.
    Write-Host "installing the local build at $localBin"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $OutPath = Join-Path $InstallDir "$BinName.exe"

    # Same staging contract as Install-Binary: nothing touches the existing
    # install until the new file has been proved to run, so a failed local
    # install cannot leave the user with no veyyon at all.
    Clear-StaleInstallArtifacts -Dir $InstallDir -BaseName "$BinName.exe" -BinName $BinName
    $StagingPath = Join-Path $InstallDir ".$BinName.$PID.local"
    try {
        Copy-Item -LiteralPath $localBin -Destination $StagingPath -Force
    } catch {
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
        throw "could not stage $localBin into $InstallDir ($_)"
    }

    try {
        Test-NativeAddon -Command $StagingPath -Phase "local build"
    } catch {
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
        throw
    }

    Move-StagedBinaryIntoPlace -StagingPath $StagingPath -TargetPath $OutPath

    Install-Alias -Target $OutPath

    Write-Host ""
    Write-Host "OK  Installed veyyon to $OutPath" -ForegroundColor Green

    $needsRestart = Add-ToPath
    Configure-BashShell
    Install-Completions -BinPath $OutPath
    # No -ExpectedTag: a local build answers to whatever version the checkout
    # carries, and there is no release to compare it against.
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
    if (Remove-FromPath) {
        Write-Host "OK  removed $InstallDir from your PATH" -ForegroundColor Green
        $removed = $true
    }
    if (Remove-Completions) { $removed = $true }
    # The alias is checked, and the binary is not, because Install-Alias refuses
    # to overwrite a `vey.cmd` the user already has. Uninstall deleted it anyway,
    # so removing veyyon destroyed the user's own command.
    $aliasShim = Join-Path $InstallDir "$AliasName.cmd"
    if (Test-Path $aliasShim) {
        if (Test-AliasShimIsOurs -ShimPath $aliasShim -BinDir $InstallDir) {
            Remove-Item -Force $aliasShim
            Write-Host "OK  removed $aliasShim" -ForegroundColor Green
            $removed = $true
        } else {
            Write-Host "OK  left $aliasShim alone (not created by this installer)" -ForegroundColor Green
        }
    }
    foreach ($f in @("$BinName.exe", "$BinName.cmd")) {
        $p = Join-Path $InstallDir $f
        if (Test-Path $p) {
            Remove-Item -Force $p
            Write-Host "OK  removed $p" -ForegroundColor Green
            $removed = $true
        }
    }
    # Staged downloads and moved-aside previous binaries are ours too. A locked
    # `.old` (still the running image) is left for the next sweep rather than
    # failing the uninstall over a file the OS will release on exit.
    foreach ($leftover in @(Get-ChildItem -Path $InstallDir -Filter "*.old" -File -ErrorAction SilentlyContinue) +
                          @(Get-ChildItem -Path $InstallDir -Filter ".$BinName.*.download" -File -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -Force $leftover.FullName -ErrorAction SilentlyContinue
        if (-not (Test-Path $leftover.FullName)) {
            Write-Host "OK  removed $($leftover.FullName)" -ForegroundColor Green
            $removed = $true
        }
    }
    # A compiled binary probes for a staged addon next to itself; clear any
    # veyyon_natives.*.node left beside the removed binary so uninstall leaves no
    # orphaned native artifacts behind (mirrors the same sweep in install.sh).
    foreach ($n in @(Get-ChildItem -Path $InstallDir -Filter "veyyon_natives.*.node" -File -ErrorAction SilentlyContinue)) {
        Remove-Item -Force $n.FullName
        Write-Host "OK  removed $($n.FullName)" -ForegroundColor Green
        $removed = $true
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
    # Reclaim the per-version native addon cache a binary install stages there
    # (~150MB per version). The path shape is owned by getNativesDir() in
    # packages/natives/native/loader-state.js — mirror it EXACTLY: honor
    # $XDG_DATA_HOME/veyyon/natives only when $XDG_DATA_HOME/veyyon already exists
    # (the loader's condition), otherwise ~/.veyyon/natives (os.homedir() is
    # USERPROFILE on Windows). Only the `natives` cache subdir is removed; the
    # user's auth/config/sessions under ~/.veyyon are left untouched.
    if ($env:XDG_DATA_HOME -and (Test-Path (Join-Path $env:XDG_DATA_HOME "veyyon"))) {
        $nativesCache = Join-Path $env:XDG_DATA_HOME "veyyon\natives"
    } else {
        $nativesCache = Join-Path $env:USERPROFILE ".veyyon\natives"
    }
    if (Test-Path $nativesCache) {
        Remove-Item -Recurse -Force $nativesCache
        Write-Host "OK  removed native addon cache $nativesCache" -ForegroundColor Green
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

    # A local install ignores $Ref entirely: there is no release to resolve.
    if ($Local) {
        Install-LocalBinary
        return
    }

    # Default to source when a ref is pinned.
    if ($Ref -and -not $Source -and -not $Binary) {
        $Source = $true
    }

    if ($Source) {
        if (-not (Test-BunInstalled)) {
            Write-Host "Installing bun..."
            Install-Bun
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        }
        Assert-BunVersion $MinimumBunVersion
        Install-FromSource
    } else {
        Install-Binary
    }
}
