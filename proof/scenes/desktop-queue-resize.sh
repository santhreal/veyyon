#!/usr/bin/env bash
# Drag the handle on the queue rail's trailing edge in a native GPUI window and
# photograph the width the rail is left at.
#
# Records visual evidence for:
#   1. queue-resize-rest     (the rail at the width its breakpoint row states)
#   2. queue-resize-widened  (the rail after a drag of the handle)
#   3. queue-resize-clamped  (the rail after a drag past what the tokens allow)
#
# WHAT IS MEASURED. `surface/queue.toml` states the rail's minimum, the delta
# its maximum leaves of the viewport, the floor under that maximum and the hit
# square of the handle at its trailing edge, and the breakpoint row states the
# width it opens at. Every number below is read from the token files this
# checkout ships. The scene measures the rail's own ground out of each frame
# rather than trusting the drag: the rail opens at the width the row states,
# a drag of the handle leaves it at the travel, and a drag past the ceiling
# leaves it at the ceiling and not past it.
#
# THE PAIR. The differential is the second frame: an executable whose rail has
# no handle answers the same gesture with nothing, so the rail is the width its
# row states before the drag and after it, and every session past the rail's
# measure stays behind an ellipsis at every window size.
#
# NOT RECORDED HERE: that the grip is taken only inside the hit square the
# tokens author, and that a width outside the bounds is refused rather than
# drawn, which
# `crates/veyyon-desktop-surface/tests/a-drag-of-the-rail-handle-resizes-the-queue.rs`
# asserts out of the frame's own boxes; and that the width survives a restart,
# which `crates/veyyon-desktop/tests/a-remembered-queue-width-is-read-back-inside-its-bounds.rs`
# drives through the store.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it at a width that docks the rail.
# Three still frames with the pointer parked between them are most of what the
# take contains, so it declares its own motion floor:
#
#   SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh \
#     proof/scenes/desktop-queue-resize.sh
#
# and its other arm, whose executable is a build of this tree with the handle
# taken back out of it:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/queue-resize.patch queue-resize
#   SANTH_BUILD_GOVERNED=1 cargo build -p veyyon-desktop
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/queue-resize/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-queue-resize.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Placement This Scene Is About ───────────────────────────────────────
# A floated rail is drawn over the session surface and takes no width out of
# the columns row, so there is no edge between two regions for the handle to
# move. That placement is the queue-float scene.
if [ "${QUEUE_MODE}" != "inline" ]; then
	abandon_take "queue-is-docked" \
		"the ${WIN_W}px row places the queue ${QUEUE_MODE}, so no handle sits between two regions"
fi
if [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-has-a-measure" "the docked rail takes no width out of the columns row"
fi

read -r HIT_PX MIN_PX MAX_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}" "${WIN_W}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

width = float(sys.argv[2])
geometry = token_px.load("surface/queue.toml")["geometry"]["width"]
minimum = token_px.px(geometry["min_px"])
# The ceiling is the viewport less the delta the file states, floored so a
# narrow window still offers a rail wider than nothing, and never under the
# minimum. The renderer resolves it the same way out of the same three keys.
ceiling = max(
    width - token_px.px(geometry["max_viewport_delta_px"]),
    token_px.px(geometry["floor_max_px"]),
    minimum,
)
print(int(token_px.px(geometry["resize_handle_hit_px"])), int(minimum), int(ceiling))
PY
)
if [ -z "${MAX_PX:-}" ]; then
	abandon_take "bounds-are-known" "could not read the rail's bounds from surface/queue.toml"
fi
if [ "${MAX_PX}" -le "${RAIL_W}" ]; then
	abandon_take "the-rail-can-widen" \
		"the ${WIN_W}px window allows ${MAX_PX}px, which the ${RAIL_W}px rail already reaches"
fi
echo "scene: the rail opens at ${RAIL_W}px between ${MIN_PX}px and ${MAX_PX}px," \
	"with a ${HIT_PX}px handle at its trailing edge" >&2

