# Behavior tests for scripts/install.ps1 helper functions — the PATH-wiring path
# a Windows install depends on, run without any real install and without mutating
# the machine's environment (only the pure helpers are exercised).
#
# Dot-sources install.ps1 with VEYYON_INSTALL_SOURCED=1 so its Main logic does
# not run. Run: pwsh -File scripts/install-tests/functions.test.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$env:VEYYON_INSTALL_SOURCED = "1"
. (Join-Path $root "scripts/install.ps1")

$script:Pass = 0
$script:Fail = 0
function Check {
    param([string]$Desc, $Actual, $Expected)
    if ("$Actual" -ceq "$Expected") {
        $script:Pass++
    } else {
        $script:Fail++
        Write-Host "FAIL: $Desc"
        Write-Host "  expected [$Expected]"
        Write-Host "  got      [$Actual]"
    }
}

# --- Split-PathEntries: drops empty entries (an empty PATH entry means CWD) ---
Check "Split drops a leading empty entry" ((Split-PathEntries ";C:\a") -join '|') "C:\a"
Check "Split drops interior empty entries" ((Split-PathEntries "C:\a;;C:\b") -join '|') "C:\a|C:\b"
Check "Split of null yields no entries" (@(Split-PathEntries $null).Count) "0"
Check "Split of empty yields no entries" (@(Split-PathEntries "").Count) "0"

# --- Get-PathWithoutDir: uninstall takes the entry back out, exactly ---
# Uninstall never removed the PATH entry it added, so a user who installed and
# removed veyyon kept an entry pointing at a directory veyyon no longer
# occupies. Removal has to match entries the same way the add does, or it either
# misses (leaving the litter) or takes an unrelated directory with it.
Check "the install dir is removed" (Get-PathWithoutDir "C:\x;C:\a\bin;C:\y" "C:\a\bin") "C:\x;C:\y"
Check "removal is case-insensitive (Windows paths)" (Get-PathWithoutDir "C:\x;C:\A\BIN" "c:\a\bin") "C:\x"
Check "a trailing backslash on either side still matches" (Get-PathWithoutDir "C:\a\bin\;C:\y" "C:\a\bin") "C:\y"
Check "a prefix-sharing entry is NOT removed" (Get-PathWithoutDir "C:\a\bin2;C:\y" "C:\a\bin") "C:\a\bin2;C:\y"
Check "an absent dir leaves PATH unchanged" (Get-PathWithoutDir "C:\x;C:\y" "C:\a\bin") "C:\x;C:\y"
Check "removing the only entry yields an empty PATH" (Get-PathWithoutDir "C:\a\bin" "C:\a\bin") ""
Check "empty entries are cleaned out on removal" (Get-PathWithoutDir "C:\x;;C:\a\bin" "C:\a\bin") "C:\x"
# Round trip: what the add puts in, the removal takes back out, exactly.
Check "add then remove restores the original PATH" `
    (Get-PathWithoutDir (Get-PathWithDir "C:\x;C:\y" "C:\a\bin") "C:\a\bin") "C:\x;C:\y"

# --- Test-PathContainsDir: exact-entry match, NOT substring (the core bug) ---
# The old `-notlike "*$InstallDir*"` falsely reported the dir present when PATH
# held a longer entry sharing the prefix, so a needed PATH add was skipped and
# `veyyon` never landed on PATH.
Check "prefix-substring entry is NOT a match" `
    (Test-PathContainsDir "C:\a\bin2;C:\other" "C:\a\bin") "False"
Check "exact entry IS a match" `
    (Test-PathContainsDir "C:\other;C:\a\bin;C:\more" "C:\a\bin") "True"
Check "match is case-insensitive (Windows paths)" `
    (Test-PathContainsDir "C:\A\BIN" "c:\a\bin") "True"
Check "trailing backslash is normalized on both sides" `
    (Test-PathContainsDir "C:\a\bin\" "C:\a\bin") "True"
Check "absent dir is not matched" `
    (Test-PathContainsDir "C:\x;C:\y" "C:\a\bin") "False"
Check "null PATH contains nothing" `
    (Test-PathContainsDir $null "C:\a\bin") "False"
# A wildcard metacharacter in the dir must not be treated as a -like pattern.
Check "bracket metachar in dir is a literal, not a wildcard" `
    (Test-PathContainsDir "C:\proj[1];C:\z" "C:\proj[1]") "True"

# --- Get-NormalizedPathEntry: what makes two PATH entries "the same" ---------
# A real Windows PATH is not a clean list. Entries arrive quoted (which is legal,
# and what installers write around a path containing a space) and padded with
# spaces (which `PATH=%PATH%; C:\tools` leaves behind). Comparing those raw meant
# an entry we had already written did not match the directory we were about to
# write, so a reinstall appended a SECOND copy of the install dir and the
# uninstall then failed to take either one out. One normalizer owns the answer so
# the add, the remove and the presence check cannot disagree.
Check "an unremarkable entry is left alone" (Get-NormalizedPathEntry "C:\a\bin") "C:\a\bin"
Check "surrounding spaces are stripped" (Get-NormalizedPathEntry "  C:\a\bin  ") "C:\a\bin"
Check "a matched pair of quotes is stripped" (Get-NormalizedPathEntry '"C:\a\bin"') "C:\a\bin"
Check "quotes with padding inside and out are stripped" (Get-NormalizedPathEntry ' " C:\a\bin " ') "C:\a\bin"
Check "trailing backslashes are stripped" (Get-NormalizedPathEntry "C:\a\bin\\") "C:\a\bin"
Check "a quoted entry with a trailing backslash normalizes too" (Get-NormalizedPathEntry '"C:\Program Files\a\"') "C:\Program Files\a"
# A lone quote is NOT a quoted entry: stripping it would invent a path the user
# never wrote, and a path that legitimately begins with a quote is not a thing.
Check "a leading quote alone is kept" (Get-NormalizedPathEntry '"C:\a\bin') '"C:\a\bin'
Check "a trailing quote alone is kept" (Get-NormalizedPathEntry 'C:\a\bin"') 'C:\a\bin"'
Check "an inner space is preserved" (Get-NormalizedPathEntry '"C:\Program Files\veyyon"') "C:\Program Files\veyyon"
Check "an empty entry normalizes to empty" (Get-NormalizedPathEntry "") ""
Check "a null entry normalizes to empty" (Get-NormalizedPathEntry $null) ""

# The reason it exists: the reinstall and the uninstall both go through it.
Check "a QUOTED existing entry is recognized, so a reinstall does not double it" `
    (Test-PathContainsDir '"C:\a\bin";C:\x' "C:\a\bin") "True"
Check "a SPACE-PADDED existing entry is recognized" `
    (Test-PathContainsDir "C:\x; C:\a\bin ;C:\y" "C:\a\bin") "True"
Check "a quoted entry is left untouched when the dir is not ours" `
    (Test-PathContainsDir '"C:\a\bin2"' "C:\a\bin") "False"
Check "a reinstall over a quoted entry adds nothing" `
    (Get-PathWithDir '"C:\a\bin";C:\x' "C:\a\bin") '"C:\a\bin";C:\x'
Check "uninstall removes the entry it finds quoted" `
    (Get-PathWithoutDir '"C:\a\bin";C:\x' "C:\a\bin") "C:\x"
Check "uninstall removes the entry it finds padded" `
    (Get-PathWithoutDir "C:\x; C:\a\bin ;C:\y" "C:\a\bin") "C:\x;C:\y"

# --- Get-PathWithDir: PREPENDS distinctly, never a leading/duplicate ';' ---
# PATH order decides which copy of a name runs. Appending put the fresh install
# behind every older veyyon already on PATH, so the installer created the
# shadowing it then warned about in its own doctor step. install.sh has always
# prepended; these pin the same rule here.
Check "prepend to a null PATH has no trailing ';'" (Get-PathWithDir $null "C:\a\bin") "C:\a\bin"
Check "prepend to an empty PATH has no trailing ';'" (Get-PathWithDir "" "C:\a\bin") "C:\a\bin"
Check "the install dir goes at the FRONT of a normal PATH" (Get-PathWithDir "C:\x;C:\y" "C:\a\bin") "C:\a\bin;C:\x;C:\y"
Check "an older copy on PATH no longer shadows the fresh install" `
    (Get-PathWithDir "C:\old\veyyon;C:\y" "C:\a\bin") "C:\a\bin;C:\old\veyyon;C:\y"
Check "already-present dir leaves PATH unchanged" (Get-PathWithDir "C:\x;C:\a\bin" "C:\a\bin") "C:\x;C:\a\bin"
Check "a prefix-substring entry does NOT block the add" `
    (Get-PathWithDir "C:\a\bin2" "C:\a\bin") "C:\a\bin;C:\a\bin2"
Check "empty entries are cleaned out" (Get-PathWithDir "C:\x;;C:\y" "C:\a\bin") "C:\a\bin;C:\x;C:\y"

