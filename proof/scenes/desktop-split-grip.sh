#!/usr/bin/env bash
# Point at the split above a docked terminal drawer in a native GPUI window and
# photograph the edge it draws, at rest and under the pointer.
#
# Records visual evidence for:
#   1. split-grip-rest     (the docked split with the pointer away from it)
#   2. split-grip-hovered  (the pointer inside the grip, on the line it takes)
#   3. split-grip-left     (the pointer away again)
#
# WHAT IS MEASURED. `panels.chrome.resize_handle_hit_px` authors the hit area a
# resize grip has and `resize_handle_line_px` the line inside it, so the scene
# reads both from the token files this checkout ships and finds the split's own
# row in the frame rather than predicting it: the drawer's chrome row is a
# known height, so the pair of lines that height apart is the split's edge and
# the chrome's lower border. Against that row the scene asserts that the band
# above the drawer carries one line and not two, that the middle of the chrome
# row is bare, and that a pointer inside the grip changes that line and
# nothing else in the band.
#
# THE PAIR. The differential is the same band in a build made before the split
# was one edge: the handle drew its line inside the grip AND the docked drawer
# bordered itself, so two hairlines sat a grip's half-height apart; an 8x1 dash
# with no listener sat in the middle of the tab row, which was the only reader
# the hit-area token had; and the line never changed under the pointer, so the
# one place an 8px target could show itself showed nothing.
#
# NOT RECORDED HERE: that the grip's hit rect measures exactly the authored
# extent and that a drag inside it moves the edge by the travel, which
# `crates/veyyon-desktop-surface/tests/a-split-is-taken-only-inside-the-grip-its-tokens-author.rs`
# asserts on both splits out of the frame's own boxes; and the spring the split
# settles with on release (§7.1), which the motion suite drives.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it at a width that docks the
# drawer. A pointer move and a one-pixel tint are most of what the take
# contains, so it is a still take and states its own motion floor:
#
#   SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
#     proof/scenes/desktop-split-grip.sh
#
# and its other arm, whose executable is a build of this tree with the one
# edge, the tint and the dash's removal taken back out of it. The holdback
# build writes through the workspace's own target directory, so the after
# executable is rebuilt before that arm is recorded:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/split-grip.patch split-grip
#   SANTH_BUILD_GOVERNED=1 cargo build -p veyyon-desktop
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/split-grip/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-split-grip.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Placement This Scene Is About ───────────────────────────────────────
# A width that overlays the drawer has no split to point at: the drawer draws
# its own edge there, which is the other half of the class and is asserted out
# of the frame's boxes rather than photographed.
if [ "${DRAWER_PLACEMENT}" != "row" ]; then
	abandon_take "the-drawer-docks" \
		"a ${WIN_W}x${WIN_H} window places the drawer '${DRAWER_PLACEMENT}', so there is no split above it"
fi

read -r GRIP CHROME_H LINE_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

panels = tomllib.loads((Path(sys.argv[1]) / "surface" / "panels.toml").read_text())
print(
    int(panels["chrome"]["resize_handle_hit_px"]),
    int(panels["chrome"]["row_height_px"]),
    int(panels["chrome"]["resize_handle_line_px"]),
)
PY
)

# The drawer spans the session column, which is the window past the rail. The
# panel is closed at rest, so the column's own middle is the drawer's middle,
# which is where the dash was drawn and where the line is read.
DRAWER_X="$(( WIN_X + RAIL_W ))"
DRAWER_W="$(( WIN_W - RAIL_W ))"
MID_X="$(( DRAWER_X + DRAWER_W / 2 ))"
# The second column a line has to be lit in, taken between the session
# column's leading edge and the transcript column inside it: what the
# transcript and the composer card draw is confined to that inner column, so a
# separator or a card border is lit at the middle and not here, and only a line
# across the drawer is lit at both.
LEFT_X="$(( DRAWER_X + (TRANSCRIPT_COLUMN_LEFT - DRAWER_X) / 2 ))"
if [ "$(( LEFT_X - DRAWER_X ))" -lt 16 ]; then
	abandon_take "the-drawer-has-two-columns-to-read" \
		"the transcript column starts ${TRANSCRIPT_COLUMN_LEFT}px in, leaving no strip of the session column outside it"
