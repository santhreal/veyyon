#!/usr/bin/env bash
# Start with SCENE_COMMAND='env STARTUP_EXECUTABLE=/repo/path/to/binary bash -l'.
# Compare isolated compiled targets with the same settings and terminal geometry.
set -euo pipefail

TYPE_DELAY=1
settle 4
submit 'printf "\nstartup:\n  checkUpdate: false\n  autoUpdate: false\n" >> "$HOME/.veyyon/config.yml"'
submit 'cp "$STARTUP_EXECUTABLE" "$HOME/startup-target"; "$HOME/startup-target" --no-session --model local/qwen2.5-1.5b'
pause 0.06
submit '/settings'
t 'unsubmitted startup draft'
settle 3
expect_screen "Qwen2.5 1.5B (local)" 20
shot early-settings
