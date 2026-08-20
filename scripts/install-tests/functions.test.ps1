# Behavior tests for scripts/install.ps1 helper functions — including PATH
# wiring and transactional replacement — run against isolated temporary files
# without mutating the machine's persistent environment.
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

# --- Add-ToPath: persistent and current-session PATH are independent ---
# A previous file-based install can update HKCU while its parent terminal keeps
# an old process PATH. Rerunning through `irm | iex` happens in that still-open
# process. The old code saw HKCU already configured, skipped every write, and
# then said this window was ready even though `veyyon` was not a command there.
# Mock the registry helpers so this stays a pure in-process behavior test.
$originalGetRawUserPath = ${function:Get-RawUserPath}
$originalSetRawUserPath = ${function:Set-RawUserPath}
$originalProcessPath = $env:Path
$originalPathInstallDir = $InstallDir
try {
    $script:MockUserPath = "C:\Veyyon;C:\Future"
    $script:MockUserPathWrites = 0
    function Get-RawUserPath { return @{ Value = $script:MockUserPath; Kind = $null } }
    function Set-RawUserPath {
        param([string]$Value)
        $script:MockUserPath = $Value
        $script:MockUserPathWrites++
    }
    $InstallDir = "C:\Veyyon"
    $env:Path = "C:\Windows"
    $needsRestart = Add-ToPath
    Check "an already-persistent PATH entry needs no registry rewrite" $script:MockUserPathWrites "0"
    Check "an already-persistent PATH entry needs no restart after in-process repair" $needsRestart "False"
    Check "a stale current session is repaired even when HKCU already contains the dir" `
        (Test-PathContainsDir $env:Path $InstallDir) "True"

    # The inverse state is possible in an explicitly edited process PATH. It
    # still needs a persistent write, but must not duplicate the process entry.
    $script:MockUserPath = "C:\Future"
    $script:MockUserPathWrites = 0
    $env:Path = "C:\Veyyon;C:\Windows"
    $needsRestart = Add-ToPath
    Check "an absent persistent entry is written once" $script:MockUserPathWrites "1"
    Check "a new persistent entry reports that future sessions need the update" $needsRestart "True"
    Check "an existing process entry is not duplicated" `
        (@(Split-PathEntries $env:Path | Where-Object { $_ -ieq $InstallDir }).Count) "1"
} finally {
    Set-Item -Path Function:\Get-RawUserPath -Value $originalGetRawUserPath
    Set-Item -Path Function:\Set-RawUserPath -Value $originalSetRawUserPath
    $env:Path = $originalProcessPath
    $InstallDir = $originalPathInstallDir
}

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

