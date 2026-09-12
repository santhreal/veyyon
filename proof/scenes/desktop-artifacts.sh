#!/usr/bin/env bash
# Drive the native GPUI desktop front end window and capture transcript artifact
# and disclosure workflows through the real GUI host.
#
# Records visual evidence for:
#   1. idle (composer in initial idle state)
#   2. typed-draft (draft text typed into composer)
#   3. model-picker-open (model picker palette overlay open)
#   4. model-picker-dismissed (model picker dismissed; draft retained in composer)
#   5. slash-palette-open (slash commands palette overlay open)
#   6. slash-palette-dismissed (slash palette dismissed)
#   7. model-selected (local model chosen from picker)
#   8. artifact-user-image-collapsed (user turn with prompt and collapsed image artifact)
#   9. artifact-user-image-expanded (expanded image artifact with decoded preview & metadata)
#  10. artifact-user-image-recollapsed (re-collapsed image artifact block)
#  11. transcript-second-turn (second turn completed with file inspection output)
#  12. contextual-file-panel-open (contextual right panel open with file / tree view)
#  13. contextual-file-panel-closed (contextual right panel toggled closed)
#
# Two of those marks are found rather than aimed at: a transcript is anchored to
# its live edge, so the artefact row sits wherever the model's prose left it,
# and the search that finds it clicks a row a second and measures the frame.
# That is fourteen still seconds in a sixty-second take, which reads as eleven
# frames a second of change against the twelve the recorder requires, so the
# take declares its own floor:
#
#   SCENE_MOTION_FLOOR=9 proof/docker/record-native.sh proof/scenes/desktop-artifacts.sh
#
# That is not a waiver. The floor exists to stop a stuttering capture being
# published as a clip, and the search here is a still window under a moving
# pointer rather than a compositor dropping frames: the number is measured and
# printed either way, and the two disclosure marks assert their own pixel
# deltas, which a stuttered capture could not produce.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT,
# and SCENE_LIB already initialized.

set -euo pipefail