# --- checksum verification (mirrors install.sh verify_sha256) ---
# The binary install fails closed on a missing/empty/unparseable sidecar and on a
# hash mismatch. These lock the extracted pure parsers/comparators so a refactor
# cannot silently weaken the security-critical checksum path on Windows.
# A digest is exactly 64 hex characters. Anything else means the response was
# not a checksum (an HTML error page, a rate-limit body, a sidecar truncated by
# a dropped connection), and passing it through reports "checksum mismatch" —
# telling the user their download is corrupt when the sidecar was the problem.
# Same contract as install.sh's parse_sha256_sidecar and the TypeScript owner in
# packages/natives/src/sha256-sidecar.ts.
$sixtyFour = "a" * 64
Check "sidecar parse takes the leading hash token" (ConvertFrom-Sha256Sidecar "$sixtyFour  veyyon-windows-x64.exe") $sixtyFour
Check "sidecar parse reads a bare digest with no filename" (ConvertFrom-Sha256Sidecar $sixtyFour) $sixtyFour
Check "sidecar parse lowercases the hash" (ConvertFrom-Sha256Sidecar ("A" * 64 + "  veyyon.exe")) $sixtyFour
Check "sidecar parse tolerates leading/trailing whitespace" (ConvertFrom-Sha256Sidecar "   $sixtyFour  file`n") $sixtyFour
Check "sidecar parse splits on a tab too" (ConvertFrom-Sha256Sidecar "$sixtyFour`tfile") $sixtyFour
Check "sidecar parse of empty text is null" ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar ""))) "True"
Check "sidecar parse of whitespace-only text is null" ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar "   `n  "))) "True"
Check "sidecar parse rejects an HTML error page" `
    ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar "<!DOCTYPE html>`n<html>Not Found</html>"))) "True"
Check "sidecar parse rejects a rate-limit JSON body" `
    ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar '{"message":"API rate limit exceeded"}'))) "True"
Check "sidecar parse rejects a truncated digest" `
    ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar ("a" * 63 + "  veyyon.exe")))) "True"
Check "sidecar parse rejects an over-long digest" `
    ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar ("a" * 65 + "  veyyon.exe")))) "True"
Check "sidecar parse rejects 64 non-hex characters" `
    ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar ("g" * 64 + "  veyyon.exe")))) "True"
# sha256sum never emits the filename first; scanning the body for anything
# digest-shaped is how another field in a response gets promoted to the hash.
Check "sidecar parse rejects a digest that is not the first token" `
    ([string]::IsNullOrEmpty((ConvertFrom-Sha256Sidecar "veyyon.exe  $sixtyFour"))) "True"
# A concatenated sidecar must never verify against the wrong asset's digest.
Check "sidecar parse takes only the first line" `
    (ConvertFrom-Sha256Sidecar "$sixtyFour  veyyon-windows-x64.exe`n$("b" * 64)  veyyon-linux-x64") $sixtyFour

$hashFile = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-sha-$PID.bin"
"veyyon-integrity-fixture" | Set-Content -NoNewline -Path $hashFile
$realHash = (Get-FileHash -Path $hashFile -Algorithm SHA256).Hash.ToLower()
Check "Test-FileSha256 accepts the matching hash" (Test-FileSha256 -Path $hashFile -Expected $realHash) "True"
Check "Test-FileSha256 accepts an uppercase matching hash" (Test-FileSha256 -Path $hashFile -Expected $realHash.ToUpper()) "True"
Check "Test-FileSha256 fails closed on a wrong hash" (Test-FileSha256 -Path $hashFile -Expected "deadbeef") "False"
Check "Test-FileSha256 fails closed on an empty expected hash" (Test-FileSha256 -Path $hashFile -Expected "") "False"
Remove-Item -Force $hashFile -ErrorAction SilentlyContinue

