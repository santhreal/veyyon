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
# and its other arm, against a build of the base ref. The change is entirely
# inside that executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<base-build> \
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
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

COMPOSER_X=$(( WIN_X + 400 ))
COMPOSER_Y=$(( WIN_Y + (WIN_H > 481 ? 408 : WIN_H - 98) ))
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.3
t "count from one to forty, one number per line, with no other words"
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
