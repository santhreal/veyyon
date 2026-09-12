#!/usr/bin/env bash
# Open a file whose lines are wider than the panel and reach the far end of one
# of them, in the native GPUI window.
#
# Records visual evidence for:
#   1. pane-at-rest    (the file drawn in the File tab, at the head of its lines)
#   2. pane-scrolled   (the same rows after a sideways wheel over the code)
#   3. pane-lines-down (the same pane after a vertical wheel over the code)
#
# Frames 1 and 2 are the differential, and the claim is what happens to each of
# the pane's two columns (§5.11): the code moves and the line numbers do not.
# One frame of a code view proves nothing, because a pane that clips its long
# lines and a pane that scrolls them draw the same first column of text.
#
# Frame 3 is the control, and it is asserted in both arms: a vertical wheel over
# the code moves the numbers with the lines. It states that the wheel reaches
# this build's pane at all, so the absence the before arm asserts is a gesture
# the pane declined rather than a gesture nothing received; and in the after arm
# it states the sideways gesture was restricted to the axis it was made on
# rather than being mapped onto the one axis a region scrolls.
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

# A file whose head is far wider than any panel this window sheds to, so the
# head of one of those lines is all a clipping pane can draw, and whose rows run
# well past the pane's lower edge, so a vertical wheel has somewhere to travel.
# A file short enough to fit the pane cannot scroll in either arm: the take that
# used 40 rows recorded a wheel that changed nothing, and
# `the-file-outruns-the-pane` below reads this count back against the box the
# pane was given rather than leaving it a number that agrees with one window
# size.
#
# ONLY THE HEAD IS WIDE, AND IT IS AS NARROW AS THE CLAIM ALLOWS. A before build
# lays out a cell for every line and a run for every span of every line, and it
# stops presenting frames once there are a few thousand of them: the take that
# gave it 20 rows of 900 characters -- some 250 syntect spans each -- photographed
# a window that drew the file once and then answered nothing, six wheel rounds
# and a panel-close chord changing not one pixel of the whole window. A
# differential needs both arms driveable, so the wide rows are eight of 188
# characters, which is over four times the width of the code column the pane
# gives them and inside what an unwindowed pane can carry, and the rows below
# them are one binding wide and carry the travel the vertical gesture needs.
FILE_NAME="wide-columns.rs"
FILE_WIDE_LINES=8
FILE_LINES=60
synthesize_wide_file() {
python3 - "${FILE_NAME}" "${FILE_LINES}" "${FILE_WIDE_LINES}" <<'PY'
from pathlib import Path
import sys

target = Path("/sandbox/home/demo/src") / sys.argv[1]
target.parent.mkdir(parents=True, exist_ok=True)
total, wide = int(sys.argv[2]), int(sys.argv[3])
lines = []
for number in range(1, total + 1):
    # Seven `let` bindings for a wide row, some 210 characters and a few dozen
    # syntect spans, so the row's own width is several times the column the pane
    # shows it in; one binding for the rows below them.
    steps = 7 if number <= wide else 1
    body = " ".join(f"let column_{number:03}_{step:03} = {step};" for step in range(steps))
    lines.append(f"pub fn row_{number:03}() {{ {body} }}")
target.write_text("\n".join(lines) + "\n")
print(
    f"synthesized wide file: {target} ({len(lines)} rows, "
    f"{wide} of them {max(len(l) for l in lines)} columns)"
)
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
# The file the scene wrote against the box the pane was given: a wheel can only
# travel where the rows outrun the box, and by more than the couple of rows a
# window a little taller would swallow.
if [ "$(( FILE_LINES * ROW_H ))" -lt "$(( ROWS_H + 8 * ROW_H ))" ]; then
	abandon_take "the-file-outruns-the-pane" \
		"the file's ${FILE_LINES} rows of ${ROW_H}px stand in a box ${ROWS_H}px tall, so it is within eight rows of fitting and a vertical wheel has nowhere to travel"
fi
# The wide rows are the head of the file, so they are the rows the box shows at
# rest and the ones a reader sees the code slide under. Every row of the pane
# travels with a sideways gesture, since one scroll region carries the column,
# so the band's reading does not depend on which rows are in it -- the count is
# here to make the frame legible, and `the-long-lines-are-reachable` below is
# what states the gesture arrived.
if [ "${FILE_WIDE_LINES}" -gt "${FILE_LINES}" ]; then
	abandon_take "the-wide-rows-are-in-the-file" \
		"the scene asks for ${FILE_WIDE_LINES} wide rows of a ${FILE_LINES}-row file"
fi

GUTTER_GEOM="${GUTTER_W}x${ROWS_H}+${PANEL_LEFT}+${ROWS_TOP}"
CODE_GEOM="$(( PANEL_RIGHT - PANEL_LEFT - GUTTER_W ))x${ROWS_H}+$(( PANEL_LEFT + GUTTER_W ))+${ROWS_TOP}"
gutter_band() { use_crop "${PANEL_LEFT}" "${ROWS_TOP}" "${GUTTER_W}" "${ROWS_H}"; }
code_band() {
	use_crop "$(( PANEL_LEFT + GUTTER_W ))" "${ROWS_TOP}" \
		"$(( PANEL_RIGHT - PANEL_LEFT - GUTTER_W ))" "${ROWS_H}"
}

# A band of mono text this size inks thousands of pixels, and two settled frames
# of one state measure a couple of hundred apart on the software rasteriser.
MOVED_PIXELS=2000
STILL_PIXELS=200

ARM="${SCENE_ARM:-after}"
# How long a round of the gesture is given to reach a frame. The two arms draw
# at different rates and the difference is one of the things the change did: the
# before arm builds a cell for every line and a run for every span of it, so a
# file of 120 lines of 760 columns costs it seconds per frame, and a round that
# probed after a second read a screen from before the wheel and reported the
# window unchanged. The after arm draws what its box shows and answers inside a
# second.
ROUND_SETTLE=0.9
if [ "${ARM}" = "before" ]; then
	ROUND_SETTLE=8
fi

# The pointer sits over the code rather than over the numbers, since the gesture
# belongs to the region under it: a wheel over the pinned column is the file's
# vertical scroll and not the code's horizontal one.
CODE_X=$(( PANEL_LEFT + GUTTER_W + (PANEL_RIGHT - PANEL_LEFT - GUTTER_W) / 2 ))
CODE_Y=$(( ROWS_TOP + ROWS_H / 2 ))

# A sideways gesture, sent the way this display can send one. The horizontal
# wheel is buttons 6 and 7, which the X server maps only for a pointer device
# that has them, and the private display's core pointer does not: a take that
# clicked button 7 moved nothing, because the fake press was never delivered.
# A wheel with shift held is the other sideways gesture the window's own input
# path reads, and it rides button 5, which every pointer here carries.
scroll_code_right() {
	xdotool keydown shift
	wheel_down "${1:-8}"
	xdotool keyup shift
}

# ─── The Panel Opens On The File ─────────────────────────────────────────────
k "ctrl+backslash"
pause 1.2
mkdir -p "${TMPDIR}/frame-compare"
EMPTY_PANE="${TMPDIR}/frame-compare/pane-empty.png"
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
# The pane's first frame of the file, which is the frame the before arm spends
# seconds on.
pause "${ROUND_SETTLE}"
shot pane-at-rest

# What the pane is holding, measured against the tab as it stood on "No file
# open": a band this size inks thousands of pixels of mono text, and a pane
# drawing nothing there measures nearly none. Read after every gesture, since a
# pane that scrolls its box and draws no rows inside it is the failure a
# windowed pane adds, and a frame of empty ground passes every claim about what
# moved.
code_ink() {
	frames_differ_pixels_at "${EMPTY_PANE}" "${SCENE_OUT}/${SCENE_NAME}-$1.png" "${CODE_GEOM}"
}
gutter_ink() {
	frames_differ_pixels_at "${EMPTY_PANE}" "${SCENE_OUT}/${SCENE_NAME}-$1.png" "${GUTTER_GEOM}"
}
# Sets INK_CODE and INK_GUTTER in this shell rather than answering on a pipe: a
# check that ran in a process substitution could abandon the take and the take
# would carry on around it.
drew_the_file() {
	INK_CODE="$(code_ink "$1")"
	INK_GUTTER="$(gutter_ink "$1")"
	if [ "${INK_CODE}" -lt "${MOVED_PIXELS}" ] || [ "${INK_GUTTER}" -lt "${STILL_PIXELS}" ]; then
		abandon_take "the-pane-draws-the-rows-inside-its-box" \
			"at ${1}, the pane inked ${INK_CODE} pixels of code and ${INK_GUTTER} of line numbers, so the File tab is not drawing rows inside the box it scrolled"
	fi
}

# The pane drew the file at all, before anything is measured about how it moves:
# the rows are inked where the tab opened on "No file open", and both columns
# report it, so a pane that drew numbers beside empty text fails here.
drew_the_file pane-at-rest
OPENED_CODE="${INK_CODE}"

# A gesture the pane answers, rather than one gesture and a guess about when it
# arrived. A wheel is clamped against the scroll extent the last frame laid
# out, so one that reaches the window before the file's own frame is clamped to
# an offset of zero and lost: two takes of this scene sent the same four
# notches at the same file and one of them moved nothing. Each round is one
# gesture at the pointer, and the rounds stop at the first frame where the band
# named moved, so a gesture the surface does not answer at all still ends and
# reports what it measured.
#
# `$1` is the band to watch, `$2` the frame to measure against, `$3` a name for
# the probe, and the rest the gesture to make. MOVED and MOVED_WINDOW are left
# in this shell, and the probe frame stays on disk under `$3` for a later read.
gesture_until_moved() {
	local geometry="$1" against="$2" name="$3"
	shift 3
	local round=0
	PROBED="${TMPDIR}/frame-compare/${name}.png"
	MOVED=0
	MOVED_WINDOW=0
	for round in 1 2 3 4 5 6; do
		"$@"
		pause "${ROUND_SETTLE}"
		probe_frame "${PROBED}"
		MOVED="$(frames_differ_pixels_at "${against}" "${PROBED}" "${geometry}")"
		# What the whole window did, beside what the band did: a gesture the
		# window never received changes neither, and a gesture it received and
		# answered somewhere else changes the window and not the band. The
		# take that read only the band could not tell those apart.
		MOVED_WINDOW="$(frames_differ_pixels_at "${against}" "${PROBED}" \
			"${WIN_W}x${WIN_H}+0+0")"
		echo "scene: ${name} round ${round}: band ${MOVED}px, window ${MOVED_WINDOW}px" >&2
		if [ "${MOVED}" -ge "${MOVED_PIXELS}" ]; then
			break
		fi
	done
}

# ─── The Code Moves Sideways, The Numbers Do Not ─────────────────────────────
# The sideways gesture first, over the wide rows the pane opened on: this is the
# differential, and it is made from the state the previous frame photographed
# rather than from somewhere the vertical gesture left the file.
move_px "${CODE_X}" "${CODE_Y}"
pause 0.4
gesture_until_moved "${CODE_GEOM}" "${SCENE_OUT}/${SCENE_NAME}-pane-at-rest.png" \
	code-across scroll_code_right 4
CODE_ACROSS="${MOVED}"
WINDOW_ACROSS="${MOVED_WINDOW}"

# WHAT EACH ARM SHOWS OF THAT ONE GESTURE. The after arm scrolls the code and
# leaves the numbers where they were, then scrolls the file under both columns,
# and each frame is measured against the frame before it. The before arm has no
# region to travel over and no axis restriction, so the same shift-wheel is
# taken as a vertical delta: the file scrolls, the numbers slide away with it,
# and the far end of the line the pane opened on is where it was. Both arms take
# the same shot of the same gesture, which is the pair.
PANE_ANSWERED=0
if [ "${CODE_ACROSS}" -ge "${MOVED_PIXELS}" ]; then
	PANE_ANSWERED=1
fi

CODE_MOVED=0
NUMBERS_MOVED=0
NUMBERS_SCROLLED=0
MOVED_CODE_INK=0
SCROLLED_CODE=0
if [ "${PANE_ANSWERED}" = "1" ]; then
	shot pane-scrolled
	drew_the_file pane-scrolled
	MOVED_CODE_INK="${INK_CODE}"
	code_band
	CODE_MOVED="$(shots_differ_pixels pane-at-rest pane-scrolled)"
	gutter_band
	NUMBERS_MOVED="$(shots_differ_pixels pane-at-rest pane-scrolled)"
fi

if [ "${ARM}" = "before" ]; then
	# The state the pinned gutter does not exist in: the gesture either reaches
	# nothing, or moves the numbers along with everything else. What this arm
	# must not show is the code travelling on its own, which is the change.
	if [ "${PANE_ANSWERED}" = "1" ] && [ "${NUMBERS_MOVED}" -le "${STILL_PIXELS}" ]; then
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

	# ─── The File Scrolls Under Both Columns ─────────────────────────────────
	# The axis claim: a vertical wheel over the same rows moves the numbers with
	# the lines, so the sideways gesture above was held to the axis it was made
	# on rather than being mapped onto the one axis this region scrolls -- a
	# region that took the delta would have scrolled the file already, which is
	# what the before arm photographs.
	gesture_until_moved "${GUTTER_GEOM}" "${SCENE_OUT}/${SCENE_NAME}-pane-scrolled.png" \
		rows-down wheel_down 2
	shot pane-lines-down
	drew_the_file pane-lines-down
	SCROLLED_CODE="${INK_CODE}"
	gutter_band
	NUMBERS_SCROLLED="$(shots_differ_pixels pane-scrolled pane-lines-down)"
	if [ "${NUMBERS_SCROLLED}" -lt "${MOVED_PIXELS}" ]; then
		abandon_take "the-file-scrolls-under-both-columns" \
			"a vertical wheel over the code changed ${NUMBERS_SCROLLED} pixels of gutter, under the ${MOVED_PIXELS} moved line numbers ink, so the wheel reached nothing"
	fi
fi

# ─── An Absence Is Read Beside A Control ─────────────────────────────────────
# A gesture that moved the window states its own arrival. A gesture that moved
# nothing states nothing until the window is known to have been answering while
# it was made, so that reading -- and only that reading -- is followed by an
# input whose answer is unmistakable: closing the panel puts the transcript
# where the file was. A build that had stopped presenting frames fails here
# instead of publishing an absence a reader would have to take on trust.
PANEL_CLOSED="not read"
if [ "${PANE_ANSWERED}" = "0" ]; then
	k "ctrl+backslash"
	pause "${ROUND_SETTLE}"
	PANEL_CLOSED="$(screen_differs_from_frame_pixels_at "${PROBED}" "${CODE_GEOM}")"
	if [ "${PANEL_CLOSED}" -lt "${MOVED_PIXELS}" ]; then
		abandon_take "the-window-was-answering" \
			"the sideways wheel moved ${CODE_ACROSS} pixels and closing the panel then moved ${PANEL_CLOSED}, under the ${MOVED_PIXELS} a panel's worth of mono text inks, so this window had stopped presenting frames and the readings above state nothing about the pane"
	fi
fi

echo "scene: ${ARM} arm -- a sideways wheel moved ${CODE_ACROSS} pixels of the code's band and" \
	"${WINDOW_ACROSS} of the window; the pane drew ${CODE_MOVED} against ${NUMBERS_MOVED} of" \
	"gutter, a vertical wheel then moved ${NUMBERS_SCROLLED} of gutter, and the panel-close" \
	"control read ${PANEL_CLOSED}; the pane held ${OPENED_CODE}, ${MOVED_CODE_INK} and" \
	"${SCROLLED_CODE} pixels of code at rest, scrolled across and scrolled down" >&2