# ─── Where The Rail Is Read, And Where It Is Taken ───────────────────────────
# The strip is the widest the rail may become plus a margin, so a rail dragged
# past its ceiling is measured rather than cropped at it.
STRIP_X="${WIN_X}"
STRIP_Y=$(( WIN_Y + TITLEBAR_H ))
STRIP_W=$(( MAX_PX + 4 * SHEET_PX ))
if [ "${STRIP_W}" -ge "${WIN_W}" ]; then
	STRIP_W="${WIN_W}"
fi
# Above the composer's band: the card is drawn inside the session column and
# its ground is neither the rail's nor the transcript's, so a strip that
# reached it would read the card's leading edge as the rail's trailing one.
STRIP_H=$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))
MEASURE_CROP="${STRIP_W}x${STRIP_H}+${STRIP_X}+${STRIP_Y}"

# The row the handle is taken on: half way down the strip, clear of the rail's
# section headers at the top and its footer at the foot.
GRIP_Y=$(( STRIP_Y + STRIP_H / 2 ))
# The grip is drawn inside the rail's own measure, at its trailing edge, so
# the hit square is the last of the rail's columns and its middle is half a
# square short of the edge. A press on the edge itself lands on the first
# column of the surface beside the rail, which is a press on the transcript.
GRIP_X=$(( WIN_X + RAIL_W - HIT_PX / 2 ))
# A travel wide enough that no rounding of the drag accounts for it, and short
# enough to stay well inside the ceiling.
TRAVEL=120
# What the measured width may differ from the width asked for: the rail's own
# frame and the handle drawn over its edge are inside the run this reads, and
# the pointer lands on a pixel rather than on a float.
SLACK=$(( 2 * HIT_PX ))

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The column the rail's ground ends in, measured rather than trimmed to.
#
# A bounding box answers the widest thing in the strip, and the transcript
# inside the margin is ink too. The rail is a solid column of ground from the
# titlebar down, and the session surface beside it is a darker ground carrying
# lines of text, so each column's average over the strip separates them by an
# order of magnitude. The cut is half the median of the columns the rail
# certainly owns -- the ones inside its minimum -- so it is read off the frame
# rather than written here, and a theme with a lighter or darker rail moves it
# with the frame.
rail_width() { # <shot> -> the width of the lit run at the window's leading edge
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	python3 - "${png}" "${MEASURE_CROP}" "${STRIP_W}" "${MIN_PX}" <<-'PY'
		import re
		import statistics
		import subprocess
		import sys

		png, crop, strip_w, floor = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
		dump = subprocess.run(
		    ["magick", png, "-crop", crop, "+repage", "-colorspace", "Gray",
		     "-scale", f"{strip_w}x1!", "txt:-"],
		    capture_output=True, text=True, check=True,
		).stdout
		levels = [int(found.group(1)) for found in re.finditer(r"^\d+,0:\s*\((\d+)", dump, re.M)]
		if len(levels) < floor:
		    raise SystemExit(f"the strip averaged {len(levels)} columns, under the {floor}px the rail must cover")
		cut = statistics.median(levels[: floor // 2]) / 2.0
		if cut <= 0:
		    raise SystemExit("the rail's own columns are unlit, so no cut separates it from the session surface")
		run = 0
		while run < len(levels) and levels[run] > cut:
		    run += 1
		if run == 0:
		    raise SystemExit("no lit column at the window's leading edge, so no rail was drawn there")
		print(run)
	PY
}

# ─── 1. Empty The Composer And Photograph The Rail At Rest ───────────────────
# The prelude leaves a draft in the composer and the pointer on the editor.
# Clearing it keeps the composer's own band out of every comparison below.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.3
click
pause 0.3
k "End"
for _ in $(seq 1 80); do
	k "BackSpace"
done
pause 0.8
shot queue-resize-rest

REST_W="$(rail_width queue-resize-rest)" || REST_W=""
if [ -z "${REST_W:-}" ]; then
	abandon_take "rail-measured" "could not read the rail's ground out of the resting frame"
fi
if [ "${REST_W}" -gt $(( RAIL_W + SLACK )) ] || [ "${REST_W}" -lt $(( RAIL_W - SLACK )) ]; then
	abandon_take "rail-opens-at-its-row" \
		"the rail measured ${REST_W}px where its breakpoint row states ${RAIL_W}px"
fi

# ─── 2. Drag The Handle And Read The Width It Left ───────────────────────────
WIDE_X=$(( GRIP_X + TRAVEL ))
drag_px "${GRIP_X}" "${GRIP_Y}" "${WIDE_X}" "${GRIP_Y}"
# The split settles on a spring after the release (§7.1), so the frame is taken
# once it has arrived rather than during the travel.
pause 1.2
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
shot queue-resize-widened

WIDE_W="$(rail_width queue-resize-widened)" || WIDE_W=""
if [ -z "${WIDE_W:-}" ]; then
	abandon_take "widened-measured" "could not read the rail's ground out of the dragged frame"
fi

# ─── 3. Drag Past The Ceiling And Read Where It Stopped ──────────────────────
# The ask is a rail wider than the tokens allow, so the frame answers with the
# ceiling. A renderer that took the ask draws a rail this wide and a session
# surface narrower than the composer's own minimum.
OVER_X=$(( WIN_X + MAX_PX + 3 * TRAVEL ))
if [ "${OVER_X}" -ge $(( WIN_X + WIN_W )) ]; then
	OVER_X=$(( WIN_X + WIN_W - 2 ))
fi
drag_px "$(( GRIP_X + WIDE_W - REST_W ))" "${GRIP_Y}" "${OVER_X}" "${GRIP_Y}"
pause 1.2
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
shot queue-resize-clamped

CLAMPED_W="$(rail_width queue-resize-clamped)" || CLAMPED_W=""
if [ -z "${CLAMPED_W:-}" ]; then
	abandon_take "clamped-measured" "could not read the rail's ground out of the clamped frame"
fi

# ─── What Each Arm Claims ────────────────────────────────────────────────────
if [ "${SCENE_ARM:-after}" = "before" ]; then
	# The claim of this arm is that the gesture reaches nothing: both frames
	# hold the width the breakpoint row states.
	if [ "${WIDE_W}" -gt $(( RAIL_W + SLACK )) ]; then
		abandon_take "before-arm-has-no-handle" \
			"the before executable widened the rail to ${WIDE_W}px, so it is not the arm without the handle"
	fi
	echo "scene: the before arm answered the drag with a ${WIDE_W}px rail," \
		"the ${RAIL_W}px it opened at" >&2
	return 0 2>/dev/null || exit 0
fi

# The travel rather than the width: the grip is drawn inside the rail's own
# measure and whether its columns read as the rail's ground or as the surface
# beside it is the theme's business, so the claim is what the drag MOVED,
# which that column cancels out of.
MOVED=$(( WIDE_W - REST_W ))
if [ "${MOVED}" -gt $(( TRAVEL + SLACK )) ] || [ "${MOVED}" -lt $(( TRAVEL - SLACK )) ]; then
	abandon_take "the-drag-moves-the-edge" \
		"a ${TRAVEL}px drag moved the rail's edge by ${MOVED}px, from ${REST_W}px to ${WIDE_W}px"
fi
if [ "${CLAMPED_W}" -gt $(( MAX_PX + SLACK )) ]; then
	abandon_take "the-ceiling-holds" \
		"a drag past the ceiling left a ${CLAMPED_W}px rail over the ${MAX_PX}px the tokens allow"
fi
if [ "${CLAMPED_W}" -lt $(( MAX_PX - SLACK )) ]; then
	abandon_take "the-ceiling-is-reached" \
		"a drag past the ceiling stopped at ${CLAMPED_W}px, short of the ${MAX_PX}px the tokens allow"
fi

echo "scene: the rail opened at ${REST_W}px, a ${TRAVEL}px drag left ${WIDE_W}px," \
	"and a drag past the ceiling stopped at ${CLAMPED_W}px of an allowed ${MAX_PX}px" >&2