fi

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# ─── Reading The Split's Own Row Out Of The Frame ────────────────────────────
# A scene that arithmetics its way to the edge from a drawer height reads a
# resized drawer as a moved line. The frame says where it is. A line is a row
# drawn lighter than the rows around it in TWO columns of the drawer -- which
# a glyph in a mono cell is, in one column, and a separator or a card border
# inside the transcript's own column is, in the middle one only -- and the
# split's edge is the upper member of a pair of such lines a chrome row apart
# with no line between them: the edge itself and the border under the tab
# strip. The ground each row is judged against is the rows near it rather than
# the whole column, since a column of this window crosses a transcript and a
# drawer whose grounds differ and a median over both is neither.
#
# The before arm draws its border under the handle's line, which puts the
# chrome row one line lower, so both separations are accepted and it is the
# band above the edge that distinguishes the arms.
#
# One reader answers every question the scene asks of a frame, so a line and a
# mark mean the same thing in each.
measure_lines() { # <png> edge|band|ink <a> <b> <c> <d> -> "<row> <over> <pairs>" | <count>
	python3 - "$@" "${LEFT_X}" "${MID_X}" "${WIN_Y}" "${WIN_H}" "${CHROME_H}" "${LINE_PX}" "${GRIP}" <<-'PY'
		import re
		import statistics
		import subprocess
		import sys

		png, mode = sys.argv[1], sys.argv[2]
		box_x, box_y, box_w, box_h, left_x, mid_x, win_y, win_h, chrome, line, grip = (
		    int(value) for value in sys.argv[3:]
		)

		# The rows either side a line is judged against, and the levels over
		# that ground it is drawn at. A hairline over a canvas is some thirty
		# levels of eight-bit gray in either theme, and a rendered frame of
		# flat fills carries no noise under that.
		NEAR, CUT = 12, 6

		def levels(x, y, width, height):
		    dump = subprocess.run(
		        ["magick", png, "-crop", f"{width}x{height}+{x}+{y}", "+repage",
		         "-colorspace", "Gray", "-depth", "8", "txt:-"],
		        capture_output=True, text=True, check=True,
		    ).stdout
		    read = [int(found.group(1)) for found in re.finditer(r"^\d+,\d+:\s*\((\d+)", dump, re.M)]
		    if len(read) < width * height:
		        raise SystemExit(f"the {width}x{height} box at {x},{y} dumped {len(read)} pixels")
		    return read

		if mode == "ink":
		    box = levels(box_x, box_y, box_w, box_h)
		    ground = statistics.median(box)
		    print(sum(1 for level in box if level - ground >= CUT))
		    raise SystemExit(0)

		def lit(x):
		    """The rows of one column drawn lighter than the rows around them."""
		    column = levels(x, win_y, 1, win_h)
		    return {
		        row
		        for row in range(NEAR, win_h - NEAR)
		        if column[row] - statistics.median(column[row - NEAR : row + NEAR + 1]) >= CUT
		    }, column

		left_lit, _ = lit(left_x)
		mid_lit, mid_levels = lit(mid_x)
		across = left_lit & mid_lit

		if mode == "band":
		    first = box_x - win_y
		    print(sum(1 for row in across if first <= row < first + box_y))
		    raise SystemExit(0)

		# A pair a chrome row apart with no line between them, below the
		# window's upper third, which is the drawer's chrome and nothing else.
		#
		# The separation is a range, not the chrome row: the handle draws its
		# line centred in the band it takes, so the drawer's own top sits half
		# a grip below the line and its chrome's lower border a chrome row
		# below that. The before arm draws that border itself and its pair is
		# the chrome row exactly, so both readings are the same pair of the
		# same two things and the arms are distinguished by the band above the
		# upper line rather than by how far apart they are.
		floor = win_h // 3
		pairs = sorted(
		    row
		    for row in across
		    for apart in range(chrome, chrome + grip + line + 1)
		    if row > floor
		    and row + apart in across
		    and not any(between in across for between in range(row + 1, row + apart))
		)
		if not pairs:
		    raise SystemExit(
		        f"no line pair {chrome}-{chrome + grip + line}px apart below row {floor}; "
		        f"lines across at {sorted(across)}"
		    )
		edge = pairs[-1]
		over = mid_levels[edge] - statistics.median(mid_levels[edge + 1 : edge + 1 + NEAR])
		print(win_y + edge, round(over), len(pairs))
	PY
}

