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

Write-Host ""
Write-Host "$($script:Pass) passed, $($script:Fail) failed"
if ($script:Fail -ne 0) { exit 1 }
