#!/usr/bin/env bash
# Reach the session queue in a native GPUI window too narrow to dock it, and
# photograph what the rail draws when it is reached that way.
#
# Records visual evidence for:
#   1. queue-float-closed  (the collapsed width with no rail on screen)
#   2. queue-float-open    (the rail floated at the leading edge)
#   3. queue-float-closed-again (the surface Escape left the window on)
#
# The before arm records the second of those alone: with no floated placement
# to draw, the frames on either side of the press are the same pixels.
#
# WHAT IS MEASURED. The collapsed breakpoint row declares a queue measure and
# the `overlay` mode, so the rail is drawn on request as a left sheet spanning
# the area below the titlebar, and takes no width out of the columns row. Every
# number below is read from the token files this checkout ships. The scene
# asserts that the rail control draws a sheet's worth of ink into the leading
# strip, that the sheet's own ground measures the declared width and starts on
# the window's leading edge, that the sheet spans the row rather than the
# transcript inside it -- a rail that stopped above the composer would clip the
# footer holding its one gear -- and that Escape returns the window to the
# frame it was photographed in.
#
# THE PAIR. The differential is the strip: an executable whose collapsed row
# declares no measure sheds the rail outright, the control moves nothing, and
# the strip is identical across the press. That arm is the state every window
# under 980px was stuck in, with every session but the open one unreachable
# from it.
#
# NOT RECORDED HERE: that the float takes no width from any region, which
# `crates/veyyon-desktop-surface/tests/a-narrow-window-never-sheds-the-surface-being-read.rs`
# asserts across the whole width sweep; and that the footer gear inside the
# float is reachable and dismissal leaves no control behind, which
# `crates/veyyon-desktop-surface/tests/the-rail-footer-gear-is-reachable-at-every-width-that-draws-a-rail.rs`
# drives in both placements.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it at the collapsed width with:
#
#   SCENE_WIDTH=800 proof/docker/record-native.sh proof/scenes/desktop-queue-float.sh
#
# and its other arm, whose executable is a build of this tree with the floated
# placement taken back out of it:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/queue-float.patch queue-float
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_WIDTH=800 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/queue-float/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-queue-float.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Width This Scene Is About ───────────────────────────────────────────
# A width that docks the rail proves nothing here: the control would move a
# column, which is the placement the other scenes photograph.
if [ "${QUEUE_MODE}" != "overlay" ]; then
	abandon_take "queue-floats" \
		"a ${WIN_W}px window docks the queue (${QUEUE_MODE}); record this scene at the collapsed width"
fi
if [ "${RAIL_W}" -ne 0 ]; then
	abandon_take "queue-takes-no-width" \
		"a floated queue must take no width out of the columns row, got ${RAIL_W}px"
fi
if [ "${QUEUE_W}" -le 0 ]; then
	abandon_take "queue-has-a-measure" "the collapsed row declares no queue measure"
fi

# ─── Where The Sheet Lands ───────────────────────────────────────────────────
# A left sheet is flush to the window's leading edge and frames its body with
# one spacing step and a hairline, so the rail's own 208px sit inside an outer
# box of that measure: the strip read below is the whole sheet plus a margin
# wide enough to catch a sheet drawn too wide.
STRIP_X="${WIN_X}"
STRIP_Y=$(( WIN_Y + TITLEBAR_H ))
STRIP_W=$(( QUEUE_W + 4 * SHEET_PX ))
STRIP_H=$(( WIN_H - TITLEBAR_H ))
if [ "${STRIP_W}" -ge "${WIN_W}" ]; then
	abandon_take "strip-fits" "the rail strip (${STRIP_W}px) is not narrower than the window"
fi
STRIP_CROP="${STRIP_W}x${STRIP_H}+${STRIP_X}+${STRIP_Y}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The band at the window's foot the composer and the run bar occupy. The float
# spans the row, so the sheet's own ink reaches into this band: that is what
# separates a rail carrying its footer from one clipped above the composer.
BAND_CROP="${QUEUE_W}x${COMPOSER_BAND_H}+${WIN_X}+$(( WIN_Y + WIN_H - COMPOSER_BAND_H ))"