# ─── 1. Open The Drawer And Photograph The Split At Rest ─────────────────────
# The pointer stays on the composer editor the preamble left it on, which is
# nowhere near the split, so the resting frame carries no hover state.
AT_REST="${PROBE_DIR}/split-grip-before-drawer.png"
probe_frame "${AT_REST}"
k "ctrl+j"
pause 2
transcript_region
OPENED="$(screen_differs_from_frame_per_mille "${AT_REST}")"
if [ "${OPENED}" -lt 40 ]; then
	abandon_take "the-drawer-answered-its-chord" \
		"the session surface changed ${OPENED}/1000 on primary-j, so no drawer docked into a split"
fi
REST="${PROBE_DIR}/split-grip-rest.png"
probe_frame "${REST}"
shot split-grip-rest

read -r EDGE_ROW EDGE_OVER EDGE_PAIRS <<<"$(measure_lines "${REST}" edge 0 0 0 0)"
if [ -z "${EDGE_PAIRS:-}" ]; then
	abandon_take "the-split-is-found" "could not read the split's row out of the resting frame"
fi
echo "scene: the split's edge is root row ${EDGE_ROW}, ${EDGE_OVER} levels over the ground under it (${EDGE_PAIRS} candidate pair(s))" >&2

# ─── 2. The Band Above The Drawer Carries One Line ───────────────────────────
# The grip is the band the pointer catches, and one edge is drawn in it. Two
# lines in that band is the split drawn twice: the handle's, and a border the
# drawer kept for the placement that has no handle.
BAND_TOP="$(( EDGE_ROW - GRIP - LINE_PX ))"
BAND_ROWS="$(( GRIP + 2 * LINE_PX ))"
LINES="$(measure_lines "${REST}" band "${BAND_TOP}" "${BAND_ROWS}" 0 0)"

# ─── 3. The Middle Of The Chrome Row Is Bare ─────────────────────────────────
# The dash was an 8x1 mark centred in whatever the tab strip and the controls
# left of the row, so a scene that aimed at the row's own centre would miss it
# by the difference between the two. The middle third of the drawer is where
# it fell at every width: past the tabs, short of the controls, and bare
# between them, so any pixel there drawn over the row's own ground is a mark
# nothing else accounts for.
DASH_Y="$(( EDGE_ROW + 2 * LINE_PX ))"
DASH_H="$(( CHROME_H - 4 * LINE_PX ))"
DASH_W="$(( DRAWER_W / 3 ))"
DASH_X="$(( DRAWER_X + DRAWER_W / 3 ))"
DASH="$(measure_lines "${REST}" ink "${DASH_X}" "${DASH_Y}" "${DASH_W}" "${DASH_H}")"

