#!/usr/bin/env bash
# Open a file whose lines are wider than the panel and reach the far end of one
# of them, in the native GPUI window.
#
# Records visual evidence for:
#   1. pane-at-rest      (the file drawn in the File tab, at the head of its lines)
#   2. pane-scrolled     (the same rows after a sideways wheel over the code)
#   3. pane-scrolled-down (the same pane after a vertical wheel over the code)
#
# Frames 1 and 2 are the differential, and the claim is what happens to each of
# the pane's two columns (§5.11): the code moves and the line numbers do not.
# One frame of a code view proves nothing, because a pane that clips its long
# lines and a pane that scrolls them draw the same first column of text.
#
# Frame 3 is the axis claim, and it is asserted in both arms: a vertical wheel
# over the code moves the numbers with the lines, so the sideways gesture is
# restricted to the axis it was made on rather than being mapped onto the one
# axis a region scrolls.
#
# The file is synthesized in the workspace the session runs in, because the
# defect needs a line wider than the panel and this workspace's own sources are
# wrapped narrower than that. Nothing else here is seeded: the rows are the
# host's read of a real file through the real lookup.
#
# THE ARMS. Before, a file row was one box with `overflow_hidden` on the text:
# a line wider than the pane was cut at its edge mid-glyph, with nothing to say
# it was cut and no gesture that reached the rest. So the before arm asserts the
# absence in its own direction -- a sideways wheel that either does nothing or
# takes the numbers with it -- and the after arm asserts the split.
#
# The change is entirely inside the executable, so the arm holds no source and
# takes a build with the change removed:
#
#   SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh proof/scenes/desktop-mono-pane.sh
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-mono-pane.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# A file whose widest line is far wider than any panel this window sheds to, so
# the head of the line is all a clipping pane can draw. The lines are numbered
# in their own text as well, so a frame states which part of the file is under
# the pointer.
FILE_NAME="wide-columns.rs"
synthesize_wide_file() {
python3 - "${FILE_NAME}" <<'PY'
from pathlib import Path
import sys

target = Path("/sandbox/home/demo/src") / sys.argv[1]
target.parent.mkdir(parents=True, exist_ok=True)
lines = []
for number in range(1, 41):
    # One long line per row: 900 characters of `let` bindings, which syntect
    # highlights into several spans, so the pane's own width is the sum of a
    # row's spans rather than one run.
    body = " ".join(f"let column_{number:02}_{step:03} = {step};" for step in range(30))
    lines.append(f"pub fn row_{number:02}() {{ {body} }}")
target.write_text("\n".join(lines) + "\n")
print(f"synthesized wide file: {target} ({max(len(l) for l in lines)} columns)")
PY
}

synthesize_wide_file

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Pane's Two Columns ──────────────────────────────────────────────────
# Both rectangles come from the token files: the gutter is `diff.gutter_width_px`
# wide, the rows start below the tab strip and the file's own header row, and a
# floated panel draws inside a sheet the crops start past. A scene that restated
# any of them would read a shifted pane as a still one.
read -r GUTTER_W ROW_H TABS_H CHROME_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

panels = tomllib.loads((Path(sys.argv[1]) / "surface" / "panels.toml").read_text())
print(
    int(panels["diff"]["gutter_width_px"]),
    int(panels["diff"]["row_height_px"]),
    int(panels["tabs"]["height_px"]),
    int(panels["chrome"]["row_height_px"]),
)
PY
)

PANEL_LEFT=$(( WIN_X + WIN_W - PANEL_W + SHEET_INSET ))
PANEL_RIGHT=$(( WIN_X + WIN_W - SHEET_INSET ))
PANEL_TOP=$(( WIN_Y + TITLEBAR_H + SHEET_INSET ))
# A float ends above the composer's band; a column runs to the window's foot.
PANEL_BOTTOM=$(( WIN_Y + WIN_H - SHEET_INSET ))
if [ "${PANEL_MODE}" = "overlay" ]; then
	PANEL_BOTTOM=$(( WIN_Y + WIN_H - COMPOSER_BAND_H - SHEET_INSET ))
fi
# The rows of the file, past the tab strip and the path header above them, and
# one row short of the pane's lower edge, which is a partially drawn row.
ROWS_TOP=$(( PANEL_TOP + TABS_H + CHROME_H ))
ROWS_BOTTOM=$(( PANEL_BOTTOM - ROW_H ))
ROWS_H=$(( ROWS_BOTTOM - ROWS_TOP ))
if [ "${ROWS_H}" -lt "$(( 8 * ROW_H ))" ]; then
	abandon_take "the-pane-has-rows-to-read" \
		"the panel leaves ${ROWS_H}px for the file's rows, under the eight rows of ${ROW_H}px this scene reads"
fi

gutter_band() { use_crop "${PANEL_LEFT}" "${ROWS_TOP}" "${GUTTER_W}" "${ROWS_H}"; }
code_band() {
	use_crop "$(( PANEL_LEFT + GUTTER_W ))" "${ROWS_TOP}" \
		"$(( PANEL_RIGHT - PANEL_LEFT - GUTTER_W ))" "${ROWS_H}"
}

# A band of mono text this size inks thousands of pixels, and two settled frames
# of one state measure a couple of hundred apart on the software rasteriser.
MOVED_PIXELS=2000
STILL_PIXELS=200