# --- source-checkout data-loss protection (mirrors install.sh) ---
# The update path runs `git reset --hard`, and uninstall used to rm the checkout
# outright. Locks the Windows-side fix: a user's local edits under ~/.veyyon/src
# (an edited AGENTS.md) must be preserved on a veyyon-local-* branch before a
# reset, an existing tree must be moved aside rather than deleted before a fresh
# clone, and uninstall must never delete a checkout holding unpushed work.
if (Get-Command git -ErrorAction SilentlyContinue) {
    # Uninstall-Veyyon calls Test-BunInstalled/bun; stub it out so the src-handling
    # branch is exercised without touching a real global install.
    
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-$PID"
    if (Test-Path $sandbox) { Remove-Item -Recurse -Force $sandbox }
    New-Item -ItemType Directory -Force -Path $sandbox | Out-Null

    function New-TestRepo {
        param([string]$Dir)
        if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
        New-Item -ItemType Directory -Force -Path $Dir | Out-Null
        Push-Location $Dir
        try {
            git -c init.defaultBranch=main init -q 2>$null
            git config user.name t 2>$null
            git config user.email t@t 2>$null
            "committed" | Set-Content -NoNewline -Path (Join-Path $Dir "AGENTS.md")
            "node_modules/" | Set-Content -NoNewline -Path (Join-Path $Dir ".gitignore")
            git add -A 2>$null
            git commit -qm init 2>$null
        } finally { Pop-Location }
    }
    function New-ClonedRepo {
        param([string]$Dir)
        foreach ($p in @($Dir, "$Dir.origin")) { if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
        git -c init.defaultBranch=main init -q --bare "$Dir.origin" 2>$null
        git clone -q "$Dir.origin" $Dir 2>$null
        Push-Location $Dir
        try {
            git config user.name t 2>$null
            git config user.email t@t 2>$null
            "committed" | Set-Content -NoNewline -Path (Join-Path $Dir "AGENTS.md")
            git add -A 2>$null
            git commit -qm init 2>$null
            git push -q origin HEAD:refs/heads/main 2>$null
        } finally { Pop-Location }
    }
    # Discover preservation branches by ref (no `git branch` output parsing, which
    # varies by leading marker/whitespace across git versions).
    function Backup-BranchNames {
        param([string]$Dir)
        Push-Location $Dir
        try { return @(git for-each-ref --format='%(refname:short)' 'refs/heads/veyyon-local-*' 2>$null | Where-Object { $_ }) }
        finally { Pop-Location }
    }
    # Null-safe `git show <ref>` that returns a trimmed string, never throws on a
    # missing object (returns "" so the Check reports a clean mismatch, not a crash).
    function Git-ShowTrim {
        param([string]$Dir, [string]$Ref)
        Push-Location $Dir
        try {
            $o = git show $Ref 2>$null
            if ($null -eq $o) { return "" }
            return (($o -join "`n").Trim())
        } finally { Pop-Location }
    }

    # Preserve on a clean repo: no-op, no backup branch.
    $clean = Join-Path $sandbox "clean"
    New-TestRepo $clean
    Check "preserve returns true on a clean repo" (Preserve-LocalSrcChanges $clean) "True"
    Check "clean repo gets no backup branch" (@(Backup-BranchNames $clean).Count) "0"

    # Preserve on a dirty repo: the edit survives a hard reset via the branch.
    $dirty = Join-Path $sandbox "dirty"
    New-TestRepo $dirty
    "MY LOCAL EDIT" | Set-Content -NoNewline -Path (Join-Path $dirty "AGENTS.md")
    Check "preserve returns true on a modified tracked file" (Preserve-LocalSrcChanges $dirty) "True"
    $bdNames = @(Backup-BranchNames $dirty)
    Check "dirty repo gets exactly one backup branch" ($bdNames.Count) "1"
    $bd = $bdNames[0]
    Push-Location $dirty; git reset -q --hard HEAD 2>$null; Pop-Location
    $afterReset = (Git-ShowTrim $dirty "HEAD:AGENTS.md")
    $preserved = if ($bd) { Git-ShowTrim $dirty "${bd}:AGENTS.md" } else { "<no-branch>" }
    Check "hard reset cleared the working-tree edit" $afterReset "committed"
    Check "backup branch preserves the exact edited bytes" $preserved "MY LOCAL EDIT"

    # Preserve does not sweep gitignored artifacts into the backup.
    $mixed = Join-Path $sandbox "mixed"
    New-TestRepo $mixed
    "real edit" | Set-Content -NoNewline -Path (Join-Path $mixed "AGENTS.md")
    New-Item -ItemType Directory -Force -Path (Join-Path $mixed "node_modules") | Out-Null
    "junk" | Set-Content -NoNewline -Path (Join-Path $mixed "node_modules/x")
    Preserve-LocalSrcChanges $mixed | Out-Null
    $bmNames = @(Backup-BranchNames $mixed)
    $bm = if ($bmNames.Count -gt 0) { $bmNames[0] } else { "" }
    Push-Location $mixed
    $nm = if ($bm) { @(git ls-tree -r --name-only $bm 2>$null | Where-Object { $_ -like "*node_modules*" }).Count } else { -1 }
    Pop-Location
    Check "backup does NOT sweep in gitignored node_modules" $nm "0"

    # Move-aside relocates a non-empty non-git dir; keeps the file.
    $nd = Join-Path $sandbox "nongit"
    New-Item -ItemType Directory -Force -Path $nd | Out-Null
    "precious" | Set-Content -NoNewline -Path (Join-Path $nd "keep.txt")
    Move-AsideExistingSrc $nd
    Check "move-aside cleared the original path" (Test-Path $nd) "False"
    $ndbak = @(Get-ChildItem -Path $sandbox -Directory -Filter "nongit.bak-*")[0]
    Check "moved-aside backup keeps the file" ((Get-Content -Raw -Path (Join-Path $ndbak.FullName "keep.txt")).Trim()) "precious"

    # Move-aside removes an empty dir with no backup.
    $ed = Join-Path $sandbox "emptydir"
    New-Item -ItemType Directory -Force -Path $ed | Out-Null
    Move-AsideExistingSrc $ed
    Check "move-aside removed an empty dir" (Test-Path $ed) "False"
    Check "empty dir left no backup" (@(Get-ChildItem -Path $sandbox -Directory -Filter "emptydir.bak-*").Count) "0"

    # Test-SrcHasLocalWork classification.
    $pristine = Join-Path $sandbox "pristine"
    New-ClonedRepo $pristine
    Check "pristine pushed checkout reports no local work" (Test-SrcHasLocalWork $pristine) "False"

    $dirtywork = Join-Path $sandbox "dirtywork"
    New-ClonedRepo $dirtywork
    "MY EDIT" | Set-Content -NoNewline -Path (Join-Path $dirtywork "AGENTS.md")
    Check "uncommitted edit is flagged as local work" (Test-SrcHasLocalWork $dirtywork) "True"

    $branchwork = Join-Path $sandbox "branchwork"
    New-ClonedRepo $branchwork
    Push-Location $branchwork
    git checkout -q -b veyyon-local-teststamp 2>$null
    "preserved edit" | Set-Content -NoNewline -Path (Join-Path $branchwork "AGENTS.md")
    git add -A 2>$null; git commit -qm wip 2>$null; git checkout -q main 2>$null
    Pop-Location
    Check "unpushed veyyon-local branch is flagged as local work" (Test-SrcHasLocalWork $branchwork) "True"

    $ngw = Join-Path $sandbox "nongitwork"
    New-Item -ItemType Directory -Force -Path $ngw | Out-Null
    "x" | Set-Content -NoNewline -Path (Join-Path $ngw "file.txt")
    Check "non-git tree with files is flagged as local work" (Test-SrcHasLocalWork $ngw) "True"

    # Full uninstall: a checkout with unpushed work is moved aside, not deleted.
    $us = Join-Path $sandbox "uninstall-src"
    New-ClonedRepo $us
    Push-Location $us
    git checkout -q -b veyyon-local-keep 2>$null
    "RECOVER ME" | Set-Content -NoNewline -Path (Join-Path $us "AGENTS.md")
    git add -A 2>$null; git commit -qm wip 2>$null; git checkout -q main 2>$null
    Pop-Location
    $SrcDir = $us
    $InstallDir = Join-Path $sandbox "nowhere-bin"
    Uninstall-Veyyon | Out-Null
    Check "uninstall did NOT delete a checkout holding unpushed work" (Test-Path $us) "False"
    $usbak = @(Get-ChildItem -Path $sandbox -Directory -Filter "uninstall-src.bak-*")[0]
    Check "uninstall moved the checkout aside instead of deleting" (Test-Path (Join-Path $usbak.FullName ".git")) "True"
    Push-Location $usbak.FullName
    $rec = (git show "veyyon-local-keep:AGENTS.md" 2>$null).Trim()
    Pop-Location
    Check "moved-aside checkout still has the recoverable edit" $rec "RECOVER ME"

    # A pristine, fully-pushed checkout is removed outright.
    $up = Join-Path $sandbox "uninstall-pristine"
    New-ClonedRepo $up
    $SrcDir = $up
    Uninstall-Veyyon | Out-Null
    Check "uninstall removes a pristine pushed checkout outright" (Test-Path $up) "False"
    Check "pristine uninstall left no move-aside backup" (@(Get-ChildItem -Path $sandbox -Directory -Filter "uninstall-pristine.bak-*").Count) "0"

    Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
} else {
    Write-Host "SKIP: git not available; source-checkout preservation tests skipped"
}

# --- Test-NotShadowed: an older copy earlier on PATH must be reported ---
# The classic silent install failure: a previous install keeps winning every
# invocation while the installer reports success, so the user "upgrades" and
# nothing changes. Presence on PATH is not proof; where the name RESOLVES is.
$shadowSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-shadow-$PID"
if (Test-Path $shadowSandbox) { Remove-Item -Recurse -Force $shadowSandbox }
$origPath = $env:PATH
try {
    $mine = Join-Path $shadowSandbox "mine"
    $older = Join-Path $shadowSandbox "older"
    New-Item -ItemType Directory -Force -Path $mine, $older | Out-Null
    foreach ($d in @($mine, $older)) {
        "@echo off`r`necho veyyon/9.9.9" | Set-Content -Path (Join-Path $d "veyyon.cmd")
        "@echo off`r`necho veyyon/9.9.9" | Set-Content -Path (Join-Path $d "vey.cmd")
    }

    # Healthy: the install dir wins PATH, so both names resolve into it.
    $env:PATH = "$mine;$origPath"
    $healthy = (Test-NotShadowed -Name "veyyon" -WantDir $mine 6>&1 | Out-String) +
               (Test-NotShadowed -Name "vey" -WantDir $mine 6>&1 | Out-String)
    Check "PS doctor confirms veyyon resolves to the fresh install" ([bool]($healthy -match "'veyyon' on PATH resolves to this install")) "True"
    Check "PS doctor confirms the vey alias resolves to the fresh install" ([bool]($healthy -match "'vey' on PATH resolves to this install")) "True"
    Check "a healthy PS doctor warns about nothing" ([bool]($healthy -match "!!")) "False"

    # Shadowed: an older copy earlier on PATH wins; the offender must be named.
    $env:PATH = "$older;$mine;$origPath"
    $shadowed = (Test-NotShadowed -Name "veyyon" -WantDir $mine 6>&1 | Out-String)
    Check "PS doctor reports veyyon is shadowed" ([bool]($shadowed -match "!!")) "True"
    Check "PS doctor names the shadowing path" ([bool]($shadowed -match [regex]::Escape((Join-Path $older "veyyon.cmd")))) "True"
    Check "PS doctor names the install dir that lost" ([bool]($shadowed -match [regex]::Escape($mine))) "True"

    # Absent from PATH: a distinct, actionable message, not a shadow warning.
    $env:PATH = Join-Path $shadowSandbox "nonexistent"
    $absent = (Test-NotShadowed -Name "veyyon" -WantDir $mine 6>&1 | Out-String)
    Check "PS doctor tells the user to add the dir when the name is absent" ([bool]($absent -match "not on PATH yet")) "True"
    Check "an absent name is not misreported as shadowed" ([bool]($absent -match "shadows this one")) "False"
} finally {
    $env:PATH = $origPath
    Remove-Item -Recurse -Force $shadowSandbox -ErrorAction SilentlyContinue
}

# --- uninstall reclaims the native addon cache, never the user's data ---
# A binary install stages ~150MB per version under getNativesDir()
# (packages/natives/native/loader-state.js). Uninstall used to leave every one of
# them behind, so uninstalling "succeeded" while the disk was never freed and a
# later reinstall silently inherited stale addons. It must reclaim the cache and
# ONLY the cache: auth/config/sessions sit beside it under ~/.veyyon and are the
# user's data. Mirrors the same assertions in functions.test.sh.
function Test-BunInstalled { return $false }
$nativesSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-natives-$PID"
if (Test-Path $nativesSandbox) { Remove-Item -Recurse -Force $nativesSandbox }
$origUserProfile = $env:USERPROFILE
$origXdg = $env:XDG_DATA_HOME
try {
    # Fallback path: no XDG, so the cache is %USERPROFILE%\.veyyon\natives.
    $home1 = Join-Path $nativesSandbox "home1"
    $env:USERPROFILE = $home1
    $env:XDG_DATA_HOME = $null
    New-Item -ItemType Directory -Force -Path (Join-Path $home1 ".veyyon\natives\1.0.37") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $home1 ".veyyon\sessions") | Out-Null
    "STAGED-ADDON" | Set-Content -NoNewline -Path (Join-Path $home1 ".veyyon\natives\1.0.37\veyyon_natives.win32-x64-msvc.node")
    '{"token":"keep-me"}' | Set-Content -NoNewline -Path (Join-Path $home1 ".veyyon\auth.json")
    $SrcDir = Join-Path $nativesSandbox "no-such-src"
    $InstallDir = Join-Path $nativesSandbox "nowhere-bin"
    Uninstall-Veyyon | Out-Null
    Check "uninstall removed the native addon cache (USERPROFILE\.veyyon\natives)" (Test-Path (Join-Path $home1 ".veyyon\natives")) "False"
    Check "uninstall preserved .veyyon\auth.json (user credentials)" ((Get-Content -Raw (Join-Path $home1 ".veyyon\auth.json")).Trim()) '{"token":"keep-me"}'
    Check "uninstall preserved .veyyon\sessions (user data)" (Test-Path (Join-Path $home1 ".veyyon\sessions")) "True"

    # XDG path: getNativesDir() prefers $XDG_DATA_HOME/veyyon/natives ONLY when
    # $XDG_DATA_HOME/veyyon already exists, so uninstall must remove exactly that
    # directory and leave the now-inactive USERPROFILE cache alone.
    $home2 = Join-Path $nativesSandbox "home2"
    $xdg2 = Join-Path $nativesSandbox "xdg2"
    $env:USERPROFILE = $home2
    $env:XDG_DATA_HOME = $xdg2
    New-Item -ItemType Directory -Force -Path (Join-Path $xdg2 "veyyon\natives\1.0.37") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $home2 ".veyyon\natives\1.0.37") | Out-Null
    "XDG-ADDON" | Set-Content -NoNewline -Path (Join-Path $xdg2 "veyyon\natives\1.0.37\veyyon_natives.win32-x64-msvc.node")
    "HOME-ADDON" | Set-Content -NoNewline -Path (Join-Path $home2 ".veyyon\natives\1.0.37\veyyon_natives.win32-x64-msvc.node")
    Uninstall-Veyyon | Out-Null
    Check "uninstall removed the XDG native cache when XDG_DATA_HOME\veyyon exists" (Test-Path (Join-Path $xdg2 "veyyon\natives")) "False"
    Check "uninstall left the inactive USERPROFILE cache when XDG is active" (Test-Path (Join-Path $home2 ".veyyon\natives")) "True"

    # Addons staged beside the binary are swept too: a reinstalled binary must
    # never find a stale sibling addon left by the version it replaced.
    $binDir = Join-Path $nativesSandbox "bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    "SIBLING-ADDON" | Set-Content -NoNewline -Path (Join-Path $binDir "veyyon_natives.win32-x64-msvc.node")
    $InstallDir = $binDir
    Uninstall-Veyyon | Out-Null
    Check "uninstall swept the addon staged beside the binary" (Test-Path (Join-Path $binDir "veyyon_natives.win32-x64-msvc.node")) "False"

    # `veyyon update` stages at `<binary>.new` and keeps the binary it replaces as
    # `<binary>.<timestamp>.<pid>.bak` until the new one has proved itself. Windows
    # cannot unlink a running process image, so that backup routinely outlives the
    # update, and a killed update leaves the staged file. Neither is dot-prefixed,
    # so the `*.old` and `.veyyon.*.download` sweeps never matched them and
    # uninstall reported success while leaving a few hundred megabytes named
    # `veyyon.exe.new` in a directory the user was told is now empty. Mirrors the
    # same assertions in functions.test.sh.
    $updDir = Join-Path $nativesSandbox "update-leftovers"
    New-Item -ItemType Directory -Force -Path $updDir | Out-Null
    "STAGED" | Set-Content -NoNewline -Path (Join-Path $updDir "veyyon.exe.new")
    "PREVIOUS" | Set-Content -NoNewline -Path (Join-Path $updDir "veyyon.exe.1753660000.4242.bak")
    "LEGACY" | Set-Content -NoNewline -Path (Join-Path $updDir "veyyon.exe.bak")
    # Not ours: a copy somebody saved by hand under a name of their own.
    "MINE" | Set-Content -NoNewline -Path (Join-Path $updDir "veyyon.exe.mine.bak")
    $InstallDir = $updDir
    Uninstall-Veyyon | Out-Null
    Check "uninstall removes a staged update download" (Test-Path (Join-Path $updDir "veyyon.exe.new")) "False"
    Check "uninstall removes a timestamped update backup" (Test-Path (Join-Path $updDir "veyyon.exe.1753660000.4242.bak")) "False"
    Check "uninstall removes the legacy fixed-name backup" (Test-Path (Join-Path $updDir "veyyon.exe.bak")) "False"
    Check "a hand-named backup survives uninstall" ((Get-Content -Raw (Join-Path $updDir "veyyon.exe.mine.bak")).Trim()) "MINE"
} finally {
    $env:USERPROFILE = $origUserProfile
    $env:XDG_DATA_HOME = $origXdg
    Remove-Item -Recurse -Force $nativesSandbox -ErrorAction SilentlyContinue
}

