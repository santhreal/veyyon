#!/usr/bin/env bash
# Run a real turn in the native GPUI window and photograph the queue row while
# it runs and after it ends.
#
# Records visual evidence for:
#   1. queue-badge-turn-running  (the row of the session whose turn is running)
#   2. queue-badge-turn-finished (the same row once the reply has landed)
#
# The two frames are the differential. `Session::badge` was written by no code
# path, so the before arm draws a bare row in both frames: a running turn is
# invisible in the queue. The after arm derives the badge from the stream the
# host is sending, so frame 1 carries a `Working` chip and frame 2 carries none,
# the open session's badge being cleared when it is read.
#
# WHAT IS MEASURED. The chip fills with the `working` tint (`[tint.working]`),
# which nothing else in the window paints, so each frame is reduced to its count
# of pixels of that fill inside the queue crop, and the arms are judged on how
# that count moves. A frame difference alone cannot separate the chip from the
# row's own elapsed time, which ticks between any two frames.
#
# The turn has to be a REAL one: nothing here fabricates a session index, a
# stream or a status.
#
# NOT RECORDED HERE: the six badges that need a decision, a deferral or a
# supervised process. Those states are asserted at the value level by
# `crates/veyyon-desktop-model/tests/every-row-badge-comes-from-the-state-the-host-reported.rs`,
# which sweeps every variant and its precedence, and photographed as scenes by
# `veyyon-desktop scene render queue-badge/<state>`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-queue-badge.sh
#
# and its other arm, whose executable is a build of this tree with the badge
# derivation taken back out of it. A build of the pre-change tree cannot record
# this take: it speaks the protocol of its own day, and the host sends a
# `QueuedPrompts` section on the first frame of a turn, which that executable
# rejects -- `FrameDecoder` reports a fatal protocol error, the socket closes,
# the host disposes the client, and the turn the scene just submitted ends
# `Aborted` over an empty transcript. Holding the change out of the current
# tree keeps the protocol current and leaves the derivation as the whole
# differential:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<build of this tree without the derivation> \
#     proof/docker/record-native.sh proof/scenes/desktop-queue-badge.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Fill The Working Chip Paints ────────────────────────────────────────
# Read from the theme this checkout ships rather than restated as a literal, so
# a retheme cannot make the scene silently stop finding the chip.
THEME_FILE="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"
WORKING_FILL="$(sed -n '/^\[tint.working\]/,/^\[/ s/^fill = "\(#[0-9a-fA-F]\{6\}\)".*/\1/p' \
	"${THEME_FILE}" | head -1)"
if [ -z "${WORKING_FILL}" ]; then
	abandon_take "working-tint-known" "no [tint.working] fill in ${THEME_FILE}"
fi

# ─── Where The Queue Is ──────────────────────────────────────────────────────
# The queue is 256px wide beside the transcript, and collapses below it at the
# minimum width, where this scene has nothing to photograph.
if [ "${WIN_W}" -le 800 ]; then
	abandon_take "queue-beside-transcript" \
		"the queue is collapsed at ${WIN_W}px, so no row is on screen to photograph"
fi
CROP_X="${WIN_X}"
CROP_Y=$(( WIN_Y + 48 ))
CROP_W=256
CROP_H=$(( WIN_H - 48 ))

# The chip is a small pill: a 20px-tall fill a few dozen pixels wide, around a
# thousand pixels of tint. The floor is a fifth of that, above the handful a
# card's own selected fill contributes at this fuzz.
CHIP_MIN_FILL=200

