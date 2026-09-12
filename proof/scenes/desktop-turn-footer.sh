#!/usr/bin/env bash
# Drive a real turn in the native GPUI window, reveal the footer that names the
# model, and open the accounting it leads to.
#
# Records visual evidence for:
#   1. turn-footer-hidden    (the settled turn, nothing on it)
#   2. turn-footer-keyboard  (the same turn with the keyboard's cursor on it)
#   3. turn-footer-hover     (the same name under the pointer, cursor moved off)
#   4. turn-usage-open       (the right panel's usage tab, opened by the name)
#
# Frames 1 and 2 are the differential: the footer is a reveal, so a single frame
# of the turn proves nothing about it. Frame 3 is the other hand — the name is
# legible to a keyboard and to a pointer, and it is compared inside the name's
# own box so a reveal elsewhere cannot stand in for it. Frame 4 is what the name
# is for: `EntryMeta.usage` reached no surface at all before this, and the footer
# is the only route to it.
#
# The turn has to be a REAL one. Nothing here fabricates a transcript, and the
# model name in the footer is whatever the host reported for the turn it
# answered.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-turn-footer.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Comparing Two Frames ────────────────────────────────────────────────────
# The session list prints each session's age, so two frames a second apart
# differ in the sidebar whatever the transcript does. Every comparison crops the
# sidebar off first. RAIL_W and TITLEBAR_H come from the token files through
# the preamble this scene sources, so the rectangle follows the shed at
# whatever width the take is recorded at.
use_crop \
	$(( WIN_X + RAIL_W )) \
	$(( WIN_Y + TITLEBAR_H )) \
	$(( WIN_W - RAIL_W )) \
	$(( WIN_H - TITLEBAR_H ))

# A footer is one 12px line of a model's name: a few hundred ink pixels, far
# below the per-mille floor the card scenes use, so this scene counts pixels.
# Two settled frames of one state measured 26 differing pixels out of 694,848
# on this renderer, which is its own noise.
REVEAL_MIN_PIXELS=150
NOISE_MAX_PIXELS=60

# The same count inside one box of the frame, in screen coordinates. A reveal
# somewhere else in the column cannot pass for the one being measured.
box_differing_pixels() { # <shot-a> <shot-b> <w> <h> <x> <y>
	frames_differ_pixels_at \
		"${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		"${SCENE_OUT}/${SCENE_NAME}-$2.png" \
		"$3x$4+$5+$6"
}

# Where two frames differ, in screen coordinates. The reveal is what turned the
# name on, so its own box is the bounding box of the change — which is how it is
# clicked without guessing at a row height or counting prose lines.
changed_box() { # <shot-a> <shot-b> -> "<w> <h> <x> <y>" in screen pixels
	local scratch="${TMPDIR}/frame-compare"
	local crop="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}" geometry
	mkdir -p "${scratch}"
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" -crop "${crop}" +repage "${scratch}/box-a.png"
	magick "${SCENE_OUT}/${SCENE_NAME}-$2.png" -crop "${crop}" +repage "${scratch}/box-b.png"
	# An absolute difference of the two crops is black wherever they agree, so
	# the trim bounding box of what is left is the changed region's own extent.
	# `compare`'s own difference image cannot be used for this: it draws the
	# unchanged pixels as a faded copy of the frame rather than as ground, and
	# trimming that returns most of the window.
	geometry="$(magick "${scratch}/box-a.png" "${scratch}/box-b.png" \
		-compose difference -composite -colorspace Gray -threshold 4% \
		-format '%@' info: 2>/dev/null || true)"
	case "${geometry}" in
		*x*+*+*) ;;
		*)
			abandon_take "change-located" \
				"the difference between $1 and $2 reported no bounding box ('${geometry}')"
			;;
	esac
	local w h x y
	w="${geometry%%x*}"
	geometry="${geometry#*x}"
	h="${geometry%%+*}"
	geometry="${geometry#*+}"
	x="${geometry%%+*}"
	y="${geometry##*+}"
	printf '%s %s %s %s' "${w}" "${h}" "$(( CROP_X + x ))" "$(( CROP_Y + y ))"
}

# ─── A Real Turn ─────────────────────────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
submit_prompt "answer in one short sentence: what does a compiler do?"

if ! native_session_ready finished 2; then
	abandon_take "native-turn-recorded" "the submitted turn did not complete within 90s"
fi
pause 1.0

# ─── The Footer Reveals For Both Hands ───────────────────────────────────────
# The transcript owns the turn cursor's chords, so the pointer establishes that
# scope first, on empty column above the turns where a click lands on nothing.
# It is then parked on the composer: anywhere over the turn already reveals what
# the first frame is supposed to be without.
move_px "$(( CROP_X + CROP_W / 2 ))" "$(( CROP_Y + CROP_H / 3 ))"
click
pause 0.4
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.6
shot turn-footer-hidden

# The cursor clamps to the last turn, so stepping down past the end lands on it
# however many turns the run produced.
for _ in 1 2 3 4 5 6 7 8; do
	k "ctrl+Down"
done
pause 0.8
shot turn-footer-keyboard

REVEALED="$(shots_differ_pixels turn-footer-hidden turn-footer-keyboard)"
if [ "${REVEALED}" -lt "${REVEAL_MIN_PIXELS}" ]; then
	abandon_take "footer-revealed-for-the-keyboard" \
		"the turn cursor on the last turn changed ${REVEALED} pixels, under the \
${REVEAL_MIN_PIXELS} a model's name inks, so the footer this scene photographs did not appear"
fi

# The name is where the reveal changed the frame, which is how it is found
# without guessing at a row height or counting the prose lines the model wrote.
read -r NAME_W NAME_H NAME_X NAME_Y <<<"$(changed_box turn-footer-hidden turn-footer-keyboard)"

# ─── The Same Name Under The Pointer ─────────────────────────────────────────
# The cursor goes back to the first turn, so what the next frame reveals is the
# pointer's doing and not the keyboard's. The comparison is inside the name's own
# box: a reveal elsewhere in the column cannot pass for this one.
for _ in 1 2 3 4 5 6 7 8; do
	k "ctrl+Up"
done
pause 0.6
move_px "$(( NAME_X + NAME_W / 2 ))" "$(( NAME_Y + NAME_H / 2 ))"
pause 0.8
shot turn-footer-hover

HOVERED="$(box_differing_pixels turn-footer-hidden turn-footer-hover \
	"${NAME_W}" "${NAME_H}" "${NAME_X}" "${NAME_Y}")"
if [ "${HOVERED}" -lt "${REVEAL_MIN_PIXELS}" ]; then
	abandon_take "footer-revealed-on-hover" \
		"the pointer over the model name changed ${HOVERED} pixels inside the name's own box, \
under the ${REVEAL_MIN_PIXELS} it inks, so the hover reveal did not happen"
fi

# ─── The Name Opens The Accounting ───────────────────────────────────────────
# Clicking its centre is the operator's gesture; the panel column is what has to
# answer it.
click
pause 1.2
shot turn-usage-open

OPENED="$(shots_differ_pixels turn-footer-hover turn-usage-open)"
if [ "${OPENED}" -le "$(( NOISE_MAX_PIXELS * 20 ))" ]; then
	abandon_take "usage-tab-opened" \
		"clicking the model name changed ${OPENED} pixels, which is nearer this renderer's noise \
than a panel opening, so the accounting the name leads to did not reach the screen"
fi