# --- Test-AliasPointsAtUs: the alias is ours only when it forwards to us ---
# Install-Alias refuses to overwrite a vey.cmd the installer did not write, and
# the doctor's shadow check must follow that decision: reporting that a user's
# OWN vey "shadows the copy just installed" and telling them to remove it is
# false, because no vey was installed at all. Mirrors alias_points_at_us in
# install.sh. Pure filesystem, no install performed.
$aliasSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-alias-$PID"
if (Test-Path $aliasSandbox) { Remove-Item -Recurse -Force $aliasSandbox }
try {
    New-Item -ItemType Directory -Force -Path $aliasSandbox | Out-Null
    $ourBin = Join-Path $aliasSandbox "veyyon.exe"
    "BINARY" | Set-Content -NoNewline -Path $ourBin
    $shim = Join-Path $aliasSandbox "vey.cmd"

    Check "no alias file at all is not ours" (Test-AliasPointsAtUs -BinPath $ourBin) "False"

    # A shim forwarding somewhere else is the user's, whatever it is called.
    "@echo off`r`n`"C:\their\tool.exe`" %*" | Set-Content -Path $shim -Encoding ASCII
    Check "a shim forwarding elsewhere is not ours" (Test-AliasPointsAtUs -BinPath $ourBin) "False"

    # The shim Install-Alias itself writes.
    "@echo off`r`n`"$ourBin`" %*" | Set-Content -Path $shim -Encoding ASCII
    Check "a shim forwarding to our binary is ours" (Test-AliasPointsAtUs -BinPath $ourBin) "True"
} finally {
    Remove-Item -Recurse -Force $aliasSandbox -ErrorAction SilentlyContinue
}

