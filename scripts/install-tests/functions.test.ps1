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

# --- Get-PathWithDir: appends distinctly, never a leading/duplicate ';' ---
Check "append to a null PATH has no leading ';'" (Get-PathWithDir $null "C:\a\bin") "C:\a\bin"
Check "append to an empty PATH has no leading ';'" (Get-PathWithDir "" "C:\a\bin") "C:\a\bin"
Check "append to a normal PATH" (Get-PathWithDir "C:\x;C:\y" "C:\a\bin") "C:\x;C:\y;C:\a\bin"
Check "already-present dir leaves PATH unchanged" (Get-PathWithDir "C:\x;C:\a\bin" "C:\a\bin") "C:\x;C:\a\bin"
Check "a prefix-substring entry does NOT block the add" `
    (Get-PathWithDir "C:\a\bin2" "C:\a\bin") "C:\a\bin2;C:\a\bin"
Check "empty entries are cleaned out on append" (Get-PathWithDir "C:\x;;C:\y" "C:\a\bin") "C:\x;C:\y;C:\a\bin"

# --- source-checkout data-loss protection (mirrors install.sh) ---
# The update path runs `git reset --hard`, and uninstall used to rm the checkout
# outright. Locks the Windows-side fix: a user's local edits under ~/.veyyon/src
# (an edited AGENTS.md) must be preserved on a veyyon-local-* branch before a
# reset, an existing tree must be moved aside rather than deleted before a fresh
# clone, and uninstall must never delete a checkout holding unpushed work.
if (Get-Command git -ErrorAction SilentlyContinue) {
    # Uninstall-Veyyon calls Test-BunInstalled/bun; stub it out so the src-handling
    # branch is exercised without touching a real global install.
    function Test-BunInstalled { return $false }

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

Write-Host ""
Write-Host "$($script:Pass) passed, $($script:Fail) failed"
if ($script:Fail -ne 0) { exit 1 }
