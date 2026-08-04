# Veyyon Coding Agent Installer for Windows
# Usage: irm https://veyyon.dev/install.ps1 | iex
#   or:  irm https://raw.githubusercontent.com/santhreal/veyyon/main/scripts/install.ps1 | iex
#
# This installs the prebuilt self-contained binary (veyyon-windows-x64.exe):
# one download, no toolchain, nothing from a package registry, and nothing
# cloned. There is no source-install mode. A release that cannot be downloaded
# and verified is a hard failure that names the manual build instead.
#
# With options:
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Ref v1.0.37
#   & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Help
#
# The full option list lives in Write-Usage below, which is what -Help prints. A
# second copy here would be the one that goes stale, and it is the copy nobody
# running -Help would ever see.
#
# -Local installs the binary this checkout has already built
# (packages\coding-agent\dist\vey.exe) instead of downloading a release. It is
# the Windows counterpart of install.sh's --local, and it is what lets the real
# installer be driven end to end without a published release: everything after
# the binary is placed (the alias shim, the PATH entry, completions, the doctor
# self-test, and uninstall reclaiming all of it) is the same code the download
# path runs.

param(
    [switch]$Binary,
    [switch]$Local,
    [string]$Ref,
    [switch]$NoVerify,
    [switch]$Uninstall,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 is what `irm https://veyyon.dev/install.ps1 | iex` runs
# under on a stock Windows box, and its default SecurityProtocol still includes
# SSL 3.0 and TLS 1.0. GitHub has required TLS 1.2 since 2018, so without this
# every request in this script fails with "The request was aborted: Could not
# create SSL/TLS secure channel" — an error that says nothing about the real
# cause and sends the user looking at their network. Added rather than assigned,
# so a policy that has already enabled TLS 1.3 keeps it. PowerShell 7 negotiates
# this itself and is unaffected either way.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # .NET 5+ removed the setting entirely and always negotiates the best
    # protocol available. Nothing to do there, and nothing to report.
}

$Repo = "santhreal/veyyon"
$RepoUrl = "https://github.com/$Repo.git"
$InstallDir = if ($env:VEYYON_INSTALL_DIR) { $env:VEYYON_INSTALL_DIR } else { "$env:LOCALAPPDATA\veyyon" }
$SrcDir = if ($env:VEYYON_SRC_DIR) { $env:VEYYON_SRC_DIR } else { "$env:USERPROFILE\.veyyon\src" }
$BinName = "veyyon"
$AliasName = "vey"
$BinaryAsset = "veyyon-windows-x64.exe"
# The one manual route out of every hard failure, in one place.
#
# The installer downloads a verified prebuilt binary or it stops: it never
# clones and never builds. A refusal therefore has to hand the user something
# they can run themselves, and every refusal hands them the SAME thing, so the
# advice cannot drift between call sites. Mirrors MANUAL_BUILD in install.sh.
$ManualBuild = "build it from a checkout you own: git clone $RepoUrl && cd veyyon && bun run setup"
# Whether the `vey` shim next to the binary is one THIS installer owns.
#
# One owner: Install-Alias makes the call (it is the only code that inspects and
# writes the shim) and records it here; Install-Completions reads it rather than
# re-deriving. Mirrors ALIAS_IS_OURS in install.sh. Starts false, so nothing
# assumes an ownership it has not checked.
$Script:AliasIsOurs = $false

# A sidecar receipt distinguishes artifacts this installer owns from unrelated
# files that happen to use the same name.
#
# A receipt vouches for a FILE, never for a path. The v1 receipt recorded only
# the constant `veyyon-installer-v1`, so deleting an installed binary by hand
# left the sidecar behind and the next unrelated file to take that name
# inherited the ownership. v2 records the identity of the artifact it was
# written for and is accepted only while that artifact still matches:
#
#     veyyon-installer-v2
#     <kind> sha256:<64 lowercase hex>
#
# Byte-identical to what install.sh writes, LF-terminated, so one shared
# definition in scripts/install-tests/installer-artifacts.ts describes both
# platforms. Mirrors `owner_marker_for`, `artifact_identity`,
# `owner_receipt_identity`, `artifact_has_owner_receipt` and
# `mark_artifact_owned` there.
function Get-OwnerMarkerPath {
    param([string]$Path)
    $parent = Split-Path -Parent $Path
    $leaf = Split-Path -Leaf $Path
    return (Join-Path $parent ".$leaf.veyyon-owner")
}

# The identity line for the artifact currently at $Path, or $null.
#
# `link` covers a reparse point, whose identity is the TARGET STRING it holds
# rather than the bytes it resolves to; `file` covers everything else and is
# identified by its bytes. Returns $null rather than guessing when the hash
# cannot be computed, and every caller reads $null as "not ours", so an
# ownership question this cannot answer is answered NO.
function Get-ArtifactIdentity {
    param([string]$Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.LinkType) {
            $target = @($item.Target)[0]
            if (-not $target) { return $null }
            $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$target)
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace("-", "").ToLower() }
            finally { $sha.Dispose() }
            return "link sha256:$hash"
        }
        if ($item.PSIsContainer) { return $null }
        return "file sha256:$((Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower())"
    } catch {
        return $null
    }
}

# The identity a v2 receipt records for $Path. $null when there is no sidecar, or
# when the sidecar is a v1 receipt, which records no identity at all.
function Get-OwnerReceiptIdentity {
    param([string]$Path)
    $marker = Get-OwnerMarkerPath $Path
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $null }
    $lines = @(Get-Content -LiteralPath $marker -TotalCount 2 -ErrorAction SilentlyContinue)
    if ($lines.Count -lt 2) { return $null }
    if ("$($lines[0])".Trim() -ne "veyyon-installer-v2") { return $null }
    $identity = "$($lines[1])".Trim()
    if (-not $identity) { return $null }
    return $identity
}

function Test-ArtifactHasOwnerReceipt {
    param([string]$Path)
    $recorded = Get-OwnerReceiptIdentity $Path
    if (-not $recorded) { return $false }
    $actual = Get-ArtifactIdentity $Path
    if (-not $actual) { return $false }
    return $recorded -eq $actual
}