# Synthesize a non-private PNG test asset in the demo workspace
synthesize_demo_png() {
python3 - <<'PY'
import base64
import os
from pathlib import Path
import struct
import zlib

def create_test_png(w=64, h=64, color=(0, 160, 255, 255)):
    png = b'\x89PNG\r\n\x1a\n'
    ihdr_data = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    ihdr_crc = struct.pack('>I', zlib.crc32(b'IHDR' + ihdr_data) & 0xffffffff)
    png += struct.pack('>I', len(ihdr_data)) + b'IHDR' + ihdr_data + ihdr_crc
    
    raw_rows = bytearray()
    for y in range(h):
        raw_rows.append(0)  # filter type: None
        for x in range(w):
            if (x < w // 2 and y < h // 2) or (x >= w // 2 and y >= h // 2):
                raw_rows.extend([color[0], color[1], color[2], color[3]])
            else:
                raw_rows.extend([255, 255, 255, 255])
    
    idat_data = zlib.compress(bytes(raw_rows))
    idat_crc = struct.pack('>I', zlib.crc32(b'IDAT' + idat_data) & 0xffffffff)
    png += struct.pack('>I', len(idat_data)) + b'IDAT' + idat_data + idat_crc
    
    iend_crc = struct.pack('>I', zlib.crc32(b'IEND') & 0xffffffff)
    png += struct.pack('>I', 0) + b'IEND' + iend_crc
    return png

runtime_dir = Path(os.environ["TMPDIR"])
runtime_dir.mkdir(parents=True, exist_ok=True)
png_bytes = create_test_png(64, 64)

demo_dir = Path("/sandbox/home/demo/src")
demo_dir.mkdir(parents=True, exist_ok=True)
png_path = demo_dir / "architecture.png"
png_path.write_bytes(png_bytes)
print(f"Synthesized demo PNG: {png_path} ({len(png_bytes)} bytes)")
PY
}

synthesize_demo_png

# Drive composer interactions: idle, typed-draft, model-picker, slash-palette
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Model Selection ──────────────────────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5
shot model-selected

# ─── Prompt Submission with PNG Attachment ────────────────────────────────────
# The aim is the preamble's, derived from the token files, not the window's
# midpoint at a height this scene decides: a click outside the card focuses the
# transcript and the prompt is typed into nothing.
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"

# `/attach` first: the command row takes the draft, so the prompt naming the
# file is typed after the attachment is held.
type_prompt "/attach" 40
k "Return"
pause 0.4
submit_prompt "Examine @src/architecture.png and state its structure in one short sentence. Do not call tools."
if ! native_session_ready finished 2; then
	abandon_take "native-artifact-turn-produced" "turn with attachment did not produce completed transcript within 90s"
fi

pause 0.8
# The transcript displays the user turn with prompt text and collapsed image artifact block
shot artifact-user-image-collapsed

# ─── Expand Transcript Artifact Disclosure ────────────────────────────────────
# The transcript is anchored to its live edge, so the artifact row sits above
# the composer at a height that depends on how much prose the model wrote, not
# at a fixed offset under the titlebar. The row is right-aligned to the
# transcript column, whatever width the prompt's own bubble takes, so the
# column's trailing edge is the one x inside every row; the y is found by
# clicking upward from just above the composer and measuring each click against
# the collapsed frame. The sidebar is cropped off the comparison because it
# prints each session's age.
use_crop \
	$(( WIN_X + RAIL_W )) \
	$(( WIN_Y + TITLEBAR_H )) \
	$(( WIN_W - RAIL_W )) \
	$(( WIN_H - TITLEBAR_H ))

ARTIFACT_CLICK_X=$(( TRANSCRIPT_COLUMN_RIGHT - 40 ))
COMPOSER_REST_X=$((WIN_X + WIN_W / 2))
COMPOSER_REST_Y=$((WIN_Y + WIN_H - 98))

# Click rows upward from a starting height until the screen leaves the state
# the named shot holds, and leave the y that did it in ARTIFACT_CLICK_Y. The
# pointer parks on the composer between tries because a row under the pointer
# draws its hover ground, which is a change the comparison would read as a
# disclosure. Each try is a still second of the take, so the search is kept
# short: the caller starts it where the row can be and bounds it to the rows
# above that.
click_rows_upward_until_changed() { # <from-y> <tries> <shot>
	local from_y="$1" tries="$2" shot="$3" step
	for step in $(seq 0 $((tries - 1))); do
		ARTIFACT_CLICK_Y=$((from_y - step * 24))
		move_px "${ARTIFACT_CLICK_X}" "${ARTIFACT_CLICK_Y}"
		pause 0.2
		click
		pause 0.5
		move_px "${COMPOSER_REST_X}" "${COMPOSER_REST_Y}"
		pause 0.2
		if [ "$(screen_differs_from_shot_per_mille "${shot}")" -gt 2 ]; then
			return 0
		fi
	done
	return 1
}

ARTIFACT_CLICK_Y=0
if ! click_rows_upward_until_changed \
	$((WIN_Y + WIN_H - 150)) 8 artifact-user-image-collapsed; then
	abandon_take "native-artifact-row-disclosed" \
		"no row in the eight above the composer disclosed anything when clicked"
fi
# Capture expanded image artifact view with decoded PNG rendering & metadata
shot artifact-user-image-expanded

# A disclosed image row draws the decoded preview, which repaints far more than
# the 24px row it opened from.
DISCLOSED="$(shots_differ_pixels artifact-user-image-collapsed artifact-user-image-expanded)"
if [ "${DISCLOSED}" -lt 1200 ]; then
	abandon_take "native-artifact-row-disclosed" \
		"disclosing the row changed ${DISCLOSED} pixels, under the 1200 a row and its decoded preview redraw"
fi
echo "scene: artifact disclosure ${DISCLOSED} pixels" >&2

# ─── Re-collapse the Artifact Disclosure ──────────────────────────────────────
# The detail the row opened is drawn between the row and the composer, so the
# row header is no longer where the click that opened it landed: it moved up by
# the height of what it disclosed, which is the image ceiling plus its metadata
# line and action row. The search therefore starts one row above the click that
# opened it and never below, and the frame that comes back has to be the
# collapsed one rather than merely a frame that changed, which a click landing
# on the detail's own controls would also produce.
if ! click_rows_upward_until_changed \
	$((ARTIFACT_CLICK_Y - 24)) 16 artifact-user-image-expanded; then
	abandon_take "native-artifact-row-recollapsed" \
		"no row above the disclosed detail closed it when clicked, so the detail is still drawn"
fi
shot artifact-user-image-recollapsed

RECLOSED="$(shots_differ_pixels artifact-user-image-collapsed artifact-user-image-recollapsed)"
if [ "${RECLOSED}" -gt 1200 ]; then
	abandon_take "native-artifact-row-recollapsed" \
		"the frame after re-collapsing differs from the collapsed frame by ${RECLOSED} pixels, so it is some other state"
fi
echo "scene: re-collapsed within ${RECLOSED} pixels of the collapsed frame" >&2

# ─── Second Turn with File Inspection ─────────────────────────────────────────
move_px "$((WIN_X + WIN_W / 2))" "$((WIN_Y + WIN_H - 98))"
click
t "Inspect src/parser.ts and state what it exports in one sentence. Do not call tools."
k "Return"

if ! native_session_ready finished 4; then
	abandon_take "native-second-turn-completed" "second turn did not complete within 90s"
fi

pause 0.6
shot transcript-second-turn

# ─── Contextual File Panel Transitions ────────────────────────────────────────
PANEL_OVERLAY_BREAKPOINT="$(python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["right_panel"]["overlay_breakpoint_px"])' "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens/surface/panels.toml")"
if (( WIN_W < PANEL_OVERLAY_BREAKPOINT )); then
	k "ctrl+backslash"
	pause 0.5
fi

# Toggle contextual file panel open
k "ctrl+backslash"
pause 0.6
shot contextual-file-panel-open

# Toggle contextual file panel closed
k "ctrl+backslash"
pause 0.6
shot contextual-file-panel-closed

# Restore contextual file panel open
k "ctrl+backslash"
pause 0.6
