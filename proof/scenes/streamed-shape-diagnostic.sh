#!/usr/bin/env bash
# Record a real model reply through the native composer, not seeded arrival.
# Run both arms with proof/docker/record-native.sh and fresh OUT_DIR values.
# Before uses the current-chrome binary described in desktop-streamed-shape.sh.
#
# The working tint and consecutive transcript changes establish live arrival.
# Persisted assistant text must contain numbered items and bold Markdown.
# Inspect the recorded moving interval for partial-marker rendering. Neither
# these pixel checks nor a still proves that every arriving shape was mended.
# Provider replies are retained for comparison: different replies are not a
# matched animation differential, even when both takes pass their assertions.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

PREFIX_DIR="${TMPDIR}/moving-prefix"
mkdir -p "${PREFIX_DIR}"
export PREFIX_DIR
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
PREFIX_CROP="${SESSION_REGION_W}x$(( WIN_H - 3 * TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + 3 * TITLEBAR_H ))"
QUEUE_CROP="${RAIL_W}x$(( WIN_H - 3 * TITLEBAR_H ))+${WIN_X}+$(( WIN_Y + 3 * TITLEBAR_H ))"

# Select the actual local provider through the same picker as a native turn.
probe_frame "${PREFIX_DIR}/picker-closed.png"
move_px "${MODEL_CHIP_X}" "${MODEL_CHIP_Y}"
click
pause 0.8
PICKER="$(screen_differs_from_frame_pixels_at "${PREFIX_DIR}/picker-closed.png" "${WINDOW_CROP}")"
if [ "${PICKER}" -lt 20000 ]; then
	abandon_take "prefix-model-picker-open" "the model picker changed only ${PICKER} pixels"
fi
t "local/qwen2.5-1.5b"
pause 0.6
k "Return"
pause 0.8
submit_prompt 'Write a Markdown numbered list from 1 to 80, one item per line. Use exactly the line formats `1. **One**`, `2. **Two**`, through `80. **Eighty**`. Each line must end with the closing asterisks, without trailing punctuation. Output the list only: no backticks, tools, code fences, introduction, or conclusion.'
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# No further input during this interval. A changing transcript while the row
# reports Working must come from the real turn, not pointer or typing motion.
probe_frame "${PREFIX_DIR}/previous.png"
MOVING=0
for SAMPLE in $(seq 1 120); do
	pause 0.25
	DELTA="$(screen_differs_from_frame_pixels_at "${PREFIX_DIR}/previous.png" "${PREFIX_CROP}")"
	probe_frame "${PREFIX_DIR}/current.png"
	WORKING="$(working_tint_pixels "${PREFIX_DIR}/current.png" "${QUEUE_CROP}")"
	printf '%s\t%s\t%s\n' "${SAMPLE}" "${DELTA}" "${WORKING}" >> "${PREFIX_DIR}/samples.tsv"
	if [ "${DELTA}" -ge 400 ] && [ "${WORKING}" -ge 600 ]; then
		MOVING=$(( MOVING + 1 ))
		shot "prefix-moving-${MOVING}"
		if [ "${MOVING}" -eq 4 ]; then
			break
		fi
	fi
	cp "${PREFIX_DIR}/current.png" "${PREFIX_DIR}/previous.png"
done
if [ "${MOVING}" -ne 4 ]; then
	abandon_take "prefix-arrived-while-running" "only ${MOVING} transcript changes of 400px occurred with at least 600px Working tint"
fi
if ! native_session_ready finished; then
	abandon_take "prefix-turn-completed" "the real provider turn did not finish and persist its reply"
fi
pause 0.8
shot prefix-complete

# Read only what the real provider persisted. An independent host connection
# has its own session and cannot establish the live prefix sent to the window.
python3 - <<'PY'
import json
import os
from pathlib import Path
import re

runtime = Path(os.environ['TMPDIR'])
session = json.loads((runtime / 'created-session.json').read_text())
profile = os.environ.get('VEYYON_PROFILE') or 'default'
store = Path.home() / '.veyyon' / 'profiles' / profile / 'agent' / 'sessions'
paths = list(store.rglob(f'*_{session}.jsonl'))
if len(paths) != 1:
	raise SystemExit(f'Expected one stored session, found {len(paths)}')
replies = []
for line in paths[0].read_text().splitlines():
	message = json.loads(line).get('message', {})
	if message.get('role') != 'assistant':
		continue
	content = message.get('content', [])
	if not isinstance(content, list):
		raise SystemExit('Assistant content is not a block list')
	if any(block.get('type') == 'toolCall' for block in content):
		raise SystemExit('The provider called a tool instead of producing the requested list')
	replies.append(''.join(block.get('text', '') for block in content if block.get('type') == 'text'))
text = '\n'.join(replies)
items = re.findall(r'^\s*(\d+)\.\s+\*\*([^*\n]+)\*\*\s*$', text, re.MULTILINE)
(Path(os.environ['SCENE_OUT']) / f"{os.environ['SCENE_NAME']}-provider-reply.txt").write_text(text)
if [int(number) for number, _ in items] != list(range(1, 81)):
	raise SystemExit(f'The real reply contains {len(items)} numbered bold items, not the requested 1 through 80')
print('scene: persisted real assistant reply contains numbered bold items 1 through 80')
PY
printf 'scene: observed %s transcript changes while the native row reported Working\n' "${MOVING}" >&2