# Whether $Path carries a v1 receipt: the pre-identity format, which vouched for
# the path alone. It proves an installer once wrote SOMETHING here and nothing
# about what is here now, so it never decides ownership on its own. It exists so
# the gates below can say why they refused.
function Test-ArtifactHasLegacyOwnerReceipt {
    param([string]$Path)
    $marker = Get-OwnerMarkerPath $Path
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
    $content = Get-Content -Raw -LiteralPath $marker -ErrorAction SilentlyContinue
    return "$content".Trim() -eq "veyyon-installer-v1"
}

# Writing a receipt REQUIRES the identity. A receipt recording none would be a v1
# receipt under a v2 name and would reopen the hole for that artifact
# permanently, so an identity that cannot be computed throws here rather than
# claiming an ownership it cannot prove.
function Set-ArtifactOwned {
    param([string]$Path)
    $marker = Get-OwnerMarkerPath $Path
    $staging = "$marker.$PID"
    $identity = Get-ArtifactIdentity $Path
    if (-not $identity) {
        throw "could not record installer ownership for $Path (its SHA256 identity could not be computed)"
    }
    try {
        # WriteAllText rather than Set-Content: the receipt must be the same bytes
        # install.sh writes, and Set-Content would end the lines with CRLF here.
        [System.IO.File]::WriteAllText($staging, "veyyon-installer-v2`n$identity`n")
        Move-Item -LiteralPath $staging -Destination $marker -Force
    } catch {
        Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue
        throw "could not record installer ownership for $Path ($($_.Exception.Message))"
    }
}

function Remove-ArtifactOwnerReceipt {
    param([string]$Path)
    Remove-Item -LiteralPath (Get-OwnerMarkerPath $Path) -Force -ErrorAction SilentlyContinue
}

# A completion script needs no authoritative-mismatch rule, because its fallback
# is already an identity check: it reads the file and accepts only a generated
# Veyyon completion header. A stranger's file inheriting an orphaned receipt
# fails both halves, and a script `veyyon update` legitimately regenerates still
# passes the second.
function Test-CompletionArtifactIsOurs {
    param([string]$Path)
    if (Test-ArtifactHasOwnerReceipt $Path) { return $true }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $first = "$(Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction SilentlyContinue)"
    return $first.StartsWith("# PowerShell completion for veyyon ") -and $first.Contains("generated by")
}

function Test-BinaryArtifactIsOurs {
    param([string]$Path)
    if (Test-ArtifactHasOwnerReceipt $Path) { return $true }
    # A v2 receipt that does NOT match is this installer's own record that the
    # file it wrote here is gone, so it settles the question and the shim
    # evidence below is not consulted. Falling through would undo the fix: the
    # `vey.cmd` shim survives any replacement of the binary beside it, so it
    # would hand ownership of a stranger's file straight back.
    if (Get-OwnerReceiptIdentity $Path) { return $false }
    $aliasShim = Join-Path (Split-Path -Parent $Path) "$AliasName.cmd"
    return (Test-Path -LiteralPath $aliasShim -PathType Leaf) -and
        (Test-AliasShimIsOurs -ShimPath $aliasShim -BinDir (Split-Path -Parent $Path))
}

# Why a refusal happened, for the gates that have to explain themselves. An
# ownership question the installer could not decide must never resolve to "yes",
# but it must not be reported as "this is somebody else's file" either.
function Get-BinaryRefusalReason {
    param([string]$Path)
    if (Get-OwnerReceiptIdentity $Path) {
        return "it has changed since this installer wrote it, so the file there now is not the one it installed"
    }
    if (Test-ArtifactHasLegacyOwnerReceipt $Path) {
        return "its ownership receipt predates recorded file identity and cannot be confirmed against the file that is there now"
    }
    return "it was not created by this installer"
}

# Whether the installer may write over what is at $Path: nothing is there, or
# what is there is ours. Kept for the artifacts an OLD source install left in
# the install directory, chiefly the `veyyon.cmd` shim that forwarded into
# `<src>\packages\coding-agent\scripts\veyyon.cmd`, so a machine carrying one can
# still be upgraded and uninstalled. Mirrors binary_path_is_replaceable in
# install.sh.
function Test-BinaryPathIsReplaceable {
    param([string]$Path)
    return (-not (Test-Path -LiteralPath $Path)) -or (Test-BinaryArtifactIsOurs $Path)
}

# A just-executed staged binary can remain image-locked briefly while Windows
# tears down its last worker process or an antivirus scan releases the file.
# Retry the rename transaction for a bounded interval instead of turning that
# normal handoff into a failed reinstall. Permanent errors still surface with
# their original exception after the final attempt.
function Move-InstallItemWithRetry {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [int]$MaxAttempts = 8
    )
    $delayMs = 50
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Microsoft.PowerShell.Management\Move-Item -LiteralPath $SourcePath -Destination $DestinationPath -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $MaxAttempts) { throw }
            Start-Sleep -Milliseconds $delayMs
            $delayMs = [Math]::Min($delayMs * 2, 500)
        }
    }
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
        throw "the binary staged at $StagingPath is empty - refusing to install; the download did not complete. Retry, or $ManualBuild"
    }
    if ((Test-Path -LiteralPath $TargetPath) -and -not (Test-BinaryArtifactIsOurs $TargetPath)) {
        Remove-Item $StagingPath -Force -ErrorAction SilentlyContinue
        throw "refusing to replace $TargetPath because $(Get-BinaryRefusalReason $TargetPath); move it aside, then re-run the installer"
    }
    if (-not (Test-Path $TargetPath)) {
        Move-InstallItemWithRetry -SourcePath $StagingPath -DestinationPath $TargetPath
        Set-ArtifactOwned $TargetPath
        return
    }
    $asideName = "$([System.IO.Path]::GetFileName($TargetPath)).$PID.old"
    $aside = Join-Path ([System.IO.Path]::GetDirectoryName($TargetPath)) $asideName
    Move-InstallItemWithRetry -SourcePath $TargetPath -DestinationPath $aside
    try {
        Move-InstallItemWithRetry -SourcePath $StagingPath -DestinationPath $TargetPath
    } catch {
        # Put the working binary back before reporting; a failed install must
        # not be an uninstall.
        Move-InstallItemWithRetry -SourcePath $aside -DestinationPath $TargetPath
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
        throw "could not replace $TargetPath ($($_.Exception.Message)); your previous $BinName is untouched"
    }
    Remove-Item $aside -ErrorAction SilentlyContinue
    Set-ArtifactOwned $TargetPath
}

