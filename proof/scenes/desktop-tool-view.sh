#!/usr/bin/env bash
# Drive a real tool call in the native GPUI window and disclose its card both
# ways: with the keyboard, and with the pointer.
#
# Records visual evidence for:
#   1. tool-card-collapsed        (one line, host-supplied view, turn focused)
#   2. tool-card-keyboard-open    (disclosed with `space` on the focused turn)
#   3. tool-card-keyboard-closed  (`space` again closes it)
#   4. tool-card-pointer-open     (disclosed by clicking the same card's row)
#
# Frames 2 and 4 are a pair: a tool card's disclosure is the host's, and the two
# gestures must open the same card. They came out different -- the keyboard
# expanded the block locally and never told the host, so its body held the
# collapsed view -- which is what this scene photographs.
#
# The block has to come from a REAL tool call, so the local model is asked, in
# the plainest sentence it will follow, to run a shell command. Nothing here
# fabricates a transcript.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh proof/scenes/desktop-tool-view.sh
#
# The floor is 5 rather than the 12 a moving surface carries: the take is a
# minute and a half, most of it a tool turn whose transcript stands still while
# the model reads the command's output, and the frames it publishes are stills.
# What judges this take is the readings below, not its frame rate.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Comparing Two Frames ────────────────────────────────────────────────────
# What this scene records is that both gestures open the same card and that
# closing returns it to the collapsed one. That is a statement about pixels, so
# it is asserted here rather than left to whoever opens the gallery. The
# counting is `lib.sh`'s; this scene states the rectangle and the thresholds.
#
# The sidebar is cropped off because the session list prints each session's age,
# so two frames a second apart differ there whatever the transcript does.
# RAIL_W and TITLEBAR_H come from the token files through the preamble this
# scene sources, so the rectangle follows the shed at whatever width the take
# is recorded at and a retuned titlebar moves it rather than leaving it
# reaching into the chrome above.
use_crop \
	$(( WIN_X + RAIL_W )) \
	$(( WIN_Y + TITLEBAR_H )) \
	$(( WIN_W - RAIL_W )) \
	$(( WIN_H - TITLEBAR_H ))
# A disclosed card redraws a quarter of that area. Two settled frames of the
# same state measured 26 pixels apart out of 694,848, which is the software
# renderer's own noise, so agreement is generous and disclosure is unmistakable.
DISCLOSED_PER_MILLE=50
IDENTICAL_PER_MILLE=2

# ─── A Real Tool Call ────────────────────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
submit_prompt "run this shell command for me with your bash tool: printf 'running 6 tests\n'; printf 'test transcribes_a_16k_mono_wav ... ok\n'"

if ! native_tool_call_recorded; then
	abandon_take "native-tool-call-recorded" "the submitted turn recorded no completed tool call within 240s"
fi
# The card exists as soon as the tool result is recorded, and the model goes on
# writing after it. Every frame below is compared against a baseline over the
# whole transcript, so a turn still streaming under the card puts its next
# paragraph in the differential: a take that opened and closed the card
# correctly measured 136 per mille between two collapsed frames, which is a
# paragraph, not a disclosure. The comparison starts once the turn is settled.
if ! native_session_ready finished 2; then
	abandon_take "native-tool-turn-settled" \
		"the turn that called the tool never reached Complete within 90s, so no two frames of it are comparable"
fi
pause 0.8

# ─── Disclosure From The Keyboard ────────────────────────────────────────────
# The transcript owns `space`, so the pointer establishes that scope first; the
# turn step focuses the turn the card is in, which is the last one.
#
# The baseline is shot AFTER that, not before: a focused turn draws its own
# ring and reveals the footer stating which model wrote it, so a frame taken
# before the focus lands differs from the closed card by everything the focus
# added. That read 210 per mille between two frames of one collapsed card. The
# disclosure is the only thing that may differ between the three frames below.
TRANSCRIPT_X=$(( WIN_X + WIN_W / 2 ))
TRANSCRIPT_Y=$(( WIN_Y + (WIN_H > 481 ? 481 / 3 : WIN_H / 3) ))
move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
click
pause 0.4
k "End"
pause 1.0
shot tool-card-collapsed

k "space"
pause 1.0
shot tool-card-keyboard-open

k "space"
pause 1.0
shot tool-card-keyboard-closed

