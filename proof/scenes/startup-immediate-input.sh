#!/usr/bin/env bash
# Record draft input from the first launch frame through session initialization.
# Set SCENE_COMMAND='env STARTUP_EXECUTABLE=/repo/path/to/binary bash -l'.
# Record both compiled arms with identical settings, dimensions and input timing.
# needle-source: draft input remains ordered during startup -- typed below
set -euo pipefail

TYPE_DELAY="${TYPE_DELAY:-20}"
settle 1
submit 'cd "$HOME"; exec "${STARTUP_EXECUTABLE:?compiled target required}" --no-session --model local/qwen2.5-1.5b'
pause 0.06
draft='draft input remains ordered during startup'
for ((index = 0; index < ${#draft}; index++)); do
	t "${draft:index:1}"
	pause 0.04
done
expect_screen "draft input remains ordered during startup" 30
settle 0.5
expect_screen "Qwen2.5 1.5B (local)" 30
shot retained
