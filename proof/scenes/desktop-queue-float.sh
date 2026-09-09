#!/usr/bin/env bash
# Reach the session queue in a native GPUI window too narrow to dock it, and
# photograph what the rail draws when it is reached that way.
#
# Records visual evidence for:
#   1. queue-float-closed  (the collapsed width with no rail on screen)
#   2. queue-float-open    (the rail floated at the leading edge)
#   3. queue-float-closed-again (the surface Escape left the window on)
#
# WHAT IS MEASURED. The collapsed breakpoint row declares a queue measure and
# the `overlay` mode, so the rail is drawn on request as a left sheet spanning
# the area below the titlebar, and takes no width out of the columns row. Every
# number below is read from the token files this checkout ships. The scene
# asserts that the rail control draws a sheet's worth of ink into the leading
# strip, that the sheet's inked box reaches the declared measure and starts on
# the window's own leading edge, that the sheet spans the row rather than the
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

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

strip_ink_box() { # <shot> -> WxH+X+Y of the inked bounding box in the rail strip
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local box
	box="$(magick "${png}" -crop "${STRIP_CROP}" +repage \
		-fuzz 5% -trim -format '%@' info: 2>/dev/null || true)"
	if [ -z "${box}" ]; then
		abandon_take "strip-trimmed" "no inked pixels found in the rail strip for $1"
	fi
	echo "${box}"
}

# ─── 1. Empty The Composer And Photograph The Closed Width ───────────────────
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
shot queue-float-closed

CLOSED="${PROBE_DIR}/queue-float-closed.png"
probe_frame "${CLOSED}"

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
	k "Escape"
	pause 1.0
	shot queue-float-closed-again
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
BOX="$(strip_ink_box queue-float-open)"
IFS='x+' read -r INK_W INK_H INK_X INK_Y <<<"${BOX}"
if [ -z "${INK_W:-}" ]; then
	abandon_take "strip-measured" "could not read the rail strip ink box (got '${BOX}')"
fi
# Flush to the window's leading edge: the sheet's own frame is the only inset,
# so ink starts inside it and no later than one frame in.
if [ "${INK_X}" -gt "${SHEET_PX}" ]; then
	abandon_take "sheet-is-flush" \
		"the sheet's ink starts ${INK_X}px in, past the ${SHEET_PX}px frame a left sheet draws"
fi
# The declared measure is the sheet's outer width, so its ink ends inside it
# and no earlier than the rail's body: a sheet drawn at the rail's measure plus
# its own frame overruns this, and one drawn at half of it falls short.
INK_RIGHT=$(( INK_X + INK_W ))
if [ "${INK_RIGHT}" -gt "${QUEUE_W}" ] || [ "${INK_RIGHT}" -lt $(( QUEUE_W - 3 * SHEET_PX )) ]; then
	abandon_take "sheet-takes-its-measure" \
		"the sheet's ink ends at ${INK_RIGHT}px against a declared ${QUEUE_W}px measure"
fi
echo "scene: the float inked ${INK_W}x${INK_H} at +${INK_X}+${INK_Y} inside a declared ${QUEUE_W}px measure" >&2

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