# --- legacy source checkout: uninstall cleans it up and never destroys work ---
# An older installer cloned the product into ~/.veyyon/src, updated that tree with
# `git reset --hard`, and on uninstall removed it outright, so a user's own edits
# in there could be lost twice over. Nothing creates that checkout any more, and
# uninstall still meets one on every machine that ran an older installer: a tree it
# did not create is moved aside rather than deleted, a checkout holding local work
# is never removed, and only a pristine checkout of OUR remote is deleted.
if (Get-Command git -ErrorAction SilentlyContinue) {
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-$PID"
    if (Test-Path $sandbox) { Remove-Item -Recurse -Force $sandbox }
    New-Item -ItemType Directory -Force -Path $sandbox | Out-Null

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

    # Move-aside relocates a non-empty non-git dir and keeps the file. This is the
    # rule for the legacy tree: what the installer did not create is moved, never
    # deleted; an empty directory carries nothing and is simply removed.
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

    # Ownership comes from the configured origin, not from directory location or
    # cleanliness. This prevents update and uninstall from claiming a foreign
    # checkout merely because it occupies VEYYON_SRC_DIR.
    $savedRepoUrl = $RepoUrl
    $RepoUrl = "$pristine.origin"
    Check "the configured source origin is recognized as installer-owned" (Test-SrcRemoteIsOurs $pristine) "True"
    $RepoUrl = $savedRepoUrl
    Check "an unrelated pristine origin is not treated as installer-owned" (Test-SrcRemoteIsOurs $pristine) "False"

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
    $RepoUrl = "$us.origin"
    Uninstall-Veyyon | Out-Null
    Check "uninstall did NOT delete a checkout holding unpushed work" (Test-Path $us) "False"
    $usbak = @(Get-ChildItem -Path $sandbox -Directory -Filter "uninstall-src.bak-*")[0]
    Check "uninstall moved the checkout aside instead of deleting" (Test-Path (Join-Path $usbak.FullName ".git")) "True"
    Push-Location $usbak.FullName
    $rec = (git show "veyyon-local-keep:AGENTS.md" 2>$null).Trim()
    Pop-Location
    Check "moved-aside checkout still has the recoverable edit" $rec "RECOVER ME"

    # The same rule for the commonest shape of local work: an edit never committed
    # at all. The tree is ours by origin and carries no unpushed branch, so a
    # cleanliness-blind uninstall deleted it and took the edit with it.
    $ud = Join-Path $sandbox "uninstall-dirty"
    New-ClonedRepo $ud
    "UNCOMMITTED, KEEP ME" | Set-Content -NoNewline -Path (Join-Path $ud "AGENTS.md")
    $SrcDir = $ud
    $RepoUrl = "$ud.origin"
    Uninstall-Veyyon | Out-Null
    Check "uninstall did NOT delete a checkout holding an uncommitted edit" (Test-Path $ud) "False"
    $udbak = @(Get-ChildItem -Path $sandbox -Directory -Filter "uninstall-dirty.bak-*")[0]
    Check "uninstall moved the edited checkout aside" (Test-Path (Join-Path $udbak.FullName ".git")) "True"
    Check "the moved-aside checkout still holds the uncommitted bytes" `
        ((Get-Content -Raw -Path (Join-Path $udbak.FullName "AGENTS.md")).Trim()) "UNCOMMITTED, KEEP ME"

    # A pristine, fully-pushed checkout is removed outright.
    $up = Join-Path $sandbox "uninstall-pristine"
    New-ClonedRepo $up
    $SrcDir = $up
    $RepoUrl = "$up.origin"
    Uninstall-Veyyon | Out-Null
    Check "uninstall removes a pristine pushed checkout outright" (Test-Path $up) "False"
    Check "pristine uninstall left no move-aside backup" (@(Get-ChildItem -Path $sandbox -Directory -Filter "uninstall-pristine.bak-*").Count) "0"

    # A pristine checkout from another repository is still user-owned. The old
    # cleanliness-only rule deleted it outright, losing every remote ref.
    $foreign = Join-Path $sandbox "uninstall-foreign"
    New-ClonedRepo $foreign
    Push-Location $foreign
    $foreignRemote = (git remote get-url origin 2>$null).Trim()
    Pop-Location
    $RepoUrl = $savedRepoUrl
    $SrcDir = $foreign
    Uninstall-Veyyon | Out-Null
    Check "uninstall never deletes an unrelated pristine checkout" (Test-Path $foreign) "False"
    $foreignBak = @(Get-ChildItem -Path $sandbox -Directory -Filter "uninstall-foreign.bak-*")[0]
    Check "uninstall moves an unrelated pristine checkout aside" (Test-Path (Join-Path $foreignBak.FullName ".git")) "True"
    Push-Location $foreignBak.FullName
    $preservedRemote = (git remote get-url origin 2>$null).Trim()
    Pop-Location
    Check "the preserved checkout keeps its exact origin" $preservedRemote $foreignRemote

    Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
} else {
    Write-Host "SKIP: git not available; legacy source-checkout tests skipped"
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
$originalAliasInstallDir = $InstallDir
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

    # Merely mentioning our path is not forwarding to it. The previous
    # substring check claimed this user-owned shim, so Install-Alias overwrote
    # it, doctor called it ours, and uninstall later deleted it.
    $userShim = "@echo off`r`nrem diagnostic path: $ourBin`r`n`"C:\their\tool.exe`" %*"
    $userShim | Set-Content -Path $shim -Encoding ASCII
    Check "a user shim that only mentions our binary is not ours" (Test-AliasPointsAtUs -BinPath $ourBin) "False"
    $InstallDir = $aliasSandbox
    Install-Alias -Target $ourBin | Out-Null
    Check "Install-Alias does not overwrite a user shim that mentions our binary" `
        ((Get-Content -Raw -Path $shim).Trim()) $userShim.Trim()
    Check "declining the user shim leaves alias ownership false" $Script:AliasIsOurs "False"

    # The shim Install-Alias itself writes.
    "@echo off`r`n`"$ourBin`" %*" | Set-Content -Path $shim -Encoding ASCII
    Check "a shim forwarding to our binary is ours" (Test-AliasPointsAtUs -BinPath $ourBin) "True"
} finally {
    $InstallDir = $originalAliasInstallDir
    Remove-Item -Recurse -Force $aliasSandbox -ErrorAction SilentlyContinue
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

    # An older source install shimmed to veyyon.cmd rather than veyyon.exe. That
    # shim is still ours, so an install that predates this one can be reclaimed.
    Set-Content -LiteralPath $shim -Value "@echo off`r`n`"$(Join-Path $aliasSandbox 'veyyon.cmd')`" %*"
    Check "a shim forwarding to our cmd launcher is ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "True"

    Set-Content -LiteralPath $shim -Value "@echo off`r`necho their tool"
    Check "an unrelated vey.cmd is NOT ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    # A shim forwarding to a DIFFERENT veyyon (another install dir) is not this
    # installation's to remove.
    Set-Content -LiteralPath $shim -Value "@echo off`r`n`"C:\elsewhere\veyyon.exe`" %*"
    Check "a shim pointing at another install is not ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    $mentionedTarget = Join-Path $aliasSandbox 'veyyon.exe'
    Set-Content -LiteralPath $shim -Value "@echo off`r`nrem diagnostic path: $mentionedTarget`r`n`"C:\their\tool.exe`" %*"
    Check "a user shim that only mentions our exe is not removable as ours" `
        (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    Remove-Item -Force $shim
    Check "a missing shim is not ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"

    Set-Content -LiteralPath $shim -Value ""
    Check "an empty shim is not ours" (Test-AliasShimIsOurs -ShimPath $shim -BinDir $aliasSandbox) "False"
} finally {
    Remove-Item -Recurse -Force $aliasSandbox -ErrorAction SilentlyContinue
}

# --- New-BinaryStagingPath: the downloaded binary remains executable ---
# Windows PowerShell 5.1 classifies a command path by its final extension. The
# installer used `.download`, so checksum verification succeeded but the native
# self-test failed before launch with CantActivateDocumentInPipeline. This drives
# the exact invocation shape against the relocatable Windows command processor.
$executableStageSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon executable stage $PID"
if (Test-Path $executableStageSandbox) { Remove-Item -Recurse -Force $executableStageSandbox }
try {
    New-Item -ItemType Directory -Force -Path $executableStageSandbox | Out-Null
    $executableStage = New-BinaryStagingPath -Dir $executableStageSandbox -BinName $BinName
    Check "the binary staging path keeps exe as its final extension" ([System.IO.Path]::GetExtension($executableStage)) ".exe"
    Check "the binary staging path remains unique to this installer" ([System.IO.Path]::GetFileName($executableStage)) ".$BinName.$PID.download.exe"
    $localExecutableStage = New-BinaryStagingPath -Dir $executableStageSandbox -BinName $BinName -Kind "local"
    Check "the local staging path keeps exe as its final extension" ([System.IO.Path]::GetExtension($localExecutableStage)) ".exe"
    Check "the local staging path remains unique to this installer" ([System.IO.Path]::GetFileName($localExecutableStage)) ".$BinName.$PID.local.exe"

    $hostExecutable = (Get-Command cmd.exe -ErrorAction Stop).Source
    Copy-Item -LiteralPath $hostExecutable -Destination $executableStage
    Copy-Item -LiteralPath $hostExecutable -Destination $localExecutableStage
    $pipelineOutput = (& $executableStage /d /c "echo pipeline-ok" 2>&1 | Out-String).Trim()
    Check "a download staged in a spaced path runs in the middle of a pipeline" $pipelineOutput "pipeline-ok"
    $localPipelineOutput = (& $localExecutableStage /d /c "echo local-pipeline-ok" 2>&1 | Out-String).Trim()
    Check "a local build staged in a spaced path runs in the middle of a pipeline" $localPipelineOutput "local-pipeline-ok"

    # Cleanup accepts both executable staging kinds and their legacy bare
    # suffixes, but rejects a similarly named file with no numeric owner PID.
    $legacyStage = Join-Path $executableStageSandbox ".$BinName.2147483647.download"
    $legacyLocalStage = Join-Path $executableStageSandbox ".$BinName.2147483647.local"
    $foreignStage = Join-Path $executableStageSandbox ".$BinName.mine.download.exe"
    Set-Content -LiteralPath $legacyStage -Value "legacy"
    Set-Content -LiteralPath $legacyLocalStage -Value "legacy-local"
    Set-Content -LiteralPath $foreignStage -Value "foreign"
    Clear-StaleInstallArtifacts -Dir $executableStageSandbox -BaseName "$BinName.exe" -BinName $BinName *> $null
    Check "stale cleanup removes the executable download staging form" (Test-Path $executableStage) "False"
    Check "stale cleanup removes the executable local staging form" (Test-Path $localExecutableStage) "False"
    Check "stale cleanup still removes the legacy download staging form" (Test-Path $legacyStage) "False"
    Check "stale cleanup still removes the legacy local staging form" (Test-Path $legacyLocalStage) "False"
    Check "stale cleanup preserves similarly named files without an owner PID" (Test-Path $foreignStage) "True"
} finally {
    Remove-Item -Recurse -Force $executableStageSandbox -ErrorAction SilentlyContinue
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
    Check "the refusal tells the user to retry the download" ([bool]($stageError -match "Retry")) "True"
    Check "and hands over the manual build for when retrying will not help" `
        ([bool]($stageError -match [regex]::Escape("git clone $RepoUrl"))) "True"
    Check "the refusal offers no installer switch that clones" ([bool]($stageError -match '-Source')) "False"
    Check "the previous binary is untouched" (Get-Content -Raw $target).Trim() "previous working binary"
    Check "the empty staged file is cleaned up" (Test-Path $staging) "False"

    # A missing staged file is the same failure, not a crash on a null length.
    $stageError = ""
    try { Move-StagedBinaryIntoPlace -StagingPath (Join-Path $stageSandbox "absent") -TargetPath $target } catch { $stageError = $_.Exception.Message }
    Check "a missing staged file is refused too" ([bool]($stageError -match "is empty")) "True"

    # A non-empty download is still not allowed to claim a foreign target. The
    # staged bytes are discarded and the existing file remains byte-identical.
    Set-Content -LiteralPath $staging -Value "untrusted replacement"
    $ownershipError = ""
    try { Move-StagedBinaryIntoPlace -StagingPath $staging -TargetPath $target } catch { $ownershipError = $_.Exception.Message }
    Check "a foreign target is refused before replacement" ([bool]($ownershipError -match "not created by this installer")) "True"
    Check "foreign target bytes survive the refusal" (Get-Content -Raw $target).Trim() "previous working binary"
    Check "the rejected staging file is removed" (Test-Path $staging) "False"

    # Receipt-bearing targets are safe to update and receive a renewed receipt.
    Set-ArtifactOwned $target
    # The good path still works: a non-empty staged file replaces the target.
    Set-Content -LiteralPath $staging -Value "new binary"
    Move-StagedBinaryIntoPlace -StagingPath $staging -TargetPath $target
    Check "a non-empty staged file replaces the target" (Get-Content -Raw $target).Trim() "new binary"
    Check "the staged file is gone after a successful move" (Test-Path $staging) "False"
    Check "successful replacement records installer ownership" (Test-ArtifactHasOwnerReceipt $target) "True"

    # A staged executable can remain locked for a fraction of a second after its
    # preflight process exits. Hold the source with FileShare.None in another
    # process, then prove the installer waits for release and completes the
    # transaction instead of abandoning a healthy reinstall.
    Set-Content -LiteralPath $staging -Value "retry binary"
    $ready = Join-Path $stageSandbox "lock-ready"
    $lockJob = Start-Job -ArgumentList $staging, $ready -ScriptBlock {
        param($lockedPath, $readyPath)
        $stream = [System.IO.File]::Open(
            $lockedPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::None
        )
        try {
            Set-Content -LiteralPath $readyPath -Value "ready"
            Start-Sleep -Milliseconds 700
        } finally {
            $stream.Dispose()
        }
    }
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path $ready) -and [DateTime]::UtcNow -lt $readyDeadline) {
        Start-Sleep -Milliseconds 25
    }
    if (-not (Test-Path $ready)) {
        Stop-Job $lockJob -ErrorAction SilentlyContinue
        Remove-Job $lockJob -Force -ErrorAction SilentlyContinue
        throw "the lock-holder job did not start"
    }
    try {
        Move-StagedBinaryIntoPlace -StagingPath $staging -TargetPath $target
    } finally {
        Wait-Job $lockJob | Out-Null
        Receive-Job $lockJob | Out-Null
        Remove-Job $lockJob -Force
    }
    Check "a transient staging lock is retried until replacement succeeds" (Get-Content -Raw $target).Trim() "retry binary"
    Check "the retried staging file is gone after replacement" (Test-Path $staging) "False"
} finally {
    Remove-Item -Recurse -Force $stageSandbox -ErrorAction SilentlyContinue
}

# --- verified release transaction: version is a pre-replacement gate ---
# A published checksum can be valid while the attached executable is stale. Run
# the real staged commands and move helper against temporary files so matching,
# mismatch, and adversarial version behavior cannot regress into a source-text
# ordering assertion that passes while the transaction is destructive.
$versionTransactionSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-version-transaction-$PID"
New-Item -ItemType Directory -Force -Path $versionTransactionSandbox | Out-Null
try {
    function New-ReleaseStub {
        param([string]$Path, [string]$Version)
        Set-Content -LiteralPath $Path -Value @"
@echo off
if "%1"=="--version" (
  echo veyyon/$Version
  exit /b 0
)
if "%1"=="grep" if "%2"=="--help" exit /b 0
if "%1"=="grep" (
  echo %3\probe.txt:1: %2
  exit /b 0
)
exit /b 2
"@
    }

    $target = Join-Path $versionTransactionSandbox "veyyon.cmd"
    $matching = Join-Path $versionTransactionSandbox ".veyyon.$PID.download.cmd"
    New-ReleaseStub -Path $target -Version "0.9.0"
    Set-ArtifactOwned $target
    New-ReleaseStub -Path $matching -Version "1.2.3"
    $matchingHash = (Get-FileHash -Path $matching -Algorithm SHA256).Hash.ToLower()
    Check "the matching transaction starts from a checksum-valid staged file" `
        (Test-FileSha256 -Path $matching -Expected $matchingHash) "True"
    Assert-ReleaseVersion -Command $matching -ExpectedTag "v1.2.3" -Phase "downloaded" *> $null
    Test-NativeAddon -Command $matching -Phase "downloaded" *> $null
    Move-StagedBinaryIntoPlace -StagingPath $matching -TargetPath $target
    $installedVersion = (& $target --version | Out-String).Trim()
    Check "a staged binary with the requested version replaces the old executable" $installedVersion "veyyon/1.2.3"
    Check "the matching transaction consumes its staging file" (Test-Path $matching) "False"

    # This locks the destructive failure: post-install version checking replaced
    # a working binary before discovering the wrong release and had already
    # reached installer-owned alias, completion, and profile metadata.
    $wrong = Join-Path $versionTransactionSandbox ".veyyon.$PID.wrong.cmd"
    $alias = Join-Path $versionTransactionSandbox "vey.cmd"
    $completion = Join-Path $versionTransactionSandbox "veyyon-completions.ps1"
    $profileMetadata = Join-Path $versionTransactionSandbox "profile.ps1"
    New-ReleaseStub -Path $target -Version "0.9.0"
    New-ReleaseStub -Path $wrong -Version "7.7.7"
    Set-Content -LiteralPath $alias -Value "owned alias bytes"
    Set-Content -LiteralPath $completion -Value "owned completion bytes"
    Set-Content -LiteralPath $profileMetadata -Value "# added by the veyyon installer"
    $wrongHash = (Get-FileHash -Path $wrong -Algorithm SHA256).Hash.ToLower()
    Check "the wrong-version fixture is checksum-valid before the version gate" `
        (Test-FileSha256 -Path $wrong -Expected $wrongHash) "True"
    $wrongError = ""
    try {
        Assert-ReleaseVersion -Command $wrong -ExpectedTag "v1.2.3" -Phase "downloaded" *> $null
        Test-NativeAddon -Command $wrong -Phase "downloaded" *> $null
        Move-StagedBinaryIntoPlace -StagingPath $wrong -TargetPath $target
    } catch {
        $wrongError = $_.Exception.Message
        Remove-Item $wrong -Force -ErrorAction SilentlyContinue
    }
    Check "a checksum-valid wrong version is rejected before replacement" ([bool]($wrongError -match "refusing to replace")) "True"
    Check "the previous executable survives a version mismatch" ((& $target --version | Out-String).Trim()) "veyyon/0.9.0"
    Check "the rejected installer-owned staging file is cleaned" (Test-Path $wrong) "False"
    Check "installer-owned alias metadata is untouched on mismatch" (Get-Content -Raw $alias).Trim() "owned alias bytes"
    Check "installer-owned completion metadata is untouched on mismatch" (Get-Content -Raw $completion).Trim() "owned completion bytes"
    Check "installer-owned profile metadata is untouched on mismatch" (Get-Content -Raw $profileMetadata).Trim() "# added by the veyyon installer"

    # Equality, not a prefix/substring match: v1.2.30 is not release v1.2.3.
    $adversarial = Join-Path $versionTransactionSandbox ".veyyon.$PID.adversarial.cmd"
    New-ReleaseStub -Path $adversarial -Version "1.2.30"
    $adversarialError = ""
    try { Assert-ReleaseVersion -Command $adversarial -ExpectedTag "v1.2.3" *> $null } catch { $adversarialError = $_.Exception.Message }
    Check "a version sharing the requested prefix is still rejected" ([bool]($adversarialError -match "refusing to replace")) "True"
} finally {
    Remove-Item -Recurse -Force $versionTransactionSandbox -ErrorAction SilentlyContinue
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

# --- installer ownership receipts: foreign artifacts survive install/uninstall ---
# File location is not ownership. These pure checks lock the cross-platform
# receipt contract without invoking an untrusted executable to identify it.
#
# The receipt used to hold one constant line, so it vouched for a PATH: delete an
# installed veyyon.exe by hand and the sidecar stayed, and the next unrelated file
# to take that name inherited the ownership. A v2 receipt records a SHA256 of the
# artifact it was written for and is honoured only while that artifact matches.
$ownershipSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ownership-$PID"
New-Item -ItemType Directory -Force -Path $ownershipSandbox | Out-Null
try {
    $foreignBinary = Join-Path $ownershipSandbox "veyyon.exe"
    Set-Content -LiteralPath $foreignBinary -Value "another tool"
    Check "an unreceipted executable is foreign" (Test-BinaryArtifactIsOurs $foreignBinary) "False"
    Set-ArtifactOwned $foreignBinary
    Check "a receipt identifies the executable as installer-owned" (Test-BinaryArtifactIsOurs $foreignBinary) "True"
    Remove-ArtifactOwnerReceipt $foreignBinary
    Check "removing the receipt returns the executable to foreign ownership" (Test-BinaryArtifactIsOurs $foreignBinary) "False"

    # The receipt body is the same two lines install.sh writes, LF-terminated, so
    # a sidecar is readable by whichever installer meets it next.
    Set-ArtifactOwned $foreignBinary
    $receiptPath = Join-Path $ownershipSandbox ".veyyon.exe.veyyon-owner"
    $receiptBody = [System.IO.File]::ReadAllText($receiptPath)
    $binaryHash = (Get-FileHash -LiteralPath $foreignBinary -Algorithm SHA256).Hash.ToLower()
    Check "the receipt records the version and the file's digest, LF-terminated" `
        $receiptBody "veyyon-installer-v2`nfile sha256:$binaryHash`n"

    # Re-stamping after the installer rewrites the file is what keeps reinstall
    # and update working; without it every second install would refuse itself.
    Set-Content -LiteralPath $foreignBinary -Value "a different tool"
    Check "a rewritten file no longer matches the receipt it was given" `
        (Test-ArtifactHasOwnerReceipt $foreignBinary) "False"
    Set-ArtifactOwned $foreignBinary
    Check "re-stamping makes the rewritten file ours again" `
        (Test-ArtifactHasOwnerReceipt $foreignBinary) "True"

    # THE DEFECT. A receipt orphaned by a hand-deleted binary must not license a
    # clobber of whatever the user puts there next.
    $orphanDir = Join-Path $ownershipSandbox "orphan-v1"
    New-Item -ItemType Directory -Force -Path $orphanDir | Out-Null
    $orphanBinary = Join-Path $orphanDir "veyyon.exe"
    [System.IO.File]::WriteAllText((Join-Path $orphanDir ".veyyon.exe.veyyon-owner"), "veyyon-installer-v1`n")
    Set-Content -LiteralPath $orphanBinary -Value "the user's own tool"
    Check "an orphaned v1 receipt is no longer ownership on its own" `
        (Test-BinaryPathIsReplaceable $orphanBinary) "False"
    Check "the refusal names the pre-identity receipt rather than blaming the user" `
        ((Get-BinaryRefusalReason $orphanBinary) -like "*predates recorded file identity*") "True"

    # The same orphan under a v2 receipt, with our own shim beside it. vey.cmd is
    # installer-specific evidence that survives any replacement of the file next
    # to it, so a receipt we wrote and cannot match has to settle the question
    # BEFORE the shim is consulted, or the shim hands the stranger's file back.
    $shimDir = Join-Path $ownershipSandbox "orphan-v2"
    New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
    $shimBinary = Join-Path $shimDir "veyyon.exe"
    Set-Content -LiteralPath $shimBinary -Value "installed veyyon bytes"
    Set-ArtifactOwned $shimBinary
    Set-Content -LiteralPath (Join-Path $shimDir "vey.cmd") -Value "@echo off`r`n`"$shimBinary`" %*"
    Check "the shim beside it is still one this installer wrote" `
        (Test-AliasShimIsOurs -ShimPath (Join-Path $shimDir "vey.cmd") -BinDir $shimDir) "True"
    Set-Content -LiteralPath $shimBinary -Value "the user's own tool"
    Check "a receipt that cannot match beats the shim evidence beside it" `
        (Test-BinaryArtifactIsOurs $shimBinary) "False"
    Check "the refusal says the file changed rather than that it is foreign" `
        ((Get-BinaryRefusalReason $shimBinary) -like "*changed since this installer wrote it*") "True"

    # COMPATIBILITY. Installs from v1.0.38 to v1.0.46 wrote a receipt with no
    # identity in it. Refusing all of them would strand every existing user, so
    # such an install is adopted through the same shim evidence that adopts a
    # pre-receipt install, and the contact upgrades the sidecar to v2. That
    # upgrade is what shuts the window above for that machine.
    $legacyDir = Join-Path $ownershipSandbox "legacy-v1"
    New-Item -ItemType Directory -Force -Path $legacyDir | Out-Null
    $legacyBinary = Join-Path $legacyDir "veyyon.exe"
    Set-Content -LiteralPath $legacyBinary -Value "installed veyyon bytes"
    Set-Content -LiteralPath (Join-Path $legacyDir "vey.cmd") -Value "@echo off`r`n`"$legacyBinary`" %*"
    [System.IO.File]::WriteAllText((Join-Path $legacyDir ".veyyon.exe.veyyon-owner"), "veyyon-installer-v1`n")
    Check "a v1 receipt is recognized as the pre-identity format" `
        (Test-ArtifactHasLegacyOwnerReceipt $legacyBinary) "True"
    Check "a v1 receipt carries no identity of its own" `
        (Test-ArtifactHasOwnerReceipt $legacyBinary) "False"
    Check "an existing install is still adopted so upgrades keep working" `
        (Test-BinaryPathIsReplaceable $legacyBinary) "True"
    Set-ArtifactOwned $legacyBinary
    Check "the adopting install upgrades the receipt to v2" `
        (Test-ArtifactHasLegacyOwnerReceipt $legacyBinary) "False"
    Check "and the upgraded receipt now identifies the file" `
        (Test-ArtifactHasOwnerReceipt $legacyBinary) "True"

    # FAIL CLOSED. A receipt recording no identity would be a v1 receipt under a
    # v2 name, so a file whose hash cannot be taken gets no receipt at all rather
    # than a claim the installer cannot prove. A directory is the reachable stand
    # in for that: Get-FileHash has nothing to hash.
    $unhashable = Join-Path $ownershipSandbox "not-a-file"
    New-Item -ItemType Directory -Force -Path $unhashable | Out-Null
    Check "an artifact with no computable identity yields none" `
        ($null -eq (Get-ArtifactIdentity $unhashable)) "True"
    $stampError = ""
    try { Set-ArtifactOwned $unhashable } catch { $stampError = "$($_.Exception.Message)" }
    Check "writing a receipt without an identity throws instead of claiming ownership" `
        ($stampError -like "*identity could not be computed*") "True"
    Check "and no receipt is left behind for it" `
        (Test-Path -LiteralPath (Join-Path $ownershipSandbox ".not-a-file.veyyon-owner")) "False"

    $foreignCompletion = Join-Path $ownershipSandbox "veyyon-completions.ps1"
    Set-Content -LiteralPath $foreignCompletion -Value "# user's own completion"
    Check "an unrelated completion script is foreign" (Test-CompletionArtifactIsOurs $foreignCompletion) "False"
    Set-ArtifactOwned $foreignCompletion
    Check "a receipt identifies the completion as installer-owned" (Test-CompletionArtifactIsOurs $foreignCompletion) "True"
    Remove-ArtifactOwnerReceipt $foreignCompletion
    Set-Content -LiteralPath $foreignCompletion -Value "# PowerShell completion for veyyon - generated by veyyon completions powershell"
    Check "a legacy generated completion is adopted without running code" (Test-CompletionArtifactIsOurs $foreignCompletion) "True"
    # A completion regenerated by `veyyon update` no longer matches its receipt,
    # and is still unmistakably ours by content. Refusing it would make every
    # update leave a stale completion behind.
    Set-ArtifactOwned $foreignCompletion
    Set-Content -LiteralPath $foreignCompletion -Value "# PowerShell completion for veyyon - generated by veyyon completions powershell`n# regenerated"
    Check "a regenerated completion stays ours through its content" `
        (Test-CompletionArtifactIsOurs $foreignCompletion) "True"
} finally {
    Remove-Item -Recurse -Force $ownershipSandbox -ErrorAction SilentlyContinue
}

# --- a binary placed but not yet recorded is still repairable ---
#
# THE DEFECT, as reported: "refusing to replace
# C:\Users\...\AppData\Local\veyyon\veyyon.exe because it has changed since this
# installer wrote it", on a machine where that file hashed to the published
# SHA256 of a real release — a binary the product itself had put there. The
# receipt beside it still described the binary retired three days earlier. So the
# swap had completed and the receipt rewrite had not, and between those two steps
# sits a rename plus a ~150MB Get-FileHash of a file an antivirus scanner has just
# begun reading. From that moment the install was unrepairable through any shipped
# command: install refused, uninstall left the file, and the only remedy was
# deleting a 150MB executable by hand.
#
# THE CLASS this closes: any interruption between placing an artifact and
# recording it must leave the artifact recoverable. The record is now written
# BEFORE the swap, naming the bytes about to arrive, so at every instant the file
# at the target path is described by the durable receipt or the pending one.
#
# WHAT IT DOES NOT CATCH: a kill between the two writes cannot be staged
# in-process, so the recovery is asserted from the state such a kill LEAVES rather
# than by killing PowerShell mid-swap; the kill itself is driven against the
# updater in
# packages/coding-agent/test/an-update-interrupted-before-its-receipt-leaves-an-installable-binary.test.ts.
$pendingSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-pending-$PID"
New-Item -ItemType Directory -Force -Path $pendingSandbox | Out-Null
try {
    $interrupted = Join-Path $pendingSandbox "veyyon.exe"
    Set-Content -LiteralPath $interrupted -Value "the binary that was just installed"
    $incoming = Get-ArtifactIdentity $interrupted
    # The durable receipt still describes the binary this one REPLACED. That is
    # what the reported machine had on disk, and on its own it is a refusal.
    [System.IO.File]::WriteAllText((Join-Path $pendingSandbox ".veyyon.exe.veyyon-owner"),
        "veyyon-installer-v2`nfile sha256:0000000000000000000000000000000000000000000000000000000000000000`n")
    Check "a binary whose durable receipt describes the previous one is refused" `
        (Test-BinaryArtifactIsOurs $interrupted) "False"
    Set-ArtifactOwnershipPending -Path $interrupted -Identity $incoming
    Check "the pending receipt is written beside the durable one" `
        (Test-Path -LiteralPath (Join-Path $pendingSandbox ".veyyon.exe.veyyon-owner.pending")) "True"
    Check "and it is what lets the interrupted install be recognized as ours" `
        (Test-BinaryArtifactIsOurs $interrupted) "True"
    # NEGATIVE CONTROL. The pending receipt vouches for BYTES, not for a path, so
    # a file that is not those bytes gains nothing from it. Without this the fix
    # would hand ownership of whatever turns up at the path to the installer,
    # which is the defect the durable receipt exists to prevent.
    Set-Content -LiteralPath $interrupted -Value "a file somebody else put here"
    Check "a pending receipt does not vouch for a file it does not name" `
        (Test-BinaryArtifactIsOurs $interrupted) "False"
    Set-Content -LiteralPath $interrupted -Value "the binary that was just installed"
    Clear-ArtifactOwnershipPending $interrupted
    Check "clearing the pending receipt removes it" `
        (Test-Path -LiteralPath (Join-Path $pendingSandbox ".veyyon.exe.veyyon-owner.pending")) "False"
    Check "and the interrupted install is refused again once it is gone" `
        (Test-BinaryArtifactIsOurs $interrupted) "False"

    # Move-StagedBinaryIntoPlace is the production path. A completed install
    # leaves the durable receipt and NO pending one: a pending file surviving a
    # successful install is litter every "the install dir is clean" assertion in
    # e2e.test.ps1 would then have to know about.
    $cleanDir = Join-Path $pendingSandbox "clean"
    New-Item -ItemType Directory -Force -Path $cleanDir | Out-Null
    $cleanTarget = Join-Path $cleanDir "veyyon.exe"
    Set-Content -LiteralPath (Join-Path $cleanDir "staged") -Value "staged bytes"
    Move-StagedBinaryIntoPlace -StagingPath (Join-Path $cleanDir "staged") -TargetPath $cleanTarget | Out-Null
    Check "a completed install records the binary it placed" `
        (Test-ArtifactHasOwnerReceipt $cleanTarget) "True"
    Check "and leaves no pending record behind" `
        (Test-Path -LiteralPath (Join-Path $cleanDir ".veyyon.exe.veyyon-owner.pending")) "False"
    Check "and the staged file is gone" `
        (Test-Path -LiteralPath (Join-Path $cleanDir "staged")) "False"

    # THE REPAIR. Re-running the installer over the machine in the reported state
    # has to install, not refuse. Both directions matter: the same release again
    # (the byte-identical short-circuit, which also avoids touching a running
    # image) and a newer one (the pending record vouching for what is replaced).
    $sameDir = Join-Path $pendingSandbox "repair-same"
    New-Item -ItemType Directory -Force -Path $sameDir | Out-Null
    $sameTarget = Join-Path $sameDir "veyyon.exe"
    Set-Content -LiteralPath $sameTarget -Value "release 1 bytes"
    [System.IO.File]::WriteAllText((Join-Path $sameDir ".veyyon.exe.veyyon-owner"),
        "veyyon-installer-v2`nfile sha256:1111111111111111111111111111111111111111111111111111111111111111`n")
    Set-ArtifactOwnershipPending -Path $sameTarget -Identity (Get-ArtifactIdentity $sameTarget)
    Set-Content -LiteralPath (Join-Path $sameDir "staged") -Value "release 1 bytes"
    # The identity of the FILE, not of its contents: a swap that renamed identical
    # bytes into place would satisfy every content assertion below while still
    # having replaced a running image, which is the thing the short-circuit exists
    # to avoid. The write timestamp is what tells the two apart.
    $sameStamp = (Get-Item -LiteralPath $sameTarget -Force).LastWriteTimeUtc.Ticks
    Start-Sleep -Milliseconds 20
    $sameSaid = @(Move-StagedBinaryIntoPlace -StagingPath (Join-Path $sameDir "staged") -TargetPath $sameTarget 6>&1) -join "`n"
    Check "re-installing the same release over an unrecorded binary leaves it in place" `
        (Get-Content -LiteralPath $sameTarget -Raw).Trim() "release 1 bytes"
    Check "the file itself was never replaced" `
        (Get-Item -LiteralPath $sameTarget -Force).LastWriteTimeUtc.Ticks $sameStamp
    Check "and it says so rather than reporting an install that did not happen" `
        ($sameSaid -like "*already this exact binary*") "True"
    Check "the durable receipt is repaired" (Test-ArtifactHasOwnerReceipt $sameTarget) "True"
    Check "and the pending record is retired" `
        (Test-Path -LiteralPath (Join-Path $sameDir ".veyyon.exe.veyyon-owner.pending")) "False"

    $upDir = Join-Path $pendingSandbox "repair-upgrade"
    New-Item -ItemType Directory -Force -Path $upDir | Out-Null
    $upTarget = Join-Path $upDir "veyyon.exe"
    Set-Content -LiteralPath $upTarget -Value "release 1 bytes"
    [System.IO.File]::WriteAllText((Join-Path $upDir ".veyyon.exe.veyyon-owner"),
        "veyyon-installer-v2`nfile sha256:1111111111111111111111111111111111111111111111111111111111111111`n")
    Set-ArtifactOwnershipPending -Path $upTarget -Identity (Get-ArtifactIdentity $upTarget)
    Set-Content -LiteralPath (Join-Path $upDir "staged") -Value "release 2 bytes"
    Move-StagedBinaryIntoPlace -StagingPath (Join-Path $upDir "staged") -TargetPath $upTarget | Out-Null
    Check "upgrading over an unrecorded binary installs the new release" `
        (Get-Content -LiteralPath $upTarget -Raw).Trim() "release 2 bytes"
    Check "the receipt describes the new release" (Test-ArtifactHasOwnerReceipt $upTarget) "True"
    Check "and nothing was displaced" `
        (@(Get-ChildItem -Path $upDir -Filter "*.unowned.*" -Force).Count) "0"

    # The refusal still refuses, and it now says what to do about it. A file the
    # installer genuinely cannot account for is still not its to overwrite; the
    # difference is that the message names the record consulted and the switch
    # that proceeds, instead of leaving the user to guess at file surgery.
    $refuseDir = Join-Path $pendingSandbox "refuses"
    New-Item -ItemType Directory -Force -Path $refuseDir | Out-Null
    $refuseTarget = Join-Path $refuseDir "veyyon.exe"
    Set-Content -LiteralPath $refuseTarget -Value "another tool"
    Set-Content -LiteralPath (Join-Path $refuseDir "staged") -Value "staged bytes"
    $refusal = ""
    $script:Force = $false
    try {
        Move-StagedBinaryIntoPlace -StagingPath (Join-Path $refuseDir "staged") -TargetPath $refuseTarget | Out-Null
    } catch { $refusal = "$($_.Exception.Message)" }
    Check "a file this installer cannot account for is still refused" `
        ($refusal -like "*refusing to replace*") "True"
    Check "the refusal names the ownership record it consulted" `
        ($refusal -like "*.veyyon.exe.veyyon-owner*") "True"
    Check "the refusal names the switch that proceeds anyway" ($refusal -like "*-Force*") "True"
    Check "the file it refused to replace is untouched" `
        (Get-Content -LiteralPath $refuseTarget -Raw).Trim() "another tool"
    Check "and the staged download is not left behind" `
        (Test-Path -LiteralPath (Join-Path $refuseDir "staged")) "False"

    # -Force displaces; it never deletes. A machine already in the broken state
    # needs a way through that does not require hand-deleting a file the user
    # cannot identify, and the installer must not decide it was worthless.
    $forceDir = Join-Path $pendingSandbox "forced"
    New-Item -ItemType Directory -Force -Path $forceDir | Out-Null
    $forceTarget = Join-Path $forceDir "veyyon.exe"
    Set-Content -LiteralPath $forceTarget -Value "a file the installer cannot account for"
    Set-Content -LiteralPath (Join-Path $forceDir "staged") -Value "staged bytes"
    $script:Force = $true
    try {
        Move-StagedBinaryIntoPlace -StagingPath (Join-Path $forceDir "staged") -TargetPath $forceTarget | Out-Null
    } finally { $script:Force = $false }
    Check "-Force installs over a file the installer cannot account for" `
        (Get-Content -LiteralPath $forceTarget -Raw).Trim() "staged bytes"
    $displacedFiles = @(Get-ChildItem -Path $forceDir -Filter "veyyon.exe.unowned.*" -Force)
    Check "the displaced file survives under a name of its own" $displacedFiles.Count "1"
    Check "with its contents intact" `
        (Get-Content -LiteralPath $displacedFiles[0].FullName -Raw).Trim() "a file the installer cannot account for"
    Check "and that name is not one any update sweep reclaims" `
        (Test-UpdateAttemptLeftover -Name $displacedFiles[0].Name -BaseName "veyyon.exe" -Suffix "bak") "False"

    # A TRANSIENT read failure must not become a permanent verdict. On Windows the
    # 150MB executable this installer has just renamed is exactly what an
    # antivirus scanner opens, and one sharing violation used to answer "no
    # identity", which the callers read as "not ours" and recorded forever. The
    # hash is retried; Get-FileHash is shadowed to fail a fixed number of times,
    # because a real sharing violation cannot be staged in-process.
    $retryTarget = Join-Path $pendingSandbox "retry.exe"
    Set-Content -LiteralPath $retryTarget -Value "bytes that are readable"
    $trueIdentity = Get-ArtifactIdentity $retryTarget
    & {
        $script:hashCalls = 0
        $script:hashSucceedsAt = 3
        function Get-FileHash {
            param([string]$LiteralPath, [string]$Algorithm, [string]$ErrorAction)
            $script:hashCalls++
            if ($script:hashCalls -lt $script:hashSucceedsAt) {
                throw "The process cannot access the file because it is being used by another process."
            }
            return [pscustomobject]@{ Hash = "ABC123" }
        }
        Check "a hash that fails twice and then succeeds still yields an identity" `
            (Get-ArtifactIdentity $retryTarget) "file sha256:abc123"
        Check "and it stopped retrying as soon as it had an answer" $script:hashCalls "3"

        # BOUNDED. The retry has to END: a loop that kept trying would hang the
        # install on a file that is genuinely unreadable, which is worse than the
        # refusal it replaced.
        # 5, not 3: a number no plausible hardcoded loop limit coincides with, so
        # the assertion proves the CALLER's bound is honoured rather than that some
        # bound exists.
        $script:hashCalls = 0
        $script:hashSucceedsAt = [int]::MaxValue
        Check "a hash that never succeeds gives up instead of looping" `
            ($null -eq (Get-ArtifactIdentity $retryTarget -MaxAttempts 5)) "True"
        Check "and it tried exactly the number of attempts it was given" $script:hashCalls "5"
    }
    Check "the shadowed hash did not outlive its scope" (Get-ArtifactIdentity $retryTarget) $trueIdentity
} finally {
    Remove-Item -Recurse -Force $pendingSandbox -ErrorAction SilentlyContinue
}

# --- every name an update attempt leaves behind is recognized as the updater's ---
#
# THE DEFECT: a machine held a 147MB `veyyon.exe.6358c750-....bak` from an update
# three days earlier and no shipped command would remove it. The updater names each
# attempt's files after a crypto.randomUUID() so two concurrent updates cannot
# truncate each other's download, while the sweeps that reclaim them were written
# against the names of two releases earlier — a fixed `veyyon.exe.new` and a
# dot-numeric `veyyon.exe.<timestamp>.<pid>.bak`. They matched neither shape
# actually on disk, and `--uninstall` reported success over a directory holding a
# copy of the binary.
#
# THE CLASS: one producer, three recognizers (this one, `update_attempt_middle_is_ours`
# in install.sh, and `sweepStaleBackups` in update-cli.ts). All three must agree,
# or a file's fate depends on which command the user happened to run. The corpus
# below is the same one
# packages/coding-agent/test/every-name-an-update-leaves-behind-is-reclaimed.test.ts
# drives against the other two, where it is taken FROM the real updater at run
# time; keep them in step.
#
# WHAT IT DOES NOT CATCH: whether the updater still writes these names. That is
# observed from the producer in the TypeScript suite named above, which cannot run
# a PowerShell predicate.
$attemptNames = @(
    # Ours: every staging and backup name any shipped updater has written.
    @{ Name = "veyyon.exe.new"; Suffix = "new"; Ours = "True" },
    @{ Name = "veyyon.exe.6358c750-7c88-4c71-81c0-91c9b27c6c76.new"; Suffix = "new"; Ours = "True" },
    @{ Name = "veyyon.exe.bak"; Suffix = "bak"; Ours = "True" },
    @{ Name = "veyyon.exe.1753660000.4242.bak"; Suffix = "bak"; Ours = "True" },
    @{ Name = "veyyon.exe.b1f0a2c4-1111-4222-8333-444455556666.bak"; Suffix = "bak"; Ours = "True" },
    # Not ours: a copy saved by hand, and anything belonging to another command.
    @{ Name = "veyyon.exe.mine.bak"; Suffix = "bak"; Ours = "False" },
    @{ Name = "veyyon.exe.keep.new"; Suffix = "new"; Ours = "False" },
    @{ Name = "veyyon-other.exe.bak"; Suffix = "bak"; Ours = "False" },
    # One hex digit short of a UUID: the assertion that keeps the pattern from
    # degenerating into "anything with hyphens in it".
    @{ Name = "veyyon.exe.6358c750-7c88-4c71-81c0-91c9b27c6c7.bak"; Suffix = "bak"; Ours = "False" },
    # UUID-shaped, but no version-4 UUID has a 0 version nibble or a c variant.
    @{ Name = "veyyon.exe.6358c750-7c88-0c71-81c0-91c9b27c6c76.bak"; Suffix = "bak"; Ours = "False" },
    @{ Name = "veyyon.exe.6358c750-7c88-4c71-c1c0-91c9b27c6c76.bak"; Suffix = "bak"; Ours = "False" }
)
foreach ($case in $attemptNames) {
    Check "$($case.Name) is $(if ($case.Ours -eq 'True') { 'the updater''s' } else { 'not the updater''s' })" `
        (Test-UpdateAttemptLeftover -Name $case.Name -BaseName "veyyon.exe" -Suffix $case.Suffix) $case.Ours
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
    $warns = New-StubBinary -Name "warns" -GrepBody "echo CPU detection unavailable 1>&2 & echo %3\probe.txt:1: match & exit /b 0"

    $ok = $true
    try { Test-NativeAddon -Command $good *> $null } catch { $ok = $false }
    Check "Test-NativeAddon accepts a binary whose search works" $ok "True"

    # A valid binary may warn while selecting a conservative native variant.
    # PowerShell 5.1 promotes merged native stderr to a terminating error under
    # ErrorActionPreference=Stop; the exit code and expected match still decide.
    $ok = $true
    try { Test-NativeAddon -Command $warns *> $null } catch { $ok = $false }
    Check "Test-NativeAddon accepts a successful search that warns on stderr" $ok "True"

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
$dlStart = $ps1Text.IndexOf('$priorProgress = $ProgressPreference')
Check "the binary download progress block exists" ($dlStart -ge 0) "True"
$dlBlock = if ($dlStart -ge 0) { $ps1Text.Substring($dlStart, [Math]::Min(1400, $ps1Text.Length - $dlStart)) } else { "" }
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

# --- Get-ReleaseTagState: a git tag is not a release --------------------------
# THE BUG THIS PINS. The probe used to HEAD `/releases/tag/<tag>` and read
# GitHub's 200 as "this release is published". GitHub renders that page for a
# BARE GIT TAG with no release object, and for a tag whose only release is an
# unpublished draft, so `-Ref v1.0.39` walked straight past this check and died
# at the asset download blaming the platform binary for a release that was never
# cut. The old stub here could not see any of it: it answered the same way to
# every request, which is exactly what the real tag page does.
#
# Invoke-WebRequest is shadowed with github.com's real answers per tag, on BOTH
# endpoints, so the real Get-ReleaseTagState runs and a probe that goes back to
# the tag page fails these. Mirrors the release_tag_state block in
# functions.test.sh.
#
#   released    a published release with downloadable assets
#   unreleased  a real git tag with no release object, OR one whose release is
#               an unpublished draft. github.com cannot tell those apart from
#               outside, and the installer does not need it to: neither has
#               anything to download.
#   missing     no such tag
#
# v1.0.46, v1.0.39 and v1.0.42 are real tags of this repository and their states
# here are the ones the live endpoint returns. v1.0.37 and v2.0.0-rc.1 are the
# fixtures the `v`-spelling cases further down are written against.
function Get-VeyTagState {
    param([string]$Tag)
    switch ($Tag) {
        "v1.0.46"     { "released" }
        "v1.0.37"     { "released" }
        "v2.0.0-rc.1" { "released" }
        "v1.0.39"     { "unreleased" }
        "v1.0.42"     { "unreleased" }
        default       { "missing" }
    }
}
$Script:TagLookups = @()
$Script:TagRequests = @()
function Global:Invoke-WebRequest {
    # -Method is accepted but ignored: the old probe passed `-Method Head`, and a
    # refactor back to it must be diagnosed by the assertions below rather than
    # dying on a parameter this stand-in refused to bind.
    param([string]$Uri, [string]$Method, [int]$TimeoutSec, [switch]$UseBasicParsing)
    $Script:TagRequests += $Uri
    if ($Uri -match '/releases/expanded_assets/(.+)$') {
        $tag = $Matches[1]
        $endpoint = "assets"
    } elseif ($Uri -match '/releases/tag/(.+)$') {
        $tag = $Matches[1]
        $endpoint = "tagpage"
    } else {
        throw "the probe asked for a URL nothing serves: $Uri"
    }
    $Script:TagLookups += $tag
    $state = Get-VeyTagState $tag
    if ($state -eq "missing") { throw "404 Not Found" }
    if ($endpoint -eq "tagpage") {
        # The 200 that started all this: a tag page renders for a tag with no
        # release just as happily as for one with.
        return [pscustomobject]@{ Content = "the tag page, which github.com serves for an unreleased tag too" }
    }
    # The asset-list fragment. Only a published release carries download hrefs; a
    # bare tag and a draft get the two source archives and nothing else.
    $body = "<a href=`"/$Repo/archive/refs/tags/$tag.zip`">Source code (zip)</a>"
    if ($state -eq "released") {
        $body = "<a href=`"/$Repo/releases/download/$tag/veyyon-windows-x64.exe`">veyyon-windows-x64.exe</a>$body"
    }
    return [pscustomobject]@{ Content = $body }
}

Check "a published release with assets is installable" (Get-ReleaseTagState "v1.0.46") "released"
Check "a bare git tag with no release is NOT (the 200 that fooled the old probe)" `
    (Get-ReleaseTagState "v1.0.39") "unreleased"
Check "an unpublished draft is NOT either" (Get-ReleaseTagState "v1.0.42") "unreleased"
Check "a tag that does not exist is a THIRD, distinct answer" `
    (Get-ReleaseTagState "v9.9.9") "missing"
# The whole point of the three-way answer: "no release here" and "no such tag"
# must not collapse back into one, because they need different things said.
Check "the unreleased tag and the missing tag do not report the same state" `
    ((Get-ReleaseTagState "v1.0.39") -eq (Get-ReleaseTagState "v9.9.9")) "False"
# It must ask the endpoint that can actually tell those apart. The tag page
# cannot, which is the defect; a refactor back to it would pass any check that
# only asserted a boolean.
$Script:TagRequests = @()
$null = Get-ReleaseTagState "v1.0.46"
Check "the probe asks the asset-list fragment" `
    (@($Script:TagRequests | Where-Object { $_ -match '/releases/expanded_assets/v1\.0\.46$' }).Count) "1"
Check "and it does not ask the tag page at all" `
    (@($Script:TagRequests | Where-Object { $_ -match '/releases/tag/' }).Count) "0"

# --- Resolve-RefTag: the `v` a person leaves off a version --------------------
# Releases are tagged `v1.0.37` and `-Ref 1.0.37` is what people type: the same
# version, one character short of a tag that exists. Refusing it states a true
# fact and leaves the user guessing which of the two spellings this project uses.
# The `v` form is tried as a SECOND lookup and the caller announces what it
# resolved to, so the version being installed is the version on screen. Mirrors
# resolve_ref_tag in install.sh.
$Script:TagLookups = @()
Check "an exact tag is returned as given" (Resolve-RefTag "v1.0.37").Tag "v1.0.37"
Check "an exact tag costs one lookup" ($Script:TagLookups.Count) "1"

$Script:TagLookups = @()
Check "a bare version resolves to the published v-prefixed tag" (Resolve-RefTag "1.0.37").Tag "v1.0.37"
Check "the bare version was tried first, then the v form" (($Script:TagLookups -join ',')) "1.0.37,v1.0.37"

$Script:TagLookups = @()
Check "a prerelease version resolves too" (Resolve-RefTag "2.0.0-rc.1").Tag "v2.0.0-rc.1"

$Script:TagLookups = @()
Check "a bare version with no published v-tag is refused" (Resolve-RefTag "9.9.9").Tag ""
Check "and it stopped after the two spellings" (($Script:TagLookups -join ',')) "9.9.9,v9.9.9"
Check "a missing tag is reported as missing" (Resolve-RefTag "9.9.9").State "missing"

# A tag that exists with no release must come back as its OWN state, or the
# caller cannot tell the user why it refused.
Check "a tag with no release yields the tag that does exist, not a resolution" `
    (Resolve-RefTag "v1.0.39").Tag "v1.0.39"
Check "and reports the unreleased state, not the missing-tag one" `
    (Resolve-RefTag "v1.0.39").State "unreleased"
$Script:TagLookups = @()
Check "a bare unreleased version tries both spellings" `
    ((Resolve-RefTag "1.0.39").State + ":" + ($Script:TagLookups -join ',')) "unreleased:1.0.39,v1.0.39"

# A branch or a commit is not a version, so no `v` is bolted onto it: `vmain` and
# `vd83e6259` are tags nobody has, and asking costs a round trip before the same
# refusal.
$Script:TagLookups = @()
Check "a branch name gets no v-prefixed second try" (Resolve-RefTag "main").Tag ""
Check "the branch cost exactly one lookup" ($Script:TagLookups.Count) "1"

$Script:TagLookups = @()
Check "a commit sha gets no v-prefixed second try" (Resolve-RefTag "d83e6259").Tag ""
Check "the sha cost exactly one lookup" ($Script:TagLookups.Count) "1"

$Script:TagLookups = @()
Check "a v-prefixed tag that does not exist is refused without a second guess" (Resolve-RefTag "v9.9.9").Tag ""
Check "the missing v-tag cost exactly one lookup" ($Script:TagLookups.Count) "1"

# --- the message a -Ref failure actually puts on screen -----------------------
# The state above is only half the fix: it has to reach the user as a different
# sentence. Drives the real Install-Binary, which throws before it touches the
# filesystem, so these assert the text a person sees.
function Get-RefFailureMessage {
    param([string]$TestRef)
    $saved = $Ref
    $Script:Ref = $TestRef
    try {
        Install-Binary | Out-Null
        return "(no failure)"
    } catch {
        return $_.Exception.Message
    } finally {
        $Script:Ref = $saved
    }
}

Check "a tag with no release is told that, in those words" `
    ((Get-RefFailureMessage "v1.0.39") -match 'No release is published for tag v1\.0\.39') "True"
# The regression itself: the old message named the platform asset and pointed at a
# source build for a release that does not exist.
Check "and the refusal does not blame the platform binary" `
    ((Get-RefFailureMessage "v1.0.39") -match 'veyyon-windows-x64') "False"
Check "it points at the releases page" `
    ((Get-RefFailureMessage "v1.0.39") -match [regex]::Escape("https://github.com/$Repo/releases")) "True"
# `-Source with -Ref v1.0.39` used to be offered right here, and taking it cloned
# into ~/.veyyon/src on the installer's own initiative. The way out is the clone the
# USER runs, so the refusal hands over commands instead of a switch.
Check "and it hands over the manual clone instead of a switch" `
    ((Get-RefFailureMessage "v1.0.39") -match [regex]::Escape("git clone $RepoUrl")) "True"
Check "the manual route names the setup command that follows the clone" `
    ((Get-RefFailureMessage "v1.0.39") -match 'bun run setup') "True"
Check "and no refusal offers an installer switch that clones" `
    ((Get-RefFailureMessage "v1.0.39") -match '-Source') "False"
# `-Ref 1.0.39` is not a ref git can check out, so the refusal names the tag that
# exists rather than echoing back what was typed.
Check "a bare unreleased version is refused under the v-spelled tag" `
    ((Get-RefFailureMessage "1.0.39") -match 'No release is published for tag v1\.0\.39') "True"
# `-Ref <branch>` was the other door to a clone: it implied a source build and
# checked the branch out. A ref is a published release tag or nothing now, and the
# refusal has to hand over every command the user runs, checkout step included,
# because the installer runs none of them.
Check "a branch ref is refused as a tag that does not exist" `
    ((Get-RefFailureMessage "main") -match 'release tag not found: main') "True"
Check "the refusal says only published tags are installable" `
    ((Get-RefFailureMessage "main") -match 'Only published release tags are installable') "True"
Check "it hands over the clone the user runs" `
    ((Get-RefFailureMessage "main") -match [regex]::Escape("git clone $RepoUrl")) "True"
Check "and names the checkout step for the branch that was asked for" `
    ((Get-RefFailureMessage "main") -match [regex]::Escape("git checkout main")) "True"
Check "no installer switch is offered for a branch" `
    ((Get-RefFailureMessage "main") -match '-Source') "False"
Check "a draft release reads the same way to the user" `
    ((Get-RefFailureMessage "v1.0.42") -match 'No release is published for tag v1\.0\.42') "True"
# A tag nobody ever created is a typo, not an unreleased version, and keeps the
# message it always had.
Check "a tag that does not exist is still named as a missing tag" `
    ((Get-RefFailureMessage "v9.9.9") -match 'Release tag not found: v9\.9\.9') "True"
Check "and a missing tag is not described as an unreleased one" `
    ((Get-RefFailureMessage "v9.9.9") -match 'No release is published') "False"

Remove-Item Function:Global:Invoke-WebRequest -ErrorAction SilentlyContinue

# --- the installer refuses to clone, and says who does instead ----------------
# -Source built from a git checkout: it cloned into ~/.veyyon/src, installed bun if
# it had to, and built in there, so an `irm | iex` install could leave a second
# divergent copy of the product on the machine and development started happening
# inside it. The switch is gone.
#
# The unknown-option arm lives in the Main block, which the dot-source at the top
# of this file deliberately skips, so this runs the installer as a CHILD process:
# the exit status and what lands on screen are the contract here.
#
# And the child has to be given a clean VEYYON_INSTALL_SOURCED. The top of this
# file sets it as a PROCESS variable so the dot-source loads the functions without
# installing, and a child pwsh inherits the whole environment, so the installer ran
# with its Main block switched off: it printed nothing, exited 0, and the three
# assertions below read that silence as an installer that accepts -Source. The
# guard is real; only the harness was hiding it. Cleared here and put back in the
# finally, so the variable this file was started with survives the block.
$refuseSandbox = Join-Path ([System.IO.Path]::GetTempPath()) "veyyon-ps1-refuse-$PID"
if (Test-Path $refuseSandbox) { Remove-Item -Recurse -Force $refuseSandbox }
New-Item -ItemType Directory -Force -Path $refuseSandbox | Out-Null
$savedUserProfile = $env:USERPROFILE
$savedEnvInstallDir = $env:VEYYON_INSTALL_DIR
$savedSourced = $env:VEYYON_INSTALL_SOURCED
try {
    $env:VEYYON_INSTALL_SOURCED = $null
    # Its own USERPROFILE, because the last assertion is about what the run left in
    # it: $SrcDir defaults to %USERPROFILE%\.veyyon\src, so a run that still cloned
    # would land exactly there.
    $env:USERPROFILE = $refuseSandbox
    $env:VEYYON_INSTALL_DIR = Join-Path $refuseSandbox "bin"
    $installPs1 = Join-Path $root "scripts/install.ps1"
    $sourceOut = (& (Get-Process -Id $PID).Path -NoProfile -File $installPs1 -Source 2>&1 | Out-String)
    Check "-Source exits non-zero" ([bool]($LASTEXITCODE -ne 0)) "True"
    Check "and is refused as an unknown option, naming what was passed" `
        ([bool]($sourceOut -match 'unknown option: -Source')) "True"
    # An `irm | iex` install shows the option list nowhere else, so the complaint on
    # its own would leave the user with no way to find the options that do exist.
    Check "the refusal prints the usage text with it" `
        ([bool]($sourceOut -match 'veyyon installer')) "True"
    # Refusing before anything happens is the point: a run that printed the usage and
    # still left a checkout behind would satisfy every assertion above.
    Check "the refused switch cloned nothing" `
        (Test-Path (Join-Path $refuseSandbox ".veyyon\src")) "False"
} finally {
    $env:USERPROFILE = $savedUserProfile
    $env:VEYYON_INSTALL_DIR = $savedEnvInstallDir
    $env:VEYYON_INSTALL_SOURCED = $savedSourced
    Remove-Item -Recurse -Force $refuseSandbox -ErrorAction SilentlyContinue
}

# Write-Usage owns the option list and is dot-sourced here, so the list itself is
# asserted in-process: it documents the binary install and no source install, in
# any spelling. A switch that no longer exists but is still advertised is the same
# defect as a dead flag.
$usageText = (Write-Usage 6>&1 | Out-String)
Check "the option list documents the binary install" ([bool]($usageText -match '-Binary')) "True"
Check "and documents no source install" ([bool]($usageText -match '-Source')) "False"
# The RENDERED text, not the source line. A backtick is PowerShell's escape
# character inside a here-string, so the single-backtick spelling of ``bun run
# setup`` compiled to a BACKSPACE followed by "un run setup": the option list told
# the reader whose ref is not installable to run `un run setup`, and the parity
# suite in scripts/installer-help-parity.test.ts could not see it because it reads
# install.ps1 as text, where the `b` is still there. Assert the command a user can
# type, and that no control character reached the screen.
Check "the checkout route names the setup command a user can type" `
    ([bool]($usageText -match 'bun run setup')) "True"
Check "and the option list carries no control characters" `
    ([bool]($usageText -match "[\x00-\x08\x0b\x0c\x0e-\x1f]")) "False"

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