# --- Get-LfsTrackedFile / Get-LfsAssets: LFS content is fetched or we stop ---
# The old line was `if (Test-GitLfsInstalled) { git lfs pull | Out-Null }`: with
# git-lfs absent the pull never ran, and with it present a failure was swallowed
# by Out-Null and an unread $LASTEXITCODE. Either way LFS-tracked files stay
# ~130-byte pointer TEXT files, the install reports success, and veyyon fails
# later on a file that looks present. Mirrors fetch_lfs_assets in install.sh.
if (Get-Command git -ErrorAction SilentlyContinue) {
    $lfsSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-lfs-$PID"
    if (Test-Path $lfsSandbox) { Remove-Item -Recurse -Force $lfsSandbox }
    try {
        New-Item -ItemType Directory -Force -Path $lfsSandbox | Out-Null
        Push-Location $lfsSandbox
        git init -q . 2>$null | Out-Null
        git config user.email "t@t" | Out-Null
        git config user.name "t" | Out-Null
        "hi" | Set-Content -Path (Join-Path $lfsSandbox "a.txt")
        git add a.txt | Out-Null
        git commit -qm init 2>$null | Out-Null
        Pop-Location

        Check "a plain checkout tracks nothing through LFS" ([string]::IsNullOrEmpty((Get-LfsTrackedFile -SrcDir $lfsSandbox))) "True"

        # Today's real repo state: .gitattributes DECLARES an LFS filter but no
        # tracked file matches it. That must not block an install, or every
        # source install without git-lfs breaks on a rule governing zero files.
        Push-Location $lfsSandbox
        "*.wasm filter=lfs diff=lfs merge=lfs -text" | Set-Content -Path (Join-Path $lfsSandbox ".gitattributes")
        git add .gitattributes | Out-Null
        git commit -qm attrs 2>$null | Out-Null
        Pop-Location
        Check "a declaration matching no file is not LFS content" ([string]::IsNullOrEmpty((Get-LfsTrackedFile -SrcDir $lfsSandbox))) "True"

        # A file the filter actually matches: this checkout genuinely needs LFS.
        Push-Location $lfsSandbox
        "pointer" | Set-Content -Path (Join-Path $lfsSandbox "shipped.wasm")
        git add shipped.wasm | Out-Null
        git commit -qm wasm 2>$null | Out-Null
        Pop-Location
        Check "a matching file is reported as LFS-tracked" (Get-LfsTrackedFile -SrcDir $lfsSandbox) "shipped.wasm"

        # With git-lfs unavailable, the install must stop and say why.
        function Test-GitLfsInstalled { return $false }
        $lfsError = ""
        try { Get-LfsAssets -SrcDir $lfsSandbox } catch { $lfsError = $_.Exception.Message }
        Check "a checkout needing LFS without git-lfs stops the install" ([bool]($lfsError -match "git-lfs is not installed")) "True"
        Check "the stop explains pointer text, not a bare failure" ([bool]($lfsError -match "pointer text")) "True"
        Check "the stop links where to get git-lfs" ([bool]($lfsError -match [regex]::Escape("https://git-lfs.com"))) "True"
    } finally {
        Remove-Item -Recurse -Force $lfsSandbox -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "SKIP: git not available; Get-LfsAssets tests skipped"
}

# --- Uninstall keeps a `vey.cmd` the installer never created ---
# Install-Alias refuses to overwrite a vey.cmd the user already has, and says so.
# Uninstall deleted it anyway, so removing veyyon destroyed the user's own
# command. This is the identity gate that was missing.
$aliasSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-alias-$PID"
New-Item -ItemType Directory -Force -Path $aliasSandbox | Out-Null
try {
    $shim = Join-Path $aliasSandbox "vey.cmd"

    Set-Content -LiteralPath $shim -Value "@echo off`r`n`"$(Join-Path $aliasSandbox 'veyyon.exe')`" %*"
    Check "a shim forwarding to our exe is ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "True"

    # A source install shims to veyyon.cmd instead; both are ours.
    Set-Content -LiteralPath $shim -Value "@echo off`r`n`"$(Join-Path $aliasSandbox 'veyyon.cmd')`" %*"
    Check "a shim forwarding to our cmd launcher is ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "True"

    Set-Content -LiteralPath $shim -Value "@echo off`r`necho their tool"
    Check "an unrelated vey.cmd is NOT ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    # A shim forwarding to a DIFFERENT veyyon (another install dir) is not this
    # installation's to remove.
    Set-Content -LiteralPath $shim -Value "@echo off`r`n`"C:\elsewhere\veyyon.exe`" %*"
    Check "a shim pointing at another install is not ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    Remove-Item -Force $shim
    Check "a missing shim is not ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    Set-Content -LiteralPath $shim -Value ""
    Check "an empty shim is not ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"
} finally {
    Remove-Item -Recurse -Force $aliasSandbox -ErrorAction SilentlyContinue
}

# --- Move-StagedBinaryIntoPlace: an empty download never becomes the binary ---
# install.sh has refused a zero-byte staged file since finalize_binary existed;
# the Windows side had no such guard. Invoke-WebRequest writes the file before it
# knows the body is empty, and -NoVerify skips the checksum entirely, so an empty
# asset installed cleanly and left the user with a veyyon that could not start.
$stageSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-staging-$PID"
New-Item -ItemType Directory -Force -Path $stageSandbox | Out-Null
try {
    $target = Join-Path $stageSandbox "veyyon.exe"
    $staging = Join-Path $stageSandbox ".veyyon.download"

    # An existing working binary must survive a failed install: that is the whole
    # reason the download is staged rather than written onto the target.
    Set-Content -LiteralPath $target -Value "previous working binary"
    New-Item -ItemType File -Force -Path $staging | Out-Null
    $stageError = ""
    try { Move-StagedBinaryIntoPlace -StagingPath $staging -TargetPath $target } catch { $stageError = $_.Exception.Message }
    Check "an empty staged file is refused" ([bool]($stageError -match "is empty")) "True"
    Check "the refusal names the staged path" ([bool]($stageError -match [regex]::Escape($staging))) "True"
    Check "the refusal tells the user to retry the download" ([bool]($stageError -match "retry or use -Source")) "True"
    Check "the previous binary is untouched" (Get-Content -Raw $target).Trim() "previous working binary"
    Check "the empty staged file is cleaned up" (Test-Path $staging) "False"

    # A missing staged file is the same failure, not a crash on a null length.
    $stageError = ""
    try { Move-StagedBinaryIntoPlace -StagingPath (Join-Path $stageSandbox "absent") -TargetPath $target } catch { $stageError = $_.Exception.Message }
    Check "a missing staged file is refused too" ([bool]($stageError -match "is empty")) "True"

    # The good path still works: a non-empty staged file replaces the target.
    Set-Content -LiteralPath $staging -Value "new binary"
    Move-StagedBinaryIntoPlace -StagingPath $staging -TargetPath $target
    Check "a non-empty staged file replaces the target" (Get-Content -Raw $target).Trim() "new binary"
    Check "the staged file is gone after a successful move" (Test-Path $staging) "False"
} finally {
    Remove-Item -Recurse -Force $stageSandbox -ErrorAction SilentlyContinue
}

# --- PowerShell completions: the profile edit is surgical and reversible ---
# Windows had no tab completion at all. PowerShell registers completion at
# runtime instead of autoloading a file, so the installer writes a script and
# adds one dot-source line to the profile. That line is an edit to a file the
# user also owns, so it has to go in exactly once and come back out exactly.
$completionSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-completions-$PID"
New-Item -ItemType Directory -Force -Path $completionSandbox | Out-Null
try {
    $profilePath = Join-Path $completionSandbox "profile.ps1"
    $line = Get-CompletionSourceLine "C:\veyyon\veyyon-completions.ps1"

    Check "the dot-source line is a real dot-source of the quoted path" $line ". `"C:\veyyon\veyyon-completions.ps1`""

    # Adding to a profile that does not exist yet must create it, not fail.
    Check "the line is added to a missing profile" (Add-CompletionSourceLine -ProfilePath $profilePath -Line $line) "True"
    Check "the profile now holds the line" ([bool]((Get-Content $profilePath) -contains $line)) "True"
    Check "the line is written under the marker comment" ([bool]((Get-Content $profilePath) -contains $CompletionMarker)) "True"

    # Re-running the installer must not stack duplicate lines in the profile.
    Check "a second install does not add the line again" (Add-CompletionSourceLine -ProfilePath $profilePath -Line $line) "False"
    Check "the line still appears exactly once" (@(Get-Content $profilePath | Where-Object { $_ -eq $line }).Count) "1"

    # The user's own profile content has to survive the removal untouched.
    Add-Content -LiteralPath $profilePath -Value @("Set-Alias ll Get-ChildItem", "# my own note")
    Check "removal reports it changed the profile" (Remove-CompletionSourceLine -ProfilePath $profilePath -Line $line) "True"
    Check "the dot-source line is gone" ([bool]((Get-Content $profilePath) -contains $line)) "False"
    Check "the marker comment went with it" ([bool]((Get-Content $profilePath) -contains $CompletionMarker)) "False"
    Check "the user's own alias survived" ([bool]((Get-Content $profilePath) -contains "Set-Alias ll Get-ChildItem")) "True"
    Check "the user's own comment survived" ([bool]((Get-Content $profilePath) -contains "# my own note")) "True"

    # Removing again is a no-op, and says so: uninstall must not claim work it
    # did not do.
    Check "a second removal reports no change" (Remove-CompletionSourceLine -ProfilePath $profilePath -Line $line) "False"

    # Set-Content truncates before it writes, so a successful rewrite must clean
    # up its backup and a failed one must keep it. The success half is checked
    # here; the failure half cannot be forced without a filesystem fault, so the
    # contract is asserted statically in scripts/installer-completions-parity.test.ts.
    Add-Content -LiteralPath $profilePath -Value @($CompletionMarker, $line)
    Check "a successful removal reports the change" (Remove-CompletionSourceLine -ProfilePath $profilePath -Line $line) "True"
    Check "a successful removal leaves no backup behind" `
        (@(Get-ChildItem -Path (Split-Path -Parent $profilePath) -Filter "*.veyyon-uninstall.*" -File -ErrorAction SilentlyContinue).Count) "0"

    # A marker comment the user happens to have, with no veyyon line under it,
    # is not ours to delete.
    $foreignProfile = Join-Path $completionSandbox "foreign.ps1"
    Set-Content -LiteralPath $foreignProfile -Value @($CompletionMarker, "Write-Host hi", $line)
    Check "an unrelated marker stays when it is not above our line" (Remove-CompletionSourceLine -ProfilePath $foreignProfile -Line $line) "True"
    Check "the marker not adjacent to our line survived" ([bool]((Get-Content $foreignProfile) -contains $CompletionMarker)) "True"
    Check "the user's line between them survived" ([bool]((Get-Content $foreignProfile) -contains "Write-Host hi")) "True"

    # A profile that never held the line must not be rewritten at all.
    $untouched = Join-Path $completionSandbox "untouched.ps1"
    Set-Content -LiteralPath $untouched -Value @("Write-Host mine")
    $before = Get-Content -Raw $untouched
    Check "an unrelated profile reports no change" (Remove-CompletionSourceLine -ProfilePath $untouched -Line $line) "False"
    Check "an unrelated profile is byte-identical afterwards" (Get-Content -Raw $untouched) $before

    # A prefix-sharing path is a different install: its line is not ours.
    $otherLine = Get-CompletionSourceLine "C:\veyyon-other\veyyon-completions.ps1"
    $prefixProfile = Join-Path $completionSandbox "prefix.ps1"
    Set-Content -LiteralPath $prefixProfile -Value @($CompletionMarker, $otherLine)
    Check "a prefix-sharing dot-source line is left alone" (Remove-CompletionSourceLine -ProfilePath $prefixProfile -Line $line) "False"
    Check "that line is still in the profile" ([bool]((Get-Content $prefixProfile) -contains $otherLine)) "True"

    # The generated script must go where the profile can dot-source it.
    Check "the completion script sits beside the profile" `
        (Split-Path -Parent (Get-CompletionScriptPath)) (Split-Path -Parent (Get-ProfilePath))
    Check "the completion script is named for the binary" `
        (Split-Path -Leaf (Get-CompletionScriptPath)) "veyyon-completions.ps1"
} finally {
    Remove-Item -Recurse -Force $completionSandbox -ErrorAction SilentlyContinue
}

# --- Test-NativeAddon: the phase label, and what it refuses ---
# The preflight run probes the STAGED download so a release with no build for
# this architecture never reaches the install dir, the alias, PATH or the
# completion script. Both runs are the same function; only the wording moves.
$nativeSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-natives-$PID"
New-Item -ItemType Directory -Force -Path $nativeSandbox | Out-Null
try {
    # Stubs are .cmd files so `& $Command grep ...` runs them the way a real exe runs.
    function New-StubBinary {
        param([string]$Name, [string]$GrepBody)
        $path = Join-Path $nativeSandbox "$Name.cmd"
        Set-Content -LiteralPath $path -Value @"
@echo off
if "%1"=="grep" if "%2"=="--help" exit /b 0
if "%1"=="grep" ( $GrepBody )
echo veyyon/9.9.9
"@
        return $path
    }

    $good = New-StubBinary -Name "good" -GrepBody "echo %3\probe.txt:1: match & exit /b 0"
    $noAddon = New-StubBinary -Name "noaddon" -GrepBody "echo dlopen failed 1>&2 & exit /b 127"
    $empty = New-StubBinary -Name "empty" -GrepBody "echo Total matches: 0 & exit /b 0"

    $ok = $true
    try { Test-NativeAddon -Command $good *> $null } catch { $ok = $false }
    Check "Test-NativeAddon accepts a binary whose search works" $ok "True"

    # The failure this exists to catch: --version would have said this is fine.
    $threw = $false
    try { Test-NativeAddon -Command $noAddon *> $null } catch { $threw = $true }
    Check "Test-NativeAddon fails closed when the addon did not load" $threw "True"

    # Exit 0 with no match is the quieter half of the same breakage.
    $threw = $false
    try { Test-NativeAddon -Command $empty *> $null } catch { $threw = $true }
    Check "Test-NativeAddon fails closed on a search that finds nothing" $threw "True"

    # The phase word is what tells the user WHEN it broke: a rejected download
    # left their machine untouched, a rejected install did not.
    $msg = ""
    try { Test-NativeAddon -Command $noAddon -Phase "downloaded" *> $null } catch { $msg = $_.Exception.Message }
    Check "Test-NativeAddon names the downloaded phase" ($msg -like "*the downloaded veyyon starts but cannot run a search*") "True"

    $msg = ""
    try { Test-NativeAddon -Command $noAddon *> $null } catch { $msg = $_.Exception.Message }
    Check "Test-NativeAddon defaults to the installed phase" ($msg -like "*the installed veyyon starts but cannot run a search*") "True"

    # An older release with no grep subcommand is not a broken install.
    $nogrep = Join-Path $nativeSandbox "nogrep.cmd"
    Set-Content -LiteralPath $nogrep -Value "@echo off`r`nif `"%1`"==`"grep`" exit /b 1`r`necho veyyon/0.0.1"
    $ok = $true
    try { Test-NativeAddon -Command $nogrep *> $null } catch { $ok = $false }
    Check "Test-NativeAddon skips a build with no grep command" $ok "True"

    # The probe must not leave its scratch directory behind on either path.
    $probeDir = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-doctor.$PID"
    try { Test-NativeAddon -Command $noAddon *> $null } catch { }
    Check "Test-NativeAddon removes its probe directory after a failure" (Test-Path $probeDir) "False"
    try { Test-NativeAddon -Command $good *> $null } catch { }
    Check "Test-NativeAddon removes its probe directory after a success" (Test-Path $probeDir) "False"
} finally {
    Remove-Item -Recurse -Force $nativeSandbox -ErrorAction SilentlyContinue
}

# --- the user PATH is read and written raw, so %VAR% entries survive ---
#
# WHY THESE EXIST. `[Environment]::GetEnvironmentVariable("Path","User")` EXPANDS
# the value and `SetEnvironmentVariable` writes a plain REG_SZ, so the pair froze
# every `%JAVA_HOME%\bin`-style entry in the user's PATH to whatever it expanded
# to at install time. The damage was permanent, silent, and to an environment
# veyyon does not own. The installer now reads the raw value and writes it back
# under the kind it already had.
#
# These use a scratch registry key rather than the real HKCU\Environment: the
# point is to prove the read/modify/write round trip preserves the token, and
# doing that against the real PATH would risk the machine running the tests.
$envKeyPath = "Software\veyyon-install-tests\$PID"
$scratch = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($envKeyPath)
try {
    # Resolve-PathValueKind is pure: preserve what is there, and default to
    # ExpandString when creating the value, which is what Windows itself does.
    Check "Resolve-PathValueKind preserves an existing ExpandString" `
        (Resolve-PathValueKind -ExistingKind ([Microsoft.Win32.RegistryValueKind]::ExpandString) -Value "C:\a") `
        "ExpandString"
    Check "Resolve-PathValueKind preserves an existing String" `
        (Resolve-PathValueKind -ExistingKind ([Microsoft.Win32.RegistryValueKind]::String) -Value "%FOO%\a") `
        "String"
    Check "Resolve-PathValueKind creates a missing value as ExpandString" `
        (Resolve-PathValueKind -ExistingKind $null -Value "C:\a") `
        "ExpandString"
    # A REG_SZ holding a literal %FOO% is not a mistake to correct: Windows will
    # not expand it, and promoting it would change how that entry resolves.
    Check "Resolve-PathValueKind does not promote a String that contains a token" `
        (Resolve-PathValueKind -ExistingKind ([Microsoft.Win32.RegistryValueKind]::String) -Value "%FOO%") `
        "String"

    # THE REGRESSION, driven through the registry: a REG_EXPAND_SZ value read
    # with DoNotExpandEnvironmentNames comes back with its token intact.
    $scratch.SetValue("Path", "%USERPROFILE%\tools;C:\fixed", [Microsoft.Win32.RegistryValueKind]::ExpandString)
    $raw = $scratch.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    Check "a raw read keeps the %USERPROFILE% token" ($raw -like "*%USERPROFILE%\tools*") "True"
    # And the .NET accessor is what would have destroyed it: the expanded read
    # no longer contains the token at all.
    $expanded = $scratch.GetValue("Path")
    Check "an expanding read loses the token (this is the bug)" ($expanded -like "*%USERPROFILE%*") "False"

    # The full round trip the installer performs: read raw, add our entry, write
    # back under the original kind. The token and the kind both survive.
    $updated = Get-PathWithDir $raw "C:\veyyon\bin"
    $kind = Resolve-PathValueKind -ExistingKind ($scratch.GetValueKind("Path")) -Value $updated
    $scratch.SetValue("Path", $updated, $kind)
    $after = $scratch.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    Check "the round trip keeps the %USERPROFILE% token" ($after -like "*%USERPROFILE%\tools*") "True"
    Check "the round trip keeps the value REG_EXPAND_SZ" ($scratch.GetValueKind("Path")) "ExpandString"
    Check "the round trip added our entry" ($after -like "*C:\veyyon\bin*") "True"

    # Uninstall takes only our entry back out, leaving the token and the kind.
    $removed = Get-PathWithoutDir $after "C:\veyyon\bin"
    $scratch.SetValue("Path", $removed, (Resolve-PathValueKind -ExistingKind ($scratch.GetValueKind("Path")) -Value $removed))
    $final = $scratch.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    Check "removal keeps the %USERPROFILE% token" ($final -like "*%USERPROFILE%\tools*") "True"
    Check "removal keeps the value REG_EXPAND_SZ" ($scratch.GetValueKind("Path")) "ExpandString"
    Check "removal took our entry out" ($final -like "*C:\veyyon\bin*") "False"
    Check "removal left the user's fixed entry" ($final -like "*C:\fixed*") "True"
} finally {
    $scratch.Dispose()
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree("Software\veyyon-install-tests", $false)
}

# --- Get-RawUserPath tolerates a profile with no Path value yet ---
# A fresh user has no Path under HKCU\Environment at all. Returning $null there
# would make the first install throw on a machine that had never had one.
$fresh = Get-RawUserPath
Check "Get-RawUserPath returns a string, never null" ($null -ne $fresh.Value) "True"

$ps1Text = Get-Content (Join-Path $root "scripts/install.ps1") -Raw

# --- TLS 1.2 is enabled before anything is fetched ---
# `irm https://veyyon.dev/install.ps1 | iex` runs under Windows PowerShell 5.1 on
# a stock Windows box, whose default SecurityProtocol still includes SSL 3.0 and
# TLS 1.0. GitHub has required TLS 1.2 since 2018, so without this every request
# in the script fails with "The request was aborted: Could not create SSL/TLS
# secure channel" — an error that names nothing about the real cause and sends
# the user to look at their network. Asserted on the source, because the value is
# process-wide and a test that set it would be testing itself.
Check "the script enables TLS 1.2" `
    ($ps1Text -match '\[Net\.SecurityProtocolType\]::Tls12') "True"
# ADDED to whatever is already enabled, never assigned: a machine policy that has
# turned on TLS 1.3 must keep it.
Check "it adds the protocol rather than replacing the set" `
    ($ps1Text -match '-bor \[Net\.SecurityProtocolType\]::Tls12') "True"
# .NET 5+ removed the setting and always negotiates the best available protocol,
# so PowerShell 7 throws on the assignment. That is not a failure to report.
$tlsBlock = $ps1Text.Substring($ps1Text.IndexOf("SecurityProtocol -bor"))
$tlsBlock = $tlsBlock.Substring(0, 200)
Check "and a runtime without the setting is not an error" `
    ($tlsBlock -match 'catch') "True"

# --- every fetch survives Windows PowerShell 5.1 ---
# `irm ... | iex` runs under 5.1 on a stock Windows box, and two of its defaults
# break an install that is otherwise fine. Asserted on the source, because both
# are process-wide settings a test cannot exercise from PowerShell 7.
#
# Without -UseBasicParsing, 5.1 hands the response to Internet Explorer's parsing
# engine. That engine is absent on Server Core and refuses to run on any machine
# where IE's first-launch configuration was never completed, so the download
# fails with a message about Internet Explorer during an install that never
# mentioned a browser.
$fetchLines = @($ps1Text -split "`n" | Where-Object {
    $_ -match '^\s*[^#]*Invoke-(WebRequest|RestMethod)'
})
Check "every fetch in the script is a real call, not only comments" `
    ($fetchLines.Count -ge 3) "True"
Check "and every one of them passes -UseBasicParsing" `
    (@($fetchLines | Where-Object { $_ -notmatch '-UseBasicParsing' }).Count) "0"