# ─── 4. The Line Answers The Pointer, And The Band Around It Does Not ────────
# The tint is the whole of what an 8px target has to show for itself, and it is
# the line's own pixels: a band that repainted around it would be a hover
# ground on the drawer, which is a different surface making the claim.
#
# The aim is beside the line and not on it. The line is centred in the band it
# is drawn in, so a row two above it is inside the band under either rounding
# of that centring, and a grip whose hit area is the line alone tints nothing
# from there.
EDGE_CROP="${DRAWER_W}x${BAND_ROWS}+${DRAWER_X}+${BAND_TOP}"
CHROME_CROP="${DRAWER_W}x$(( CHROME_H - 2 * LINE_PX ))+${DRAWER_X}+$(( EDGE_ROW + LINE_PX ))"
move_px "${MID_X}" "$(( EDGE_ROW - 2 * LINE_PX ))"
pause 1.0
TINTED="$(screen_differs_from_frame_pixels_at "${REST}" "${EDGE_CROP}")"
CHROME_MOVED="$(screen_differs_from_frame_pixels_at "${REST}" "${CHROME_CROP}")"
shot split-grip-hovered

# A line across the drawer, not a few pixels of one: the tint is the whole
# width of the split it is drawn on.
TINT_MIN="$(( DRAWER_W / 3 ))"
# What a frame taken a second later differs by with nothing pointing at it.
STILL_MAX=40
# The dash was 8x1, so a mark of it is a handful of pixels rather than a band;
# a bare row draws none at all, and the two are told apart at half of one.
DASH_MIN="$(( GRIP / 2 ))"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${LINES}" -lt 2 ]; then
		abandon_take "the-before-arm-draws-two-edges" \
			"the ${BAND_ROWS}px band above the drawer draws ${LINES} line(s), so this build already draws one edge"
	fi
	if [ "${DASH}" -lt "${DASH_MIN}" ]; then
		abandon_take "the-before-arm-draws-the-dash" \
			"the middle of the chrome row draws ${DASH}px over its own ground, under the ${DASH_MIN}px an 8x1 mark draws, so this build paints no dash"
	fi
	if [ "${TINTED}" -ge "${TINT_MIN}" ]; then
		abandon_take "the-before-arm-does-not-tint" \
			"the pointer inside the grip changed ${TINTED}px of the band, so this build already tints the line"
	fi
	echo "scene: before arm -- ${LINES} lines above the drawer, ${DASH}px of dash in the tab row, ${TINTED}px under the pointer" >&2
	exit 0
fi

if [ "${LINES}" -ne 1 ]; then
	abandon_take "the-split-is-one-edge" \
		"the ${BAND_ROWS}px band above the docked drawer draws ${LINES} line(s) at ${MID_X}px, not the one the handle carries"
fi
if [ "${DASH}" -ge "${DASH_MIN}" ]; then
	abandon_take "the-chrome-row-is-bare" \
		"the middle of the chrome row draws ${DASH}px over its own ground, so a mark is painted where the dash was"
fi
if [ "${TINTED}" -lt "${TINT_MIN}" ]; then
	abandon_take "the-line-answers-the-pointer" \
		"the pointer inside the grip changed ${TINTED}px of the band, under the ${TINT_MIN}px a tinted line across a ${DRAWER_W}px drawer draws"
fi
if [ "${CHROME_MOVED}" -gt "${STILL_MAX}" ]; then
	abandon_take "the-tint-is-the-line" \
		"the chrome row under the split changed ${CHROME_MOVED}px while the pointer was in the grip, so the hover painted more than the line"
fi

# ─── 5. The Pointer Leaves And The Line Is The Hairline Again ────────────────
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.0
LEFT="$(screen_differs_from_frame_pixels_at "${REST}" "${EDGE_CROP}")"
shot split-grip-left
if [ "${LEFT}" -gt "${STILL_MAX}" ]; then
	abandon_take "the-tint-is-only-under-the-pointer" \
		"the band above the drawer differs from its resting frame by ${LEFT}px with the pointer back on the composer"
fi

echo "scene: one line above the drawer, ${DASH}px of ink where the dash was, ${TINTED}px tinted under the pointer and ${LEFT}px left behind" >&2