# ─── Disclosure From The Pointer ─────────────────────────────────────────────
# The same card, opened the other way. Which row holds it is found by clicking,
# because nothing else states it: the transcript is laid out from the host's
# blocks, so the row moves with every word the model wrote around it, and the
# transcript is anchored on its live edge, so the whole turn also moves when
# the card opens. Two arithmetic aims were tried and neither lands: a fixed
# offset above the composer photographed the collapsed card unchanged, and the
# box of the difference between the disclosed and collapsed frames spans the
# shifted prose as well as the card, so its top edge is 300px above the row.
#
# The search runs DOWN the transcript, from the ground above the turn to the
# prose under the card, and stops at the first click that disclosed. Upward
# from the composer it reached the focused turn's own footer first, whose
# trailing actions opened the right panel over the transcript: every later
# click then landed on a surface that had been re-laid-out around a 360px
# column, and the take recorded a frame with a panel in it.
#
# Two of the rows above the card answer a press as well. The footer states
# which model wrote the turn, revealed while the keyboard is on it, and a
# click on that name opens the usage tab. So a click is read three ways: the
# disclosed card is the frame the keyboard already produced; ground and prose
# leave the collapsed frame alone; anything else moved the surface, which is
# put back and read back before the next row is tried. A stray change no
# recovery undoes ends the take naming the row that did it and every reading
# taken, since no later frame is comparable to the ones already taken.
#
# The step is smaller than the row, so no row is passed over, and the pointer
# parks where the keyboard frames were taken so no hover state separates the
# pair.
CARD_X=$(( TRANSCRIPT_COLUMN_LEFT + 8 ))
CARD_FLOOR=$(( WIN_Y + WIN_H - COMPOSER_BAND_H - 40 ))
CARD_OPENED=0
park_pointer() {
	move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
	pause 0.4
}
# PUTTING THE SURFACE BACK. A click that is neither the card nor ground leaves
# one of three states, and which one it left is read back rather than assumed.
# Escape dismisses an overlay. The click and `End` that took the baseline
# restore a turn focus that a click on the ground moved to the scroll
# container, which draws its own ring and reads as a few pixels per thousand.
# The panel chord toggles the right panel, and it is a TOGGLE: a take that
# reached for the chord first chorded a panel OPEN over a surface whose stray
# change was a moved focus, and reported 460 per thousand where it expected
# agreement. So the ladder runs first, the chord only after it, a chord that
# did not help is undone, and each step states what it left.
restore_collapsed() {
	{
		k "Escape"
		pause 0.5
		move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
		click
		pause 0.3
		k "End"
		pause 0.8
		park_pointer
	} >&2
	screen_differs_from_shot_per_mille tool-card-collapsed
}
STRAY_FRAME="${SCENE_RUNTIME_DIR}/unexplained-stray.png"
for step in $(seq 0 39); do
	CARD_Y=$(( CROP_Y + 8 + step * 16 ))
	[ "${CARD_Y}" -lt "${CARD_FLOOR}" ] || break
	move_px "${CARD_X}" "${CARD_Y}"
	pause 0.2
	click
	pause 0.8
	park_pointer
	if [ "$(screen_differs_from_shot_per_mille tool-card-keyboard-open)" -le "${IDENTICAL_PER_MILLE}" ]; then
		CARD_OPENED="${CARD_Y}"
		break
	fi
	STRAY_PER_MILLE="$(screen_differs_from_shot_per_mille tool-card-collapsed)"
	[ "${STRAY_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ] || continue
	LADDER_PER_MILLE="$(restore_collapsed)"
	[ "${LADDER_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ] || continue
	k "ctrl+backslash"
	pause 0.8
	park_pointer
	CHORD_PER_MILLE="$(screen_differs_from_shot_per_mille tool-card-collapsed)"
	[ "${CHORD_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ] || continue
	k "ctrl+backslash"
	pause 0.8
	UNDONE_PER_MILLE="$(restore_collapsed)"
	[ "${UNDONE_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ] || continue
	probe_frame "${STRAY_FRAME}"
	abandon_take "a-click-on-the-transcript-discloses-or-does-nothing" \
		"the click at y=${CARD_Y} left ${STRAY_PER_MILLE} pixels per thousand changed and the surface did not come back: the escape ladder left ${LADDER_PER_MILLE}, the panel chord ${CHORD_PER_MILLE}, undoing the chord ${UNDONE_PER_MILLE}; the frame it could not explain is at ${STRAY_FRAME}"
done
if [ "${CARD_OPENED}" = 0 ]; then
	abandon_take "the-pointer-disclosed-the-card" \
		"no row between the top of the transcript and the composer drew the card the keyboard disclosed"
fi
echo "scene: the pointer disclosed the card from the row at y=${CARD_OPENED}" >&2
shot tool-card-pointer-open

# ─── What The Four Frames State ──────────────────────────────────────────────
OPENED_PER_MILLE="$(shots_differ_per_mille tool-card-collapsed tool-card-keyboard-open)"
if [ "${OPENED_PER_MILLE}" -lt "${DISCLOSED_PER_MILLE}" ]; then
	abandon_take "the-keyboard-disclosed-the-card" \
		"the space key changed ${OPENED_PER_MILLE} pixels per thousand, under the ${DISCLOSED_PER_MILLE} a disclosed card changes"
fi
CLOSED_PER_MILLE="$(shots_differ_per_mille tool-card-collapsed tool-card-keyboard-closed)"
if [ "${CLOSED_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "the-keyboard-closed-the-card" \
		"the closed card differs from the collapsed one by ${CLOSED_PER_MILLE} pixels per thousand"
fi
# Parity is decided by the search above, which ends only on a click that drew
# the keyboard's frame. This reads it again from the published shot, so a frame
# that changed between the measurement and the capture is caught rather than
# gallery-published as a pair.
PARITY_PER_MILLE="$(shots_differ_per_mille tool-card-keyboard-open tool-card-pointer-open)"
if [ "${PARITY_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "both-gestures-open-the-same-card" \
		"the keyboard frame and the pointer frame differ by ${PARITY_PER_MILLE} pixels per thousand"
fi
echo "scene: disclosure ${OPENED_PER_MILLE}/1000, close ${CLOSED_PER_MILLE}/1000, parity ${PARITY_PER_MILLE}/1000" >&2