# 5.1 repaints its progress bar per read on a synchronous download, and on a
# 300 MB binary that repainting dominates the transfer. Suppressed around the
# download only, and restored afterwards, so nothing else in the user's session
# loses its progress output.
$dlBlock = $ps1Text.Substring($ps1Text.IndexOf('$StagingPath = Join-Path $InstallDir'))
$dlBlock = $dlBlock.Substring(0, 1400)
Check "the binary download suppresses the 5.1 progress bar" `
    ($dlBlock -match 'ProgressPreference = "SilentlyContinue"') "True"
Check "it captures what the setting was first" `
    ($dlBlock -match '\$priorProgress = \$ProgressPreference') "True"
Check "and restores it in a finally, so a failed download restores it too" `
    ($dlBlock -match 'finally') "True"
Check "the restore names the captured value rather than a hardcoded default" `
    ($dlBlock -match '\$ProgressPreference = \$priorProgress') "True"

# --- Get-LaunchCommand / Write-NextSteps: the closing block ---
# Three install modes each printed their own single-line closing message, which
# named BOTH names unconditionally: an install that had just declined to create
# `vey`, because the user already owns that command, still told them to run it,
# and running it runs their tool. It also said nothing about connecting a
# provider or finding the command list. One block now, mirroring
# print_next_steps in install.sh.
$Script:AliasIsOurs = $true
Check "the launch command is the alias when the alias is ours" (Get-LaunchCommand) $AliasName
$Script:AliasIsOurs = $false
Check "the launch command is the binary when the alias is not ours" (Get-LaunchCommand) $BinName

