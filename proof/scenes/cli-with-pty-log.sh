#!/usr/bin/env bash
# Launch the CLI inside the recording terminal and keep the bytes it writes.
#
# Set SCENE_COMMAND to this script when a scene has to prove what the app WROTE,
# not only what the emulator painted: an animation the app emits as thirteen
# frames and the emulator coalesces into one looks identical on video to an
# animation that never ran. The typescript lands beside the video in /out.
set -euo pipefail
exec script -qec "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b" \
	"/out/${PTY_LOG_NAME:-scene}.typescript"
