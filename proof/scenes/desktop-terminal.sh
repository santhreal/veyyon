#!/usr/bin/env bash
# Exercise native pointer focus and terminal input through the real host PTY.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

k "ctrl+backslash"
pause 0.25
k "ctrl+j"
pause 2
shot terminal-open

move_px "$(( WIN_X + WIN_W / 2 ))" "$(( WIN_Y + WIN_H - 90 ))"
click
pause 0.25
t "echo terminal-input-ok"
k "Return"
pause 1.5
shot terminal-command-output