# `Write-Host` does not go down the pipeline, so the output is captured through
# the information stream (6) that Write-Host writes to.
function Get-NextStepsLines {
    param([switch]$NeedsRestart, [switch]$InCallersSession)
    return @((Write-NextSteps -NeedsRestart:$NeedsRestart -InCallersSession:$InCallersSession 6>&1) | ForEach-Object { "$_" })
}

$Script:AliasIsOurs = $false
$plain = Get-NextStepsLines
Check "no step names a vey the installer did not create" `
    (@($plain | Where-Object { $_ -match '\bvey\b' }).Count) "0"
Check "the launch step is step 1 when nothing has to restart" `
    (@($plain | Where-Object { $_ -match '^  1\. Launch in any repository: +veyyon$' }).Count) "1"
Check "a terminal that needs no restart is not told to restart" `
    (@($plain | Where-Object { $_ -match 'Restart your terminal' }).Count) "0"
Check "the provider step names the same command" `
    (@($plain | Where-Object { $_ -match '^  2\. Connect API providers: +veyyon setup$' }).Count) "1"
Check "the help step names the same command" `
    (@($plain | Where-Object { $_ -match '^  3\. See every command: +veyyon --help$' }).Count) "1"

# A PATH entry written to the registry reaches a process when that process
# starts, so a terminal that is already open cannot see it. Leading with a
# command that is not yet a command is what makes a working install read as a
# broken one, which is why the restart is a step rather than a footnote.
$restart = Get-NextStepsLines -NeedsRestart
Check "the restart is the first step when PATH was just changed" `
    (@($restart | Where-Object { $_ -match '^  1\. Restart your terminal: +open a new window$' }).Count) "1"
Check "the launch step renumbers to 2 behind it" `
    (@($restart | Where-Object { $_ -match '^  2\. Launch in any repository: +veyyon$' }).Count) "1"
Check "every step is numbered once, in order" `
    ((($restart | ForEach-Object { if ($_ -match '^  (\d+)\. ') { $Matches[1] } }) -join ' ')) "1 2 3 4"
$Script:AliasIsOurs = $true
Check "the block uses the alias throughout when it is ours" `
    (@((Get-NextStepsLines) | Where-Object { $_ -match ": +vey( |$)" }).Count) "3"

# --- the restart step is not shown to a window that already has the PATH entry -
# The documented install is `irm https://veyyon.dev/install.ps1 | iex`, which runs
# in the caller's OWN session: Add-ToPath sets $env:Path there, so the command
# works in that window immediately. Opening the closing block with "restart your
# terminal" is then wrong, and it is the first thing the user reads. Run as
# `pwsh -File install.ps1` the installer is a child process, its $env:Path dies
# with it, and the restart is genuinely required. $PSCommandPath tells the two
# apart: a script invoked from a file knows its own path, a string handed to
# Invoke-Expression has none.
# $PSCommandPath is an automatic variable and cannot be shadowed from a test, so
# the DETECTOR is checked for the case this file is actually in (dot-sourced from
# a file, therefore not the caller's session) and the two BRANCHES are driven
# directly through the switch Write-NextSteps takes. That is why the switch is a
# parameter rather than a call to the detector inside the function: otherwise one
# of the two branches would ship with no test at all.
$Script:AliasIsOurs = $false
Check "a script invoked from a file is not the caller's session" (Test-RunsInCallersSession) "False"

$piped = Get-NextStepsLines -NeedsRestart -InCallersSession
Check "the one-liner install does not open with a restart" `
    (@($piped | Where-Object { $_ -match 'Restart your terminal' }).Count) "0"
Check "launching is step 1 there, since the command already works" `
    (@($piped | Where-Object { $_ -match '^  1\. Launch in any repository: +veyyon$' }).Count) "1"
Check "the one-liner install numbers three steps, not four" `
    ((($piped | ForEach-Object { if ($_ -match '^  (\d+)\. ') { $Matches[1] } }) -join ' ')) "1 2 3"
# The PATH entry is per-user and a terminal reads it when it starts, so the other
# windows are still stale. That is a note, not a step: there is nothing to do in
# this one.
Check "it still says other open terminals are stale" `
    (@($piped | Where-Object { $_ -match 'Terminals already open elsewhere' }).Count) "1"
Check "a child-process install says nothing about other terminals" `
    (@((Get-NextStepsLines -NeedsRestart) | Where-Object { $_ -match 'Terminals already open elsewhere' }).Count) "0"
Check "neither form mentions restarting when PATH was untouched" `
    (@((Get-NextStepsLines -InCallersSession) | Where-Object { $_ -match 'Restart|Terminals already open' }).Count) "0"

# --- Resolve-RefTag: the `v` a person leaves off a version --------------------
# Releases are tagged `v1.0.37` and `-Ref 1.0.37` is what people type: the same
# version, one character short of a tag that exists. Refusing it states a true
# fact and leaves the user guessing which of the two spellings this project uses.
# The `v` form is tried as a SECOND lookup and the caller announces what it
# resolved to, so the version being installed is the version on screen. Mirrors
# resolve_ref_tag in install.sh.
#
# Test-ReleaseTagExists is shadowed here so the resolution is exercised without a
# network: it records what it was asked for, which is how the "no second guess"
# cases are asserted at all.
$Script:TagLookups = @()
function Test-ReleaseTagExists {
    param([string]$Tag)
    $Script:TagLookups += $Tag
    return ($Tag -eq "v1.0.37" -or $Tag -eq "v2.0.0-rc.1")
}

$Script:TagLookups = @()
Check "an exact tag is returned as given" (Resolve-RefTag "v1.0.37") "v1.0.37"
Check "an exact tag costs one lookup" ($Script:TagLookups.Count) "1"

$Script:TagLookups = @()
Check "a bare version resolves to the published v-prefixed tag" (Resolve-RefTag "1.0.37") "v1.0.37"
Check "the bare version was tried first, then the v form" (($Script:TagLookups -join ',')) "1.0.37,v1.0.37"