working_fill_pixels() { # <shot> -> count of pixels of the working tint's fill
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" -crop "${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}" +repage \
		-fuzz 6% -fill white -opaque "${WORKING_FILL}" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "working-fill-countable" \
				"counting the working tint in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

# ─── A Real Turn, Long Enough To Photograph ──────────────────────────────────
PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The composer is a band at the foot of the window, which is where a click has to
# land: an arm whose build does not keep the editor focused through a click on
# another region types into nothing, submits an empty draft, and reads back a turn
# the provider aborted. That is what this scene recorded while the click was aimed
# at a point 408px down an 800px window.
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"

# Every readiness probe below is aimed with its own crop. This scene's own crop
# is the queue rail, 256px at the window's leading edge, and each of these
# states draws outside it: the model catalogue is anchored over the transcript,
# and the draft is in the composer. A probe left on the scene's crop reads 0 for
# all of them and abandons a take that was going fine, which is what this scene
# did six times.
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The row of composer controls, where the model chip carries the model's name.
CONTROL_ROW_CROP="${COMPOSER_CARD_W}x$(( CARD_PAD_BOTTOM + 2 * GUTTER_PX ))+${COMPOSER_CARD_LEFT}+$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - 2 * GUTTER_PX ))"

# The model is named rather than left at whatever the composer starts on: a build
# that reaches the machine's configured model only through the picker draws
# `Select model` until one is chosen, and a prompt submitted there is a turn with
# no model, which the provider ends as an abort.
#
# The picker is opened from its own chip rather than by the chord. A build whose
# editor and dismissed overlays do not carry the shell's key contexts answers no
# chord at all once a palette has been dismissed, which the shared prelude does
# before this scene starts: the keys then land in the composer and the return
# after them submits a model id as the prompt. A click on a control reaches it in
# every build that draws it.
#
# The chip's point is derived from the tokens by the shared prelude, and the
# pointer settles there before the press: a hit test resolves against the frame
# the window last drew, so a press dispatched in the same breath as the move is
# tested where the pointer was.
PICKER_MIN_PIXELS=20000
PICKER_CLOSED="${PROBE_DIR}/badge-picker-closed.png"
probe_frame "${PICKER_CLOSED}"
move_px "${MODEL_CHIP_X}" "${MODEL_CHIP_Y}"
pause 0.3
click
pause 0.8
PICKER="$(screen_differs_from_frame_pixels_at "${PICKER_CLOSED}" "${WINDOW_CROP}")"
if [ "${PICKER}" -lt "${PICKER_MIN_PIXELS}" ]; then
	abandon_take "model-picker-open" \
		"a press on the model chip at ${MODEL_CHIP_X},${MODEL_CHIP_Y} changed ${PICKER} pixels of \
the window, under the ${PICKER_MIN_PIXELS} an overlay of model rows draws, so the keys after it \
would land in the composer"
fi
PICKER_OPEN="${PROBE_DIR}/badge-picker-open.png"
probe_frame "${PICKER_OPEN}"
t "local/qwen2.5-1.5b"
pause 0.6
FILTERED="$(screen_differs_from_frame_pixels_at "${PICKER_OPEN}" "${WINDOW_CROP}")"
if [ "${FILTERED}" -lt 1000 ]; then
	abandon_take "model-picker-filtered" \
		"typing a model id changed ${FILTERED} pixels of the window, so the overlay's field never \
took it and the return would select whatever row was under the cursor"
fi
k "Return"
pause 0.8

# The pointer goes back where it rested for the frame this is compared against,
# since the chip's own hover tint inks more than its name does.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.5
MODEL_CHOSEN="${PROBE_DIR}/badge-model-chosen.png"
probe_frame "${MODEL_CHOSEN}"
CHOSEN="$(frames_differ_pixels_at "${PICKER_CLOSED}" "${MODEL_CHOSEN}" "${CONTROL_ROW_CROP}")"
if [ "${CHOSEN}" -lt 100 ]; then
	abandon_take "model-chosen" \
		"the composer's control row is ${CHOSEN} pixels from where it was before the picker, \
under the 100 a model's name inks, so no model was chosen and the turn would run without one"
fi

click
k "ctrl+a"
k "BackSpace"
pause 0.3

EMPTY_FIELD="${PROBE_DIR}/badge-empty-field.png"
probe_frame "${EMPTY_FIELD}"
t "count from one to forty, one number per line, with no other words"
pause 0.8
# A line of prose in the field inks a couple of thousand pixels.
TYPED="$(screen_differs_from_frame_pixels_at "${EMPTY_FIELD}" "${WINDOW_CROP}")"
if [ "${TYPED}" -lt 1000 ]; then
	abandon_take "prompt-typed" \
		"typing the prompt changed ${TYPED} pixels of the window, so the field never took it \
and pressing return would submit an empty draft"
fi
k "Return"

# The pointer is parked on the composer for both frames: a pointer over a queue
# row reveals that row's hover actions, which would move the crop on its own.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# ─── The Row While The Turn Runs ─────────────────────────────────────────────
# Photographed while the host is still streaming, which is the state the badge
# is derived from. The wait is short and the reply is long, so the stream is
# still open.
pause 2.5
shot queue-badge-turn-running
RUNNING="$(working_fill_pixels queue-badge-turn-running)"

# ─── The Row Once The Reply Has Landed ───────────────────────────────────────
if ! native_session_ready finished 2; then
	abandon_take "native-turn-recorded" "the submitted turn did not complete within 90s"
fi
pause 1.5
shot queue-badge-turn-finished
FINISHED="$(working_fill_pixels queue-badge-turn-finished)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${RUNNING}" -ge "${CHIP_MIN_FILL}" ]; then
		abandon_take "queue-badge-turn-running" \
			"the baseline drew a working chip: ${RUNNING} pixels of tint, at or over ${CHIP_MIN_FILL}"
	fi
	echo "scene: before arm -- working tint ${RUNNING} -> ${FINISHED}, a running turn drew a bare row" >&2
else
	if [ "${RUNNING}" -lt "${CHIP_MIN_FILL}" ]; then
		abandon_take "queue-badge-turn-running" \
			"a running turn drew no working chip: ${RUNNING} pixels of tint, under ${CHIP_MIN_FILL}"
	fi
	if [ "${FINISHED}" -ge "${CHIP_MIN_FILL}" ]; then
		abandon_take "queue-badge-turn-finished" \
			"the chip outlived the turn: ${FINISHED} pixels of tint still filled after it ended"
	fi
	echo "scene: after arm -- working tint ${RUNNING} -> ${FINISHED}, a chip while it ran and none after" >&2
fi