# The pointer sits over the code rather than over the numbers, since the gesture
# belongs to the region under it: a wheel over the pinned column is the file's
# vertical scroll and not the code's horizontal one.
CODE_X=$(( PANEL_LEFT + GUTTER_W + (PANEL_RIGHT - PANEL_LEFT - GUTTER_W) / 2 ))
CODE_Y=$(( ROWS_TOP + ROWS_H / 2 ))

# Buttons 6 and 7 are the horizontal wheel: the window's own input path reads
# them as a sideways gesture, which is what an operator's trackpad sends.
scroll_code_right() { key_repeat_button 7 "${1:-8}"; }

# ─── The Panel Opens On The File ─────────────────────────────────────────────
k "ctrl+backslash"
pause 1.2
mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
EMPTY_PANE="${SCENE_RUNTIME_DIR}/frame-compare/pane-empty.png"
probe_frame "${EMPTY_PANE}"

# The lookup is how an operator reaches a file by name, and it names the one
# file this scene wrote rather than depending on which row of a tree the
# workspace happens to list first.
type_prompt "/files" 100
k "Return"
pause 1.0
t "${FILE_NAME%.rs}"
pause 2.5
k "Return"
pause 2.0
shot pane-at-rest

# The pane drew the file at all, before anything is measured about how it moves:
# the rows are inked where the tab opened on "No file open", and both columns
# report it, so a pane that drew numbers beside empty text fails here.
OPENED_CODE="$(frames_differ_pixels_at "${EMPTY_PANE}" \
	"${SCENE_OUT}/${SCENE_NAME}-pane-at-rest.png" \
	"$(( PANEL_RIGHT - PANEL_LEFT - GUTTER_W ))x${ROWS_H}+$(( PANEL_LEFT + GUTTER_W ))+${ROWS_TOP}")"
OPENED_GUTTER="$(frames_differ_pixels_at "${EMPTY_PANE}" \
	"${SCENE_OUT}/${SCENE_NAME}-pane-at-rest.png" \
	"${GUTTER_W}x${ROWS_H}+${PANEL_LEFT}+${ROWS_TOP}")"
if [ "${OPENED_CODE}" -lt "${MOVED_PIXELS}" ] || [ "${OPENED_GUTTER}" -lt "${STILL_PIXELS}" ]; then
	abandon_take "the-lookup-opened-the-file" \
		"the pane inked ${OPENED_CODE} pixels of code and ${OPENED_GUTTER} of line numbers when the row was taken, so the File tab is not holding the file this scene wrote"
fi

# ─── The Code Moves Sideways ─────────────────────────────────────────────────
move_px "${CODE_X}" "${CODE_Y}"
pause 0.4
scroll_code_right 10
pause 1.2
shot pane-scrolled

code_band
CODE_MOVED="$(shots_differ_pixels pane-at-rest pane-scrolled)"
gutter_band
NUMBERS_MOVED="$(shots_differ_pixels pane-at-rest pane-scrolled)"
ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	# Either the gesture reached nothing, or it moved the whole pane. Both are
	# the state the pinned gutter does not exist in; what this arm must not
	# show is the code moving on its own.
	if [ "${CODE_MOVED}" -ge "${MOVED_PIXELS}" ] && [ "${NUMBERS_MOVED}" -le "${STILL_PIXELS}" ]; then
		abandon_take "the-code-did-not-move-alone" \
			"a sideways wheel moved ${CODE_MOVED} pixels of code and left the numbers at ${NUMBERS_MOVED}, so this arm is not the state the long lines were unreachable in"
	fi
else
	if [ "${CODE_MOVED}" -lt "${MOVED_PIXELS}" ]; then
		abandon_take "the-long-lines-are-reachable" \
			"a sideways wheel over the code changed ${CODE_MOVED} pixels, under the ${MOVED_PIXELS} a moved column of mono text inks, so the rest of the line cannot be reached"
	fi
	if [ "${NUMBERS_MOVED}" -gt "${STILL_PIXELS}" ]; then
		abandon_take "the-numbers-stayed-where-they-were" \
			"the gutter changed ${NUMBERS_MOVED} pixels while the code scrolled, over the ${STILL_PIXELS} two settled frames measure apart, so the line numbers scrolled away with the text"
	fi
fi

# ─── The Wheel Still Belongs To The Axis It Was Made On ──────────────────────
# The same pointer, a vertical wheel: both columns move, because the file
# scrolls under both. An arm where this fails has mapped one gesture onto the
# other axis, which is the defect that would have slid the code sideways on
# every scroll down the file.
wheel_down 4
pause 1.2
shot pane-scrolled-down

gutter_band
NUMBERS_SCROLLED="$(shots_differ_pixels pane-scrolled pane-scrolled-down)"
if [ "${NUMBERS_SCROLLED}" -lt "${MOVED_PIXELS}" ]; then
	abandon_take "the-file-scrolls-under-both-columns" \
		"a vertical wheel over the code changed ${NUMBERS_SCROLLED} pixels of gutter, under the ${MOVED_PIXELS} moved line numbers ink, so the vertical gesture did not reach the file"
fi

echo "scene: ${ARM} arm -- a sideways wheel moved ${CODE_MOVED} pixels of code against" \
	"${NUMBERS_MOVED} of gutter, and a vertical wheel moved ${NUMBERS_SCROLLED} of gutter" >&2
