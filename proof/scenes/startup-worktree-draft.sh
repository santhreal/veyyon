#!/usr/bin/env bash
# Record startup metadata and typing in a linked worktree.
# Start the terminal with SCENE_COMMAND='bash -l'. To compare compiled targets,
# use SCENE_COMMAND='env STARTUP_EXECUTABLE=/repo/path/to/binary bash -l'.
# Both arms require the same seeded settings and terminal dimensions.
# The clip covers launch through session mounting; the resting still checks the draft.
# needle-source: startup draft retained while initialization completes -- typed in loop during initialization
set -euo pipefail

TYPE_DELAY="${TYPE_DELAY:-20}"
settle 4
submit 'printf "\nstartup:\n  checkUpdate: false\n  autoUpdate: false\n" >> "$HOME/.veyyon/config.yml"'
submit 'git worktree add -b startup-proof /sandbox/home/startup-proof'
pause 1
submit 'cd /sandbox/home/startup-proof'
pause 0.5
submit 'if test -n "${STARTUP_EXECUTABLE:-}"; then "$STARTUP_EXECUTABLE" --no-session --model local/qwen2.5-1.5b; else bun /repo/packages/coding-agent/src/cli.ts --no-session --model local/qwen2.5-1.5b; fi'
pause 0.06
draft='startup draft retained while initialization completes'
for ((index = 0; index < ${#draft}; index++)); do
	t "${draft:index:1}"
	pause 0.04
done
expect_screen "startup draft retained while initialization completes" 20
settle 2
expect_screen "Qwen2.5 1.5B (local)" 20
expect_screen "% left" 20
shot resting