# PowerShell decides whether a command path is executable from its final
# extension. Keep the verified staging file beside the target for an atomic move,
# but retain `.exe` as the final suffix so the preflight can run inside a
# pipeline on Windows PowerShell 5.1.
function New-BinaryStagingPath {
    param(
        [string]$Dir,
        [string]$BinName,
        [ValidateSet("download", "local")][string]$Kind = "download"
    )
    return Join-Path $Dir ".$BinName.$PID.$Kind.exe"
}

# Reclaim moved-aside binaries whose owning process has since exited. Deleting
# one that is still mapped fails, which is fine: it is retried next run.
# Remove artifacts a previous install left behind: a moved-aside `.old` binary and
# a staged `.download`, `.download.exe`, `.local`, or `.local.exe` that never
# made it into place.
#
# The staged-file half is why this exists. Nothing survives a killed process,
# and until now only Uninstall-Veyyon ever swept downloads, so an install that
# kept being killed accumulated a full copy of the binary (~100 MB) per attempt
# in the user's install directory, hidden, with nothing on screen to explain
# them. Both staging kinds carry the writer's $PID, so a file whose process is
# STILL RUNNING belongs to a concurrent installer and is left alone: the pid is
# in the path precisely so two installers cannot truncate each other's file.
# Every removal is announced, because deleting files in a directory the user
# owns is a visible change and not something to do quietly. Mirrors
# sweep_stale_staging in install.sh.
function Clear-StaleInstallArtifacts {
    param([string]$Dir, [string]$BaseName, [string]$BinName)
    if (-not (Test-Path $Dir)) { return }
    $oldPattern = "^" + [regex]::Escape($BaseName) + "\.(\d+)\.old$"
    $stagingPattern = "^\." + [regex]::Escape($BinName) + "\.(\d+)\.(?:download|local)(?:\.exe)?$"
    $leftovers = @(Get-ChildItem -Path $Dir -Filter "$BaseName.*.old" -File -ErrorAction SilentlyContinue) +
                 @(Get-ChildItem -Path $Dir -Filter ".$BinName.*.download" -File -Force -ErrorAction SilentlyContinue) +
                 @(Get-ChildItem -Path $Dir -Filter ".$BinName.*.download.exe" -File -Force -ErrorAction SilentlyContinue) +
                 @(Get-ChildItem -Path $Dir -Filter ".$BinName.*.local" -File -Force -ErrorAction SilentlyContinue) +
                 @(Get-ChildItem -Path $Dir -Filter ".$BinName.*.local.exe" -File -Force -ErrorAction SilentlyContinue)
    foreach ($leftover in $leftovers) {
        $match = [regex]::Match($leftover.Name, $oldPattern)
        if (-not $match.Success) { $match = [regex]::Match($leftover.Name, $stagingPattern) }
        if (-not $match.Success) { continue }
        $ownerPid = 0
        if (-not [int]::TryParse($match.Groups[1].Value, [ref]$ownerPid)) { continue }
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

# The comparable form of one PATH entry. Single owner: every place that asks
# whether two PATH entries name the same directory goes through this, so the add,
# the remove and the presence check can never disagree about what "the same
# entry" means — a disagreement there either double-adds our directory on every
# reinstall or refuses to take it back out on uninstall.
#
# Three things are stripped, each of which a real Windows PATH carries:
#   * surrounding whitespace, which `PATH=%PATH%; C:\tools` leaves behind;
#   * one matched pair of double quotes, which is legal and which installers
#     write around a path containing a space;
#   * trailing backslashes, since `C:\a\bin\` and `C:\a\bin` are one directory.
# Comparison is case-insensitive at the call sites because Windows paths are.
function Get-NormalizedPathEntry {
    param([string]$Entry)
    $value = "$Entry".Trim()
    if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2).Trim()
    }
    return $value.TrimEnd('\')
}

# PATH with $Dir removed, comparing entries the same way Test-PathContainsDir
# does. Returns the original string when the entry is not present, so the caller
# can tell nothing changed.
function Get-PathWithoutDir {
    param([string]$Raw, [string]$Dir)
    $want = Get-NormalizedPathEntry $Dir
    $kept = @(Split-PathEntries $Raw | Where-Object { (Get-NormalizedPathEntry $_) -ine $want })
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
    if ((Test-Path -LiteralPath $scriptPath) -and -not (Test-CompletionArtifactIsOurs $scriptPath)) {
        Write-Host "!!  left $scriptPath alone (not created by this installer); tab completion was not changed" -ForegroundColor Yellow
        return
    }
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $scriptPath) | Out-Null
        # Write through a temp file: the profile dot-sources this at every shell
        # start, and a half-written script would break every new session.
        $staging = "$scriptPath.$PID.new"
        Set-Content -LiteralPath $staging -Value $generated
        Move-Item -LiteralPath $staging -Destination $scriptPath -Force
        Set-ArtifactOwned $scriptPath
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
        if (Test-CompletionArtifactIsOurs $scriptPath) {
            Remove-Item -Force $scriptPath
            Remove-ArtifactOwnerReceipt $scriptPath
            Write-Host "OK  removed $scriptPath" -ForegroundColor Green
            $removed = $true
        } else {
            Write-Host "OK  left $scriptPath alone (not created by this installer)" -ForegroundColor Green
        }
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
# True only when one command line in a cmd shim is the exact forwarding line
# this installer writes. A substring is not ownership: a user's script may log,
# compare, or comment on our binary path while launching something else.
function Test-AliasBodyForTarget {
    param([string]$Body, [string]$Target)
    if ([string]::IsNullOrEmpty($Body) -or [string]::IsNullOrEmpty($Target)) {
        return $false
    }
    $forward = "`"$Target`" %*"
    foreach ($line in ($Body -split '\r?\n')) {
        if ($line.Trim() -ieq $forward) { return $true }
    }
    return $false
}

function Test-AliasShimIsOurs {
    param([string]$ShimPath, [string]$BinDir)
    $body = Get-Content -Raw -LiteralPath $ShimPath -ErrorAction SilentlyContinue
    if (-not $body) { return $false }
    foreach ($target in @((Join-Path $BinDir "$BinName.exe"), (Join-Path $BinDir "$BinName.cmd"))) {
        if (Test-AliasBodyForTarget -Body $body -Target $target) { return $true }
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
            if (-not (Test-AliasBodyForTarget -Body $existing -Target $Target)) {
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
# and either skips a needed add or double-adds. Compare whole entries through
# Get-NormalizedPathEntry, case-insensitively (Windows paths are case-insensitive).
function Test-PathContainsDir {
    param([string]$Raw, [string]$Dir)
    $target = Get-NormalizedPathEntry $Dir
    foreach ($entry in (Split-PathEntries $Raw)) {
        if ((Get-NormalizedPathEntry $entry) -ieq $target) { return $true }
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

# The command the user should actually type.
#
# `vey` is the short launch alias, but the installer refuses to create it when
# the user already owns that name, and the closing message named it anyway, which
# would have sent them to THEIR tool. One owner, read by every closing message,
# so the advice cannot contradict what the alias step decided. Mirrors
# launch_command in install.sh.
function Get-LaunchCommand {
    if ($Script:AliasIsOurs) { return $AliasName }
    return $BinName
}

# The closing block, one copy for all three install modes.
#
# There were three, one per mode, each a single line that named both names and
# stopped there: it told the user nothing about connecting a provider or finding
# the command list, and it named `vey` even on an install that had just said it
# was leaving the user's own `vey` alone. This mirrors print_next_steps in
# install.sh step for step, including the reload coming FIRST when it is needed:
# a PATH entry written to the registry reaches a process when that process
# starts, so a terminal that is already open cannot see it, and leading with a
# command that is not yet a command reads as a broken install.
# Whether this script is running INSIDE the shell the user is typing in, rather
# than in a child process of it.
#
# It decides whether the closing advice has to open with "restart your terminal".
# The documented install is `irm https://veyyon.dev/install.ps1 | iex`, which
# executes in the caller's own session: Add-ToPath sets $env:Path there, so the
# command works in that window immediately and telling the user to restart first
# is both wrong and the friction they hit before anything else. Run as
# `pwsh -File install.ps1` it is a child process, its $env:Path dies with it, and
# the restart is genuinely required.
#
# $PSCommandPath is the discriminator: a script invoked from a FILE (run or
# dot-sourced) knows its own path, and code handed to Invoke-Expression as a
# string has none.
function Test-RunsInCallersSession {
    return [string]::IsNullOrEmpty($PSCommandPath)
}

function Write-NextSteps {
    # $InCallersSession is PASSED rather than resolved here, because
    # $PSCommandPath is an automatic variable a test cannot shadow: a test that
    # tried would silently exercise only the branch its own file puts it in, and
    # the other branch would ship unproven. The call sites read the real answer
    # once; the tests drive both branches directly.
    param([switch]$NeedsRestart, [switch]$InCallersSession)
    $cmd = Get-LaunchCommand
    $inCallersSession = [bool]$InCallersSession
    Write-Host ""
    Write-Host "OK  Installation complete." -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:"
    $n = 0
    if ($NeedsRestart -and -not $inCallersSession) {
        $n++
        Write-Host ("  {0}. {1,-25} {2}" -f $n, "Restart your terminal:", "open a new window")
    }
    $n++; Write-Host ("  {0}. {1,-25} {2}" -f $n, "Launch in any repository:", $cmd)
    $n++; Write-Host ("  {0}. {1,-25} {2}" -f $n, "Connect API providers:", "$cmd setup")
    $n++; Write-Host ("  {0}. {1,-25} {2}" -f $n, "See every command:", "$cmd --help")
    # Said either way, because the PATH entry is per-user and a terminal reads it
    # when it starts: this window is fine and every other open one is not.
    if ($NeedsRestart -and $inCallersSession) {
        Write-Host ""
        Write-Host "  This window is ready. Terminals already open elsewhere pick up $InstallDir when they restart."
    }
}

# Add the install dir to the user PATH if it is not already there. Returns $true
# when a new entry was added (so the caller can tell the user to restart).
function Add-ToPath {
    $UserPath = (Get-RawUserPath).Value
    $addedForFutureSessions = $false
    if (-not (Test-PathContainsDir $UserPath $InstallDir)) {
        Write-Host "Adding $InstallDir to PATH..."
        Set-RawUserPath (Get-PathWithDir $UserPath $InstallDir)
        $addedForFutureSessions = $true
    }
    # The registry and this process can disagree. This happens when a prior
    # file-based install updated HKCU, then the user reruns the documented
    # `irm | iex` command from the still-open parent terminal. Keep that caller
    # usable even when no persistent PATH write is needed this time.
    if (-not (Test-PathContainsDir $env:Path $InstallDir)) {
        $env:Path = Get-PathWithDir $env:Path $InstallDir
    }
    return $addedForFutureSessions
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

# Require the still-staged executable to identify as the resolved release tag.
# A valid checksum cannot catch a release that published an older executable;
# this check runs before the existing executable or installer-owned metadata is
# touched, so rejecting that release is non-destructive.
function Assert-ReleaseVersion {
    param(
        [string]$Command,
        [string]$ExpectedTag,
        [string]$Phase = "downloaded"
    )
    $ver = $null
    $why = ""
    $status = $null
    $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("veyyon-release-version-" + [guid]::NewGuid().ToString("N") + ".err")
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $ver = (& $Command --version 2>$errFile | Out-String).Trim()
        $status = $LASTEXITCODE
        if (Test-Path $errFile) {
            $raw = Get-Content -Raw $errFile
            if ($null -ne $raw) { $why = $raw.Trim() }
        }
    } catch {
        $ver = $null
        $why = "$_"
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item -Force $errFile -ErrorAction SilentlyContinue
    }
    if ($status -ne 0 -or -not $ver) {
        $exit = if ($null -eq $status) { "no exit code (the process could not be started)" } else { "exit $status" }
        $detail = if ($why) { " It said: $why" } else { " It printed nothing." }
        throw "the $Phase $BinName did not report its version: '$Command --version' gave $exit.$detail"
    }
    $want = $ExpectedTag -replace '^v', ''
    $got = ConvertFrom-VersionOutput -Text ([string]$ver)
    if (-not $got) {
        throw "could not read a version from '$Command --version' output: $ver"
    }
    if ($got -ne $want) {
        throw "the $Phase $BinName reports $got but the $ExpectedTag release was requested - refusing to replace the existing executable"
    }
    Write-Host "OK  downloaded binary reports the $ExpectedTag release version" -ForegroundColor Green
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
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $Command grep --help *> $null
        $helpStatus = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($helpStatus -ne 0) {
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
    $status = $null
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $out = (& $Command grep veyyon-native-self-test $dir 2>&1 | Out-String)
        $status = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    }
    if ($status -ne 0) {
        throw "the $Phase $BinName starts but cannot run a search: '$BinName grep' exited $status. The native addon did not load, which usually means the release has no build for this architecture. No prebuilt binary works here, so $ManualBuild. Output was: $out"
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
    $why = ""
    $status = $null
    # stderr is KEPT, in its own file rather than discarded. It used to go to
    # $null, and when a published binary failed to start on a clean Windows image
    # the installer said only "'veyyon --version' failed" — no exit code, no
    # message, nothing to act on. Separate rather than merged because the version
    # parse below reads this output, and a warning on stderr carrying digits
    # would otherwise be read as the version.
    $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("veyyon-doctor-" + [guid]::NewGuid().ToString("N") + ".err")
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $ver = (& $Command --version 2>$errFile | Out-String).Trim()
        $status = $LASTEXITCODE
        # `Get-Content -Raw` answers $null for an EMPTY file, and calling .Trim()
        # on that throws under `$ErrorActionPreference = "Stop"` — so a binary
        # that failed silently reported the PowerShell exception as its reason
        # instead of saying it printed nothing.
        if (Test-Path $errFile) {
            $raw = Get-Content -Raw $errFile
            if ($null -ne $raw) { $why = $raw.Trim() }
        }
    } catch {
        $ver = $null
        $why = "$_"
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        Remove-Item -Force $errFile -ErrorAction SilentlyContinue
    }
    if ($status -eq 0 -and $ver) {
        Write-Host "OK  $BinName runs - $ver" -ForegroundColor Green
    } else {
        $exit = if ($null -eq $status) { "no exit code (the process could not be started)" } else { "exit $status" }
        $detail = if ($why) { " It said: $why" } else { " It printed nothing." }
        throw "$BinName did not run after install: '$Command --version' gave $exit.$detail"
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
    return [bool](Test-AliasBodyForTarget -Body $existing -Target $BinPath)
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

# ---- legacy source-checkout handling, for uninstall only ----
#
# An older version of this installer built from a git checkout under $SrcDir.
# It no longer does: an install is a verified binary download or it fails. The
# helpers below stay because those checkouts are still on people's machines, and
# -Uninstall has to find one, refuse to destroy any work in it, and leave a
# checkout that tracks somebody else's repository alone. Nothing in this
# installer creates $SrcDir any more.

# A stamp unique enough that two installer runs in the same second do not collide
# on a moved-aside directory name ($PID disambiguates).
function Get-BackupStamp {
    return "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$PID"
}

# Move an existing tree aside instead of deleting it. Uninstall reaches here for
# a checkout it must not remove: one holding uncommitted edits or unpushed
# branches, or one tracking a repository that is not ours. Moving to
# `<dir>.bak-<stamp>` preserves everything, including files a user put there by
# hand and a partial checkout with no .git. An empty directory is simply removed.
# Fail closed: if the move cannot happen, throw rather than fall back to a
# destructive delete.
function Move-AsideExistingSrc {
    param([string]$Src = $SrcDir)
    if (-not (Test-Path $Src)) { return }
    if ((Test-Path $Src -PathType Container) -and -not (Get-ChildItem -Force -Path $Src -ErrorAction SilentlyContinue)) {
        Remove-Item -Recurse -Force $Src -ErrorAction SilentlyContinue
        return
    }
    $stamp = Get-BackupStamp
    $backup = "$Src.bak-$stamp"
    try {
        Move-Item -Path $Src -Destination $backup -ErrorAction Stop
    } catch {
        throw "refusing to continue: could not move existing $Src aside to $backup ($($_.Exception.Message))"
    }
    Write-Host "moved existing $Src aside to $backup (nothing was deleted)" -ForegroundColor Yellow
}

# Whether a source checkout holds work the installer did not create and must not
# delete on uninstall: uncommitted edits, commits on a local branch that live on
# no remote (this includes the `veyyon-local-*` branches an older source install
# made to preserve edits, so a preserved AGENTS.md is never silently deleted by
# -Uninstall), or a non-git but non-empty tree. $false means the tree is pristine
# and safe to remove outright.
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

# A source checkout is installer-owned only when `origin` names the Veyyon
# repository. The configured directory and a clean worktree do not establish
# ownership because a user can point VEYYON_SRC_DIR at an unrelated checkout.
function Test-SrcRemoteIsOurs {
    param([string]$Src = $SrcDir)
    if (-not (Test-Path (Join-Path $Src ".git")) -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
        return $false
    }
    Push-Location $Src
    try {
        $remote = git remote get-url origin 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($remote -join ""))) {
            return $false
        }
        $actual = ($remote -join "").Trim()
        $accepted = @(
            $RepoUrl,
            "https://github.com/$Repo",
            "https://github.com/$Repo.git",
            "git@github.com:$Repo",
            "git@github.com:$Repo.git",
            "ssh://git@github.com/$Repo",
            "ssh://git@github.com/$Repo.git"
        )
        return $accepted -contains $actual
    } finally {
        Pop-Location
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

# The tag of the newest published release, resolved WITHOUT the GitHub API.
#
# api.github.com allows 60 requests an hour per IP without a token, and that
# budget is shared by everyone behind the same address, so a CI fleet or an
# office network that installs veyyon repeatedly used to start getting a 403 on
# a machine where nothing was wrong. github.com itself is not part of that
# budget: /releases/latest redirects to the tag page of the newest
# non-prerelease release, which is the only thing the API response was read for,
# and it is the same host the binary is downloaded from. Mirrors
# resolve_latest_tag in install.sh.
#
# HttpWebRequest rather than Invoke-WebRequest, because the two PowerShells
# disagree about what an unfollowed redirect IS. `-MaximumRedirection 0` returns
# the 302 as a response on PowerShell 7 and raises an error on Windows PowerShell
# 5.1, where the Location then has to be dug out of an exception, and 5.1 is what
# `irm | iex` runs under on a stock Windows box. HttpWebRequest with
# AllowAutoRedirect off behaves identically on both: a 302 is an ordinary
# response, and the header is a string on each.
#
# The answer comes from the Location header rather than from parsing the page, so
# a redesign of GitHub's release page cannot change which version gets installed.
# Where $Url redirects to, as a string, or "" when it does not redirect or could
# not be reached. The transport half, split from the parse below so the guard on
# what a redirect is ALLOWED to point at can be tested without a network.
function Get-RedirectLocation {
    param([string]$Url)
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.AllowAutoRedirect = $false
        $req.Timeout = 60000
        # GitHub answers some clients differently, and a request with no
        # user-agent is one of them.
        $req.UserAgent = "veyyon-installer"
        # Headers only: the answer is the Location header, and the body of a
        # redirect is an empty page nobody reads.
        $req.Method = "HEAD"
        $resp = $req.GetResponse()
        try {
            return "$($resp.Headers["Location"])"
        } finally {
            $resp.Close()
        }
    } catch {
        # A 4xx or 5xx arrives here as an exception carrying the response, and a
        # dead host as one carrying nothing. Neither has a Location, so both are
        # "no redirect" and the caller reports that it could not reach the
        # release, which is true.
        return ""
    }
}

function Get-TagFromRedirect {
    param([string]$Url)
    $target = Get-RedirectLocation $Url
    # A redirect that did not land on a tag page means GitHub answered with
    # something other than a release. Taking the last path segment anyway is how
    # an installer ends up downloading a binary for the version "latest".
    if ($target -notmatch '/releases/tag/(.+)$') { return $null }
    return $Matches[1]
}

# What state a tag is in, as far as installing a prebuilt binary is concerned:
#   "released"    a published release with downloadable assets (install can go on)
#   "unreleased"  a real tag with no installable release (bare tag, or a draft)
#   "missing"     no such tag
#
# This used to HEAD `/releases/tag/<tag>` and read a 200 as "the release is
# published". GitHub renders that page for ANY tag that exists, with or without a
# release object attached, and an unpublished draft is invisible there too, so
# the check passed for tags that cannot be installed at all. The install then got
# as far as the asset download and blamed the platform binary for a release that
# was never cut.
#
# `/releases/expanded_assets/<tag>` is the fragment GitHub lazy-loads into the
# release page's asset list, and it answers all three states in one request:
# 404 for a tag that does not exist; for a bare tag or a draft it renders the two
# source-archive links and nothing else; only a published release lists
# `/releases/download/<tag>/` hrefs, and that href IS the URL the binary is
# fetched from. github.com rather than the API, for the same rate-limit reason
# Get-TagFromRedirect exists. Mirrors release_tag_state in install.sh.
function Get-ReleaseTagState {
    param([string]$Tag)
    try {
        $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/expanded_assets/$Tag" -TimeoutSec 60 -UseBasicParsing
    } catch {
        return "missing"
    }
    # Contains(), not -like: a literal test, so nothing in the tag is read as a
    # wildcard. Nothing is parsed out of the HTML either, only a prefix tested for.
    if ("$($resp.Content)".Contains("/$Repo/releases/download/$Tag/")) { return "released" }
    return "unreleased"
}

# The published tag for a -Ref a person typed, or $null when there is none.
#
# Releases are tagged `v1.0.37`, and `-Ref 1.0.37` is what people type: the same
# version, one character short of a tag that exists. Refusing it states a true
# fact and leaves the user to guess which of the two spellings this project uses,
# so the `v` form is tried as a second lookup. The caller ANNOUNCES what it
# resolved to, rather than proceeding quietly, so the version being installed is
# the version on screen. Nothing wider is attempted: a branch or a commit is not
# a version, `vmain` is a tag nobody has, and installing a version the user did
# not name is worse than refusing. Mirrors resolve_ref_tag in install.sh.
#
# Returns Tag plus the State that got it there, because the two ways this fails
# need different things said: "unreleased" is "that tag is real but has no
# release you can install", "missing" is "there is no such tag". Collapsing them
# is how a tag with no release spent a release cycle being reported as a missing
# platform binary.
function Resolve-RefTag {
    param([string]$Ref)
    $state = Get-ReleaseTagState $Ref
    if ($state -eq "released") { return [pscustomobject]@{ Tag = $Ref; State = "released" } }
    # A bare version is the one alternate spelling worth a second request.
    # Already `v`-prefixed, or a branch or a sha, which are not versions: `vmain`
    # is a tag nobody has, so it stays at "no such tag" untried.
    $alt = "missing"
    if ($Ref -match '^\d+\.\d+\.\d+') { $alt = Get-ReleaseTagState "v$Ref" }
    if ($alt -eq "released") { return [pscustomobject]@{ Tag = "v$Ref"; State = "released" } }
    # Either spelling being a real tag means the user named a version that was
    # never released, which is a different thing to be told than a typo. The tag
    # that DOES exist comes back with it, so the caller can name the tag it found
    # rather than reporting a typo. Nothing installs it, since only "released"
    # reaches the download.
    if ($state -eq "unreleased") { return [pscustomobject]@{ Tag = $Ref; State = "unreleased" } }
    if ($alt -eq "unreleased") { return [pscustomobject]@{ Tag = "v$Ref"; State = "unreleased" } }
    return [pscustomobject]@{ Tag = $null; State = "missing" }
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        $Resolved = Resolve-RefTag $Ref
        # The tag is real, the release is not. Say that, and say it without
        # mentioning the platform binary: nothing is wrong with the binary, there
        # is no release for it to be part of.
        if ($Resolved.State -eq "unreleased") {
            throw "No release is published for tag $($Resolved.Tag), so there is no binary to download.`nThat tag exists in the repository, but nothing was ever released from it (its release may still be an unpublished draft).`nPick a version that has a release from https://github.com/$Repo/releases, or $ManualBuild"
        }
        $Latest = $Resolved.Tag
        if (-not $Latest) {
            throw "release tag not found: $Ref. Only published release tags are installable; for a branch or a commit, $ManualBuild, adding ``git checkout $Ref`` before the setup step"
        }
        if ($Latest -ne $Ref) { Write-Host "Resolved $Ref to the published tag $Latest" }
    } else {
        Write-Host "Fetching latest release..."
        $Latest = Get-TagFromRedirect "https://github.com/$Repo/releases/latest"
    }

    if (-not $Latest) {
        throw "Could not reach https://github.com/$Repo/releases/latest (network error, or GitHub is down) - retry once the network is back."
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
    $StagingPath = New-BinaryStagingPath -Dir $InstallDir -BinName $BinName
    # -UseBasicParsing: without it, Windows PowerShell 5.1 hands the response to
    # Internet Explorer's parsing engine, which is absent on Server Core and
    # refuses to run at all on a machine where IE's first-launch configuration
    # was never completed. The download then fails with a message about Internet
    # Explorer, on an install that never mentioned a browser.
    #
    # $ProgressPreference: 5.1's progress bar repaints per read on a synchronous
    # download, and on a file this size that repainting dominates the transfer —
    # the well-known order-of-magnitude slowdown. Suppressed for the download and
    # restored afterwards, so nothing else in the session loses its progress
    # output. PowerShell 7 does not have the problem and is unaffected.
    $priorProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $StagingPath -TimeoutSec 900 -UseBasicParsing
    } catch {
        Remove-Item $StagingPath -ErrorAction SilentlyContinue
        throw "download failed: $BinaryAsset may not be published for this release. Check the assets on https://github.com/$Repo/releases/tag/$Latest, or $ManualBuild ($_)"
    } finally {
        $ProgressPreference = $priorProgress
    }

    # Verify checksum against the release's .sha256 sidecar. Fail closed: a
    # missing or unparseable sidecar refuses the install unless -NoVerify is
    # passed (only needed for old pre-sidecar releases).
    if ($NoVerify) {
        Write-Host "!  checksum verification skipped (-NoVerify)" -ForegroundColor Yellow
    } else {
        $expected = $null
        try {
            $expected = ConvertFrom-Sha256Sidecar (Invoke-RestMethod -Uri "$BinaryUrl.sha256" -TimeoutSec 30 -UseBasicParsing)
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

    # Prove the download is the requested release and can run a native search
    # before it is allowed to touch anything. The checksum proves the bytes
    # match what was published, but not that the published asset carries the
    # tag's version or has a working build for this platform. A rejection costs
    # only the staged file, which this catch removes.
    try {
        Assert-ReleaseVersion -Command $StagingPath -ExpectedTag $Latest -Phase "downloaded"
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

    Write-NextSteps -NeedsRestart:$needsRestart -InCallersSession:(Test-RunsInCallersSession)
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
    $StagingPath = New-BinaryStagingPath -Dir $InstallDir -BinName $BinName -Kind "local"
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

    Write-NextSteps -NeedsRestart:$needsRestart -InCallersSession:(Test-RunsInCallersSession)
}

function Uninstall-Veyyon {
    $removed = $false
    $pathEntryRemoved = $false
    $ownedBinaryPaths = @{}
    foreach ($f in @("$BinName.exe", "$BinName.cmd")) {
        $candidate = Join-Path $InstallDir $f
        $ownedBinaryPaths[$candidate] = Test-BinaryArtifactIsOurs $candidate
    }
    if (Remove-FromPath) {
        Write-Host "OK  removed $InstallDir from your PATH" -ForegroundColor Green
        $removed = $true
        $pathEntryRemoved = $true
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
            if ($ownedBinaryPaths[$p]) {
                Remove-Item -Force $p
                Remove-ArtifactOwnerReceipt $p
                Write-Host "OK  removed $p" -ForegroundColor Green
                $removed = $true
            } else {
                Write-Host "OK  left $p alone (not created by this installer)" -ForegroundColor Green
            }
        }
    }
    # Staged downloads, staged local builds, and moved-aside previous binaries
    # are ours too. A locked `.old` (still the running image) is left for the
    # next sweep rather than failing the uninstall over a file the OS will
    # release on exit.
    foreach ($leftover in @(Get-ChildItem -Path $InstallDir -Filter "*.old" -File -ErrorAction SilentlyContinue) +
                          @(Get-ChildItem -Path $InstallDir -Filter ".$BinName.*.download" -File -Force -ErrorAction SilentlyContinue) +
                          @(Get-ChildItem -Path $InstallDir -Filter ".$BinName.*.download.exe" -File -Force -ErrorAction SilentlyContinue) +
                          @(Get-ChildItem -Path $InstallDir -Filter ".$BinName.*.local" -File -Force -ErrorAction SilentlyContinue) +
                          @(Get-ChildItem -Path $InstallDir -Filter ".$BinName.*.local.exe" -File -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -Force $leftover.FullName -ErrorAction SilentlyContinue
        if (-not (Test-Path $leftover.FullName)) {
            Write-Host "OK  removed $($leftover.FullName)" -ForegroundColor Green
            $removed = $true
        }
    }
    # `veyyon update` stages at `<binary>.new` and keeps the binary it replaces as
    # `<binary>.<timestamp>.<pid>.bak` until the new one has proved itself. Windows
    # cannot unlink a running process image, so that backup routinely outlives the
    # update, and a killed update leaves the staged file. Neither matches the two
    # patterns above (those are the INSTALLER's own staging), so an uninstall used
    # to report success and leave a few hundred megabytes named `veyyon.exe.new`
    # behind. Mirrors the same sweep in install.sh. The `\d`-only middle is what
    # keeps a `veyyon.exe.mine.bak` somebody saved by hand out of it.
    foreach ($f in @("$BinName.exe", "$BinName.cmd")) {
        $staged = Join-Path $InstallDir "$f.new"
        if (Test-Path $staged) {
            Remove-Item -Force $staged -ErrorAction SilentlyContinue
            if (-not (Test-Path $staged)) {
                Write-Host "OK  removed $staged left by an interrupted update" -ForegroundColor Green
                $removed = $true
            }
        }
        $backupPattern = "^" + [regex]::Escape($f) + "(\.\d+)*\.bak$"
        foreach ($b in @(Get-ChildItem -Path $InstallDir -Filter "$f*.bak" -File -ErrorAction SilentlyContinue)) {
            if ($b.Name -notmatch $backupPattern) { continue }
            Remove-Item -Force $b.FullName -ErrorAction SilentlyContinue
            if (-not (Test-Path $b.FullName)) {
                Write-Host "OK  removed update backup $($b.FullName)" -ForegroundColor Green
                $removed = $true
            }
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
        # A checkout from another repository is foreign even when pristine.
        # Preserve it at a backup path rather than deleting it or resetting it.
        if ((Test-Path (Join-Path $SrcDir ".git")) -and -not (Test-SrcRemoteIsOurs $SrcDir)) {
            Write-Host "source checkout at $SrcDir does not track $RepoUrl; preserving it" -ForegroundColor Yellow
            Move-AsideExistingSrc $SrcDir
        # Never delete our own checkout when it holds uncommitted edits or
        # unpushed local branches. Only our own pristine tree is removed.
        } elseif (Test-SrcHasLocalWork $SrcDir) {
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
        # A PATH entry lives in the registry and reaches a process when that
        # process starts, so every terminal already open still has the entry this
        # uninstall just removed. Without this line, typing `veyyon` in one of
        # them answers with a path the user can see is gone, which reads as a
        # half-finished uninstall. Mirrors the same message in install.sh.
        if ($pathEntryRemoved) {
            Write-Host "  open terminals keep the old PATH entry until they restart"
        }
    } else {
        Write-Host "nothing to uninstall."
    }
}

# The sun, once, at the top of an install.
#
# Same mark install.sh prints, from the same owner: four bands of the ember ramp
# in packages/coding-agent/src/modes/components/sun.ts, drawn as lower blocks of
# rising height so the silhouette is a dome rather than a rectangle. A rectangle
# of solid blocks reads as a progress bar, and shading with the TUI's `.:-=` ramp
# averages to grey over seven cells. See scripts/installer-brand-parity.test.ts,
# which fails when the two suns stop agreeing about the color.
#
# ANSI rather than -ForegroundColor, because sixteen console colors cannot draw a
# gradient. Windows Terminal ($env:WT_SESSION) and PowerShell 7's VT support give
# real color; anywhere else, including the legacy console host, gets the plain
# ASCII form, since a wrong-looking logo is worse than a plain one.
# The lines the mark is made of, colored or plain. Split from the printing so it
# can be tested: a test process has its output redirected by definition, and
# Write-BrandMark declines to draw anything into a pipe.
function Get-BrandMarkLines {
    param([switch]$Color)
    if (-not $Color) { return @("", "  (*) v e y y o n", "") }
    $e = [char]27
    # EMBER bands 1, 4, 6, 7, 6, 4, 1. Band 4 is the brand ember the website's
    # --sun and the setup splash both rest on, so the brand color is IN the ramp
    # rather than near it.
    $disc = "$e[38;2;110;52;24m" + [char]0x2581 +
            "$e[38;2;240;134;46m" + [char]0x2583 +
            "$e[38;2;251;192;109m" + [char]0x2585 +
            "$e[38;2;255;227;173m" + [char]0x2588 +
            "$e[38;2;251;192;109m" + [char]0x2585 +
            "$e[38;2;240;134;46m" + [char]0x2583 +
            "$e[38;2;110;52;24m" + [char]0x2581
    # Silver for the name, matching the splash's wordmark rather than the ember.
    return @("", "  $disc$e[0m   $e[38;2;198;203;212m$e[1mv e y y o n$e[0m", "")
}

function Write-BrandMark {
    # Nothing into a pipe or a log, which keeps captured output stable.
    if ([Console]::IsOutputRedirected) { return }
    $color = [bool]($env:WT_SESSION) -and -not $env:NO_COLOR
    foreach ($line in (Get-BrandMarkLines -Color:$color)) { Write-Host $line }
}

# What the installer can be asked to do, and the single owner of the option list:
# -Help prints this, and the header of this file points here rather than carrying
# a second copy to go stale. Counterpart of usage() in install.sh.
#
# It exists because the options were documented in a comment at the top of the
# file, which is exactly what an `irm ... | iex` install never shows anyone.
function Write-Usage {
    Write-Host @"
veyyon installer

  irm https://veyyon.dev/install.ps1 | iex                                    install the latest release
  & ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) <options>   with options

Options:
  -Binary           Install the prebuilt binary (the default; no toolchain needed)
  -Local            Install the binary this checkout already built, from dist\vey.exe
  -Ref <tag>        Install a specific published release tag. A bare version
                    resolves to its published tag, so 1.0.37 and v1.0.37 are the
                    same release.
  -NoVerify         Skip the download's checksum verification (NOT recommended)
  -Uninstall        Remove veyyon, the vey shim, completions, and any source
                    checkout an older installer left behind
  -Help             Print this and exit

Environment:
  VEYYON_INSTALL_DIR   Where the binary goes (default %LOCALAPPDATA%\veyyon\bin)

After install, launch with vey in any repository.
"@
}

# Main logic. Guarded so the test harness can dot-source this file to exercise
# the helper functions in isolation without running a real install: set
# $env:VEYYON_INSTALL_SOURCED=1 before sourcing (mirrors install.sh).
if (-not $env:VEYYON_INSTALL_SOURCED) {
    # Every argument this installer has no parameter for, which now includes the
    # source-build flag it used to carry. PowerShell does not refuse an unmatched
    # argument to a script with a param block, it collects it in $args, so
    # without this a removed or misspelled flag would quietly install the latest
    # release and say nothing about the flag it ignored. Mirrors the
    # unknown-option arm of install.sh's argument loop: print the usage, then say
    # what was wrong with the command line.
    #
    # `$args -and` rather than `$args.Count` alone: under a caller's
    # `Set-StrictMode`, and this script runs in the caller's scope under
    # `irm | iex`, reading a property of an unset $args is itself an error.
    if ($args -and $args.Count -gt 0) {
        Write-Usage
        throw "unknown option: $($args[0])"
    }

    if ($Help) {
        Write-Usage
        return
    }
    if ($Uninstall) {
        Uninstall-Veyyon
        return
    }

    # An install is a good moment for a logo. A removal is not: a mark over an
    # uninstall reads as a sales pitch at exactly the wrong time.
    Write-BrandMark

    # A local install ignores $Ref entirely: there is no release to resolve.
    if ($Local) {
        Install-LocalBinary
        return
    }

    Install-Binary
}
