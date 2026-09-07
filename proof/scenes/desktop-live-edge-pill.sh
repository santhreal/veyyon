#!/usr/bin/env bash
# Step the turn cursor back through a transcript that fits its viewport, in the
# native GPUI window, and photograph what the bottom of the column offers.
#
# Records visual evidence for:
#   1. live-edge-cursor-on-last-turn  (the cursor on the last turn, at the edge)
#   2. live-edge-cursor-stepped-back  (the same transcript, following stopped)
#
# The two frames are the differential, and the arms differ in frame 2 alone. The
# pill was drawn from tail following alone, which the turn cursor stops: on this
# transcript, whose last row is already on screen, the before arm raises a
# "Scroll to end" button over the prose and the jump it offers moves nothing.
# The after arm draws it only while the last row is off screen, so frame 2
# carries the footer reveal and no button.
#
# WHAT IS MEASURED. The button fills with the theme's accent, which nothing else
# in the transcript column paints, so each frame is reduced to its count of
# accent pixels and the arms are judged on how that count moves. A frame
# difference alone cannot separate the button from the footer the same keystroke
# reveals.
#
# The turn has to be a REAL one: nothing here fabricates a transcript, and the
# transcript is short because the model is asked for one sentence.
#
# NOT RECORDED HERE: the pill on a transcript that does overflow its viewport,
# where the jump is the whole point. That case is asserted at the byte level by
# `crates/veyyon-desktop-surface/tests/the-jump-to-the-live-edge-appears-only-when-the-edge-is-off-screen.rs`,
# which sweeps both shapes and both ways of leaving the edge.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-live-edge-pill.sh
#
# and its other arm, against a build of the base ref, with:
#
#   SCENE_ARM=before PROOF_NATIVE_BEFORE_BINARY=<base-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-live-edge-pill.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Accent The Button Fills With ────────────────────────────────────────
# Read from the theme this checkout ships rather than restated as a literal, so
# a retheme cannot make the scene silently stop finding the button.
THEME_FILE="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"
ACCENT="$(sed -n 's/^accent = "\(#[0-9a-fA-F]\{6\}\)".*/\1/p' "${THEME_FILE}" | head -1)"
if [ -z "${ACCENT}" ]; then
	abandon_take "accent-known" "no accent colour in ${THEME_FILE}"
fi

# ─── Where The Column Is ─────────────────────────────────────────────────────
# The session list prints each session's age, so two frames a second apart
# differ in the sidebar whatever the transcript does, and the sidebar carries
# accent of its own on the selected card. Every measurement crops it off.
CROP_X=$(( WIN_X + (WIN_W > 800 ? 256 : 0) ))
CROP_Y=$(( WIN_Y + 48 ))
CROP_W=$(( WIN_W - (WIN_W > 800 ? 256 : 0) ))
CROP_H=$(( WIN_H - 48 ))

# The button is a small control: a 28px-tall pill a couple of hundred pixels
# wide, several thousand accent pixels once its label is punched out. The floor
# is a fifth of that, well above the handful of accent pixels a focus ring or a
# caret contributes.
PILL_MIN_ACCENT=800
ACCENT_NOISE=200
# One 12px line of a model's name. Two settled frames of one state measured 26
# differing pixels on this renderer, which is its own noise.
REVEAL_MIN_PIXELS=60

accent_pixels() { # <shot> -> count of accent-filled pixels in the column
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" -crop "${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}" +repage \
		-fuzz 8% -fill white -opaque "${ACCENT}" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "accent-countable" \
				"counting accent in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

differing_pixels() { # <shot-a> <shot-b>
	local scratch="${SCENE_RUNTIME_DIR}/frame-compare"
	mkdir -p "${scratch}"
	local crop="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}" differing
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" -crop "${crop}" +repage "${scratch}/a.png"
	magick "${SCENE_OUT}/${SCENE_NAME}-$2.png" -crop "${crop}" +repage "${scratch}/b.png"
	# `compare` exits non-zero whenever the two images differ at all, which is
	# the ordinary case here, so only the count it prints is read.
	differing="$(compare -metric AE "${scratch}/a.png" "${scratch}/b.png" null: 2>&1 || true)"
	case "${differing}" in
		'' | *[!0-9]*)
			abandon_take "frames-comparable" \
				"comparing $1 with $2 reported '${differing}' instead of a pixel count"
			;;
	esac
	printf '%s' "${differing}"
}

# ─── A Real Turn, Short Enough To Fit ────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + (WIN_H > 481 ? 408 : WIN_H - 98) ))
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.3
t "answer in one short sentence: what does a linker do?"
k "Return"

if ! native_session_ready finished 2; then
	abandon_take "native-turn-recorded" "the submitted turn did not complete within 90s"
fi
pause 1.0

# ─── The Cursor On The Last Turn ─────────────────────────────────────────────
# The transcript owns the turn cursor's chords, so the pointer establishes that
# scope first, on empty column above the turns where a click lands on nothing.
# It is then parked on the composer, since a pointer left over the transcript
# reveals a footer of its own and both frames must hold one hover state.
move_px "$(( CROP_X + CROP_W / 2 ))" "$(( CROP_Y + CROP_H / 3 ))"
click
pause 0.4
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.4

# The cursor clamps to the last turn, so stepping down past the end lands on it
# however many turns the run produced. The last turn is the live edge: stepping
# onto it keeps the tail followed.
for _ in 1 2 3 4 5 6 7 8; do
	k "ctrl+Down"
done
pause 0.8
shot live-edge-cursor-on-last-turn

# ─── One Step Back Off The Edge ──────────────────────────────────────────────
# This is the gesture that raised the button: the cursor leaves the last turn,
# which stops tail following, while the last row stays on screen.
k "ctrl+Up"
pause 0.8
shot live-edge-cursor-stepped-back

AT_EDGE="$(accent_pixels live-edge-cursor-on-last-turn)"
STEPPED="$(accent_pixels live-edge-cursor-stepped-back)"
MOVED="$(differing_pixels live-edge-cursor-on-last-turn live-edge-cursor-stepped-back)"

# Both arms have to show the keystroke landing, or the pair says nothing about
# what the button does. The cursor carries the footer that names the turn's
# model with it, which is what changes the frame in either arm.
if [ "${MOVED}" -lt "${REVEAL_MIN_PIXELS}" ]; then
	abandon_take "live-edge-cursor-stepped-back" \
		"stepping the turn cursor off the last turn changed ${MOVED} pixels, under ${REVEAL_MIN_PIXELS}: the chord did not land"
fi

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "$(( STEPPED - AT_EDGE ))" -lt "${PILL_MIN_ACCENT}" ]; then
		abandon_take "live-edge-cursor-stepped-back" \
			"the baseline drew no jump button: accent went ${AT_EDGE} -> ${STEPPED}, under ${PILL_MIN_ACCENT} added"
	fi
	echo "scene: before arm -- accent ${AT_EDGE} -> ${STEPPED}, a jump offered over a visible last row" >&2
else
	if [ "$(( STEPPED > AT_EDGE ? STEPPED - AT_EDGE : AT_EDGE - STEPPED ))" -gt "${ACCENT_NOISE}" ]; then
		abandon_take "live-edge-cursor-stepped-back" \
			"a jump button appeared on a transcript that fits its viewport: accent went ${AT_EDGE} -> ${STEPPED}"
	fi
	echo "scene: after arm -- accent ${AT_EDGE} -> ${STEPPED}, no jump offered, ${MOVED} pixels of footer" >&2
fi