# The strip above that band, which is where the sheet's own measure is read.
# The strip is wider than the rail so a sheet drawn too wide is caught, and at
# the window's foot that extra width reaches over the composer card, whose own
# ink is no evidence about the rail: measuring the whole strip read the card's
# leading edge as the sheet's trailing one and answered 243px for a 208px
# sheet. What the sheet does inside the band is the BAND_CROP comparison
# above, which is a differential rather than a measure.
MEASURE_CROP="${STRIP_W}x$(( STRIP_H - COMPOSER_BAND_H ))+${STRIP_X}+${STRIP_Y}"

# A sheet's worth of ink, not a hairline: the rail draws section headers and
# cards across its whole measure.
FLOAT_MIN_PIXELS=4000
# The sheet's ground and its footer inside the composer's own band.
BAND_MIN_PIXELS=1500
RETURN_MAX_PIXELS=400
# A closed float leaves the strip holding whatever the session column draws
# through it, so the closed frame is judged against the press rather than
# against zero.
CLOSED_MAX_PIXELS=200

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The column the sheet's ground ends in, measured rather than trimmed to.
#
# A bounding box cannot answer this: the strip is wider than the rail so an
# oversized sheet is caught, and every pixel of transcript inside that margin
# is ink too, so a trim reports the widest thing in the strip and not the
# sheet. The sheet is a solid column of ground from the titlebar to the foot,
# and the transcript beside it is a dark ground carrying a line of text, so
# each column's average over the strip separates them by an order of
# magnitude. The cut is half the median of the columns the sheet certainly
# owns -- the ones inside the rail's own body -- so it is read off the frame
# rather than written here, and a theme with a lighter or darker float moves
# it with the frame.
sheet_ground_columns() { # <shot> -> "<first-column> <last-column>" of the run
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	python3 - "${png}" "${MEASURE_CROP}" "${STRIP_W}" "${QUEUE_W}" <<-'PY'
		import re
		import statistics
		import subprocess
		import sys

		png, crop, strip_w, measure = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
		dump = subprocess.run(
		    ["magick", png, "-crop", crop, "+repage", "-colorspace", "Gray",
		     "-scale", f"{strip_w}x1!", "txt:-"],
		    capture_output=True, text=True, check=True,
		).stdout
		levels = [int(found.group(1)) for found in re.finditer(r"^\d+,0:\s*\((\d+)", dump, re.M)]
		if len(levels) < measure:
		    raise SystemExit(f"the strip averaged {len(levels)} columns, under the {measure}px it must cover")
		cut = statistics.median(levels[: measure // 2]) / 2.0
		if cut <= 0:
		    raise SystemExit("the sheet's own columns are unlit, so no cut separates it from the transcript")
		run = 0
		while run < len(levels) and levels[run] > cut:
		    run += 1
		if run == 0:
		    raise SystemExit("no lit column at the window's leading edge, so no sheet was drawn there")
		print(0, run - 1)
	PY
}

# ─── 1. Empty The Composer And Read The Closed Width ─────────────────────────
# The prelude leaves a draft in the composer and the pointer on the editor.
# Clearing it is what makes the band comparison below about the float rather
# than about a caret blinking in a draft.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.3
click
pause 0.3
k "End"
for _ in $(seq 1 80); do
	k "BackSpace"
done
pause 0.8

CLOSED="${PROBE_DIR}/queue-float-closed.png"
probe_frame "${CLOSED}"
# The closed width is a published frame in the after arm only. The before arm
# draws nothing for the control to change, so its frame after the press is the
# frame before it, and `shot` rejects a still identical to the one before it --
# rightly, since everywhere else that means a key landed too early. The arm
# publishes the pressed frame alone and states the press moved nothing, which
# is the claim, rather than the same pixels under two names.
if [ "${SCENE_ARM:-after}" != "before" ]; then
	shot queue-float-closed
fi

# ─── 2. Press The Rail Control And Photograph What It Drew ───────────────────
# The chord rather than the titlebar glyph: the control's own box is a token
# measure this scene would have to restate, and the chord reaches the same
# handler. The pointer stays on the editor, so the sheet is photographed with
# no row under a hover ground.
k "ctrl+b"
pause 1.0
OPENED="$(screen_differs_from_frame_pixels_at "${CLOSED}" "${STRIP_CROP}")"
BAND_MOVED="$(screen_differs_from_frame_pixels_at "${CLOSED}" "${BAND_CROP}")"
shot queue-float-open

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${OPENED}" -ge "${CLOSED_MAX_PIXELS}" ]; then
		abandon_take "queue-float-before" \
			"the baseline drew ${OPENED}px into the rail strip; it has no floated placement to draw"
	fi
	echo "scene: before arm -- the rail control moved ${OPENED}px in the strip and ${BAND_MOVED}px in the band" >&2
	exit 0
fi

if [ "${OPENED}" -lt "${FLOAT_MIN_PIXELS}" ]; then
	abandon_take "queue-float-drawn" \
		"the rail control drew ${OPENED}px into the strip, under the ${FLOAT_MIN_PIXELS}px a rail's worth of rows takes"
fi
if [ "${BAND_MOVED}" -lt "${BAND_MIN_PIXELS}" ]; then
	abandon_take "float-spans-the-row" \
		"the float moved only ${BAND_MOVED}px inside the composer's own band; a sheet that stops above the composer clips the footer holding its gear"
fi

# ─── 3. The Sheet Reaches The Measure The Tokens Author ──────────────────────
RUN="$(sheet_ground_columns queue-float-open)" || RUN=""
read -r GROUND_FIRST GROUND_LAST <<<"${RUN}"
if [ -z "${GROUND_LAST:-}" ]; then
	abandon_take "sheet-measured" "could not read the sheet's ground columns (got '${RUN}')"
fi
# Flush to the window's leading edge: a left sheet draws its own frame inside
# its box and nothing outside it, so the first lit column is the window's.
if [ "${GROUND_FIRST}" -ne 0 ]; then
	abandon_take "sheet-is-flush" \
		"the sheet's ground starts at column ${GROUND_FIRST}, not on the window's leading edge"
fi
# The declared measure is the sheet's outer width, so its ground ends inside
# it and no earlier than the rail's body: a sheet drawn at the measure plus its
# own frame overruns this, and one drawn at half of it falls short.
SHEET_WIDTH=$(( GROUND_LAST + 1 ))
if [ "${SHEET_WIDTH}" -gt "${QUEUE_W}" ] || [ "${SHEET_WIDTH}" -lt $(( QUEUE_W - 3 * SHEET_PX )) ]; then
	abandon_take "sheet-takes-its-measure" \
		"the sheet's ground measures ${SHEET_WIDTH}px against a declared ${QUEUE_W}px measure"
fi
echo "scene: the float drew a ${SHEET_WIDTH}px sheet inside a declared ${QUEUE_W}px measure" >&2

# ─── 4. Escape Returns The Window To The Frame It Was Photographed In ────────
# The float is the last rung of the dismiss ladder, below every overlay in
# `state.overlay`, and there is none open here (§5.8).
k "Escape"
pause 1.0
RETURNED="$(screen_differs_from_frame_pixels_at "${CLOSED}" "${WINDOW_CROP}")"
shot queue-float-closed-again
if [ "${RETURNED}" -gt "${RETURN_MAX_PIXELS}" ]; then
	abandon_take "queue-float-dismissed" \
		"Escape left ${RETURNED}px of the window changed; the float did not close"
fi
echo "scene: the rail control drew ${OPENED}px into the strip, reached ${BAND_MOVED}px of the composer's band, and Escape returned to rest (${RETURNED}px differ)" >&2