$Script:TagLookups = @()
Check "a prerelease version resolves too" (Resolve-RefTag "2.0.0-rc.1") "v2.0.0-rc.1"

$Script:TagLookups = @()
Check "a bare version with no published v-tag is refused" (Resolve-RefTag "9.9.9") ""
Check "and it stopped after the two spellings" (($Script:TagLookups -join ',')) "9.9.9,v9.9.9"

# A branch or a commit is not a version, so no `v` is bolted onto it: `vmain` and
# `vd83e6259` are tags nobody has, and asking costs a round trip before the same
# refusal.
$Script:TagLookups = @()
Check "a branch name gets no v-prefixed second try" (Resolve-RefTag "main") ""
Check "the branch cost exactly one lookup" ($Script:TagLookups.Count) "1"

$Script:TagLookups = @()
Check "a commit sha gets no v-prefixed second try" (Resolve-RefTag "d83e6259") ""
Check "the sha cost exactly one lookup" ($Script:TagLookups.Count) "1"

$Script:TagLookups = @()
Check "a v-prefixed tag that does not exist is refused without a second guess" (Resolve-RefTag "v9.9.9") ""
Check "the missing v-tag cost exactly one lookup" ($Script:TagLookups.Count) "1"

# --- Get-TagFromRedirect: the release lookup no longer needs the GitHub API ---
# api.github.com allows 60 requests an hour per IP without a token, shared by
# everyone behind the same address, and the install spent one of them on every
# run: a CI fleet or an office network doing a few dozen installs in an hour
# started getting 403 on a machine where nothing was wrong. The tag now comes
# from where github.com/<repo>/releases/latest REDIRECTS to, which costs nothing
# against that budget. Invoke-WebRequest is shadowed so these test the parse of a
# Location header rather than the network.
function Set-FakeRedirect {
    param([string]$Location)
    $Script:FakeLocation = $Location
    function Global:Get-RedirectLocation {
        param([string]$Url)
        return $Script:FakeLocation
    }
}
Set-FakeRedirect "https://github.com/santhreal/veyyon/releases/tag/v1.2.3"
Check "the tag is taken from the redirect target" (Get-TagFromRedirect "x") "v1.2.3"
Set-FakeRedirect "https://github.com/santhreal/veyyon/releases/tag/v0.0.1-rc1"
Check "a prerelease-shaped tag survives intact" (Get-TagFromRedirect "x") "v0.0.1-rc1"
# A redirect that did not land on a tag page means GitHub answered with something
# other than a release: an interstitial, a moved repo, a captive portal. Taking
# the last path segment anyway is how an installer ends up trying to download a
# binary for the version "latest".
Set-FakeRedirect "https://github.com/santhreal/veyyon/releases"
Check "a redirect that is not a tag page yields nothing" ($null -eq (Get-TagFromRedirect "x")) "True"
Set-FakeRedirect "https://github.com/login?return_to=%2Fsanthreal%2Fveyyon"
Check "a login interstitial yields nothing" ($null -eq (Get-TagFromRedirect "x")) "True"
Set-FakeRedirect "http://wifi.example.net/portal"
Check "a captive portal's landing page yields nothing" ($null -eq (Get-TagFromRedirect "x")) "True"
Set-FakeRedirect ""
Check "no Location header at all yields nothing" ($null -eq (Get-TagFromRedirect "x")) "True"
# A tag page is not the same as a tag: `/releases/tag/` with nothing after it is
# not a version, and installing "" would build a download URL with an empty path
# segment that 404s much later, with a message about a missing asset.
Set-FakeRedirect "https://github.com/santhreal/veyyon/releases/tag/"
Check "a tag page with no tag on it yields nothing" ($null -eq (Get-TagFromRedirect "x")) "True"
# The transport reports an unreachable host and an error status the same way, as
# no redirect, so both reach the caller as "could not resolve a release" rather
# than as a tag that happens to be empty.
Set-FakeRedirect $null
Check "an unreachable host yields nothing" ($null -eq (Get-TagFromRedirect "x")) "True"
# And the tag is taken from the LAST /releases/tag/ segment, so a repository
# whose own name contains that string cannot shift which version is read.
Set-FakeRedirect "https://github.com/someone/releases-tag-mirror/releases/tag/v2.3.4"
Check "the tag comes from the real tag segment" (Get-TagFromRedirect "x") "v2.3.4"
Remove-Item Function:Global:Get-RedirectLocation -ErrorAction SilentlyContinue

# No API call is left anywhere in the script, which is the whole point: an
# install must not be able to fail because somebody else on the same address
# installed veyyon sixty times this hour. Comment lines are excluded, since the
# comment above the lookup names the API host to explain why it is not called.
$ps1Code = (Get-Content (Join-Path $root "scripts/install.ps1")) | Where-Object { $_ -notmatch '^\s*#' }
Check "the Windows installer makes no api.github.com request at all" `
    (@($ps1Code | Where-Object { $_ -match 'api\.github\.com' }).Count) "0"

# --- Uninstall-Veyyon: the terminals already open have not caught up ---
# A PATH entry lives in the registry and reaches a process when that process
# starts, so every terminal already open still holds the entry the uninstall just
# removed, and `veyyon` there answers with a path the user can see is gone. The
# message is printed only when a PATH entry was actually taken out; an uninstall
# that touched no PATH has nothing to restart for. Asserted on the source rather
# than by running an uninstall, which would edit the machine's real PATH.
$uninstallFn = $ps1Text.Substring($ps1Text.IndexOf("function Uninstall-Veyyon {"))
$uninstallFn = $uninstallFn.Substring(0, $uninstallFn.IndexOf("`n}"))
Check "the uninstall says open terminals keep the old entry" `
    ($uninstallFn -match 'open terminals keep the old PATH entry until they restart') "True"
Check "it says so only when a PATH entry was removed" `
    ($uninstallFn -match 'if \(\$pathEntryRemoved\)') "True"
Check "the flag is set where the entry is actually removed" `
    ($uninstallFn -match '\$pathEntryRemoved = \$true') "True"
Check "and starts false, so a no-op uninstall stays quiet" `
    ($uninstallFn -match '\$pathEntryRemoved = \$false') "True"

# --- Invoke-Doctor: a binary that will not START has to say why ---
# The published Windows exe failed to run on a clean runner and the installer
# reported only "'veyyon --version' failed" - no exit code, no message, because
# stderr went to $null. The line the operating system writes about why an
# executable will not start IS the diagnosis, and without it the user's only
# possible next step is a bug report nobody can act on either. These drive the
# real function against stub binaries rather than reading the source, because a
# message that exists in the file and never reaches the screen is the same defect.
$doctorDir = Join-Path ([System.IO.Path]::GetTempPath()) ("veyyon-doctor-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $doctorDir -Force | Out-Null
try {
    $loud = Join-Path $doctorDir "loud.cmd"
    Set-Content -Path $loud -Value "@echo off`r`necho The code execution cannot proceed because VCRUNTIME140.dll was not found 1>&2`r`nexit /b 127"
    $caught = ""
    try { Invoke-Doctor -Command $loud } catch { $caught = "$_" }
    Check "a binary that cannot start is fatal" ($caught -ne "") "True"
    Check "the failure carries the exit status" ($caught -match 'exit 127') "True"
    Check "the failure carries what the system said" ($caught -match 'VCRUNTIME140\.dll was not found') "True"

    # Silence is its own answer and must not read as a missing message.
    $silent = Join-Path $doctorDir "silent.cmd"
    Set-Content -Path $silent -Value "@echo off`r`nexit /b 3"
    $caught = ""
    try { Invoke-Doctor -Command $silent } catch { $caught = "$_" }
    Check "a silent failure still names the exit status" ($caught -match 'exit 3') "True"
    Check "a silent failure says it printed nothing" ($caught -match 'printed nothing') "True"
    # The specific way this went wrong: Get-Content -Raw answers $null for an
    # empty file, and .Trim() on $null throws under ErrorActionPreference=Stop,
    # so the reported reason was a PowerShell exception about the harness rather
    # than a fact about the binary.
    Check "a silent failure does not report a PowerShell exception as the reason" `
        ($caught -notmatch 'You cannot call a method on a null') "True"

    # The capture file is temporary and must not survive either path.
    Check "the stderr capture is cleaned up" `
        (@(Get-ChildItem ([System.IO.Path]::GetTempPath()) -Filter "veyyon-doctor-*.err" -ErrorAction SilentlyContinue).Count) "0"
} finally {
    Remove-Item -Recurse -Force $doctorDir -ErrorAction SilentlyContinue
}

Write-Host ""
# A run that recorded nothing is a broken harness, not a pass: fail closed rather
# than report "0 passed, 0 failed" and exit 0 (mirrors functions.test.sh).
if (($script:Pass + $script:Fail) -eq 0) {
    Write-Host "no assertions recorded - the harness did not run"
    exit 1
}
Write-Host "$($script:Pass) passed, $($script:Fail) failed"
if ($script:Fail -ne 0) { exit 1 }
