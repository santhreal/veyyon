#!/usr/bin/env bash
# SCENE_COMMAND='env STARTUP_EXECUTABLE=/repo/path/to/binary bash -l'
# Replay both selector shortcuts during initialization against isolated binaries.
set -euo pipefail

TYPE_DELAY=1
settle 4
submit 'printf "\nstartup:\n  checkUpdate: false\n  autoUpdate: false\n" >> "$HOME/.veyyon/config.yml"'
submit 'cp "$STARTUP_EXECUTABLE" "$HOME/startup-target"'
settle 1
submit '"$HOME/startup-target" --no-session --model local/qwen2.5-1.5b'
expect_screen '›' 20 model-launch-composer
t 'unsubmitted selector draft'
t $'\033m'
settle 3
if [[ "${SCENE_ARM:-after}" != "before" ]]; then
	expect_screen 'Switch Model' 20 early-model-selector
fi
shot early-model-selector
k Escape
t ' retained'
settle 1
expect_screen 'unsubmitted selector draft retained' 15 model-selector-draft
shot model-selector-draft
clear_composer
k ctrl+d
settle 2
submit 'clear'
settle 1

submit '"$HOME/startup-target" --no-session --model local/qwen2.5-1.5b'
expect_screen '›' 20 temporary-launch-composer
t 'unsubmitted temporary draft'
t $'\033p'
settle 3
if [[ "${SCENE_ARM:-after}" != "before" ]]; then
	expect_screen 'Switch Model' 20 early-temporary-selector
fi
shot early-temporary-selector
k Escape
t ' retained'
settle 1
expect_screen 'unsubmitted temporary draft retained' 15 temporary-selector-draft
shot temporary-selector-draft
clear_composer
k ctrl+d
settle 2
