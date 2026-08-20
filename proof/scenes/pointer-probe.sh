#!/usr/bin/env bash
# WHY THIS EXISTS. Six primitives stand between a scene and a display server, and five of
# them announce their own failure: a key that does not arrive leaves the composer empty, a
# capture that fails writes no file, a screen read that fails returns nothing. The pointer
# is the one that lies. `swaymsg seat ... cursor set` exits 0 whether or not a seat exists,
# and the standalone Wayland probe reported POINTER FAILED for the one reason that was not
# the pointer -- SWAYSOCK was unset -- so the primitive has never been proven to move
# anything at all. A hover band recorded from a pointer that never moved is a frame of the
# rest state with a caption claiming otherwise.
#
# So this asserts the pointer in two halves, because they fail separately:
#
#   MOTION reaches the compositor. The pointer is put at two known pixels and a frame is
#   taken at each. Nothing in the app has to react: the cursor itself is drawn by the
#   compositor, so the two frames differ at those two places or the move did nothing. The
#   frames are the evidence and the judgement is made on them, not here.
#
#   A CLICK reaches the application. Motion can work while the button never arrives: the
#   backends spell a press as a seat command and as an X11 button, and neither is checked
#   by the compositor. So this drives a real surface -- open the settings overlay, click a
#   sidebar row with the pointer, and require the right pane to change to that row's text.
#   That is a click travelling through the compositor, the terminal's SGR encoding and the
#   app's hit-testing, which is the whole path a scene depends on.
#
# It runs on either server unchanged. That is the point: the X11 arm is the control, and a
# failure that appears on both is the scene's fault rather than the backend's.
settle 6

# --- MOTION ------------------------------------------------------------------
# Two pixels far apart inside the window, so the cursor cannot be mistaken for
# noise or for the text caret, and so a stuck pointer cannot pass by accident.
AX=$(px_x 20)
AY=$(px_y 6)
BX=$(px_x 100)
BY=$(px_y 24)

move_px "${AX}" "${AY}"
pause 0.6
shot pointer-at-a
echo "probe: pointer asked for ${AX},${AY} and reads back $(_be_pointer_at)" >&2

move_px "${BX}" "${BY}"
pause 0.6
shot pointer-at-b
echo "probe: pointer asked for ${BX},${BY} and reads back $(_be_pointer_at)" >&2

slash "/settings"
settle_idle 200 6 2 30
if ! screen_has "Settings" || ! screen_has "Dark Theme"; then
	echo "probe: SETTINGS DID NOT OPEN -- the click half cannot be judged" >&2
	shot pointer-no-settings
	exit 1
fi

# The row and column are taken FROM THE SCREEN, not assumed. A hardcoded row is a
# guess about the product's sidebar that ages into a click on whatever moved into
# that row, and this probe would still pass, having proven nothing.
#
# `get-text` returns the screen top-down and the scene grid is 1-based, so the
# line number IS the row; `index()` gives the column the same way. Every
# substitution here ends in `|| true`, because a scene runs under `set -e` inside
# the session script and an assignment from a pipeline that finds nothing kills
# the take with no message at all -- which is exactly how the first run of this
# probe died between two shots that were never written.
SCREEN="$(screen_text)"
ROW="$(printf '%s\n' "${SCREEN}" | grep -n -m1 'Providers' | cut -d: -f1 || true)"
COL="$(printf '%s\n' "${SCREEN}" | awk '/Providers/ {print index($0, "Providers"); exit}' || true)"
if [ -z "${ROW}" ] || [ -z "${COL}" ]; then
	echo "probe: no Providers row on screen -- cannot aim the click" >&2
	shot pointer-no-target
	exit 1
fi
echo "probe: aiming at 'Providers' at row ${ROW} col ${COL}" >&2

# HOVER IS JUDGED HERE, not by whoever remembers to measure the frames later. The
# hover band is pixels rather than text, so `get-text` cannot see it: the row under
# the pointer is washed with `selectedBg` and its label brightens.
#
# WHAT IS NOT THE TEST: that the row got brighter. It does on X11 and it does not on
# Wayland, from the same product on the same theme -- +0.004 against -0.032 -- because
# the wash is a near-opaque dark fill and the sidebar around it is a translucent
# window over a blurred backdrop, so the same band reads brighter inside an opaque
# window and darker inside a glass one. A direction is a fact about the compositor.
# Measured with a threshold on the signed difference, this probe called a hover band
# that is plainly there -- brighter label, wash, left marker -- "motion is not
# reaching the application", which is the failure mode of a check that encodes what
# the author expected to see.
#
# THE TEST is that the row the pointer is on changed, and that a row it is not on did
# not. That holds on any compositor and in any theme, it cannot be satisfied by a
# global brightness shift (the control row cancels it), and it is what "the pointer
# reached the application" actually means.
point 28 100
pause 0.8
shot pointer-away
point "${ROW}" "$((COL + 3))"
pause 0.8
shot pointer-hover

band_mean() { # band_mean <frame> <row> -> mean luminance 0..1 of that row's band
	local y=$(($(px_y "$2") - CELL_H / 2))
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		-crop "$((18 * CELL_W))x${CELL_H}+$(($(px_x "${COL}") - CELL_W / 2))+${y}" +repage \
		-colorspace Gray -format '%[fx:mean]' info: 2>/dev/null || echo 0
}
# The control is four rows down: the same sidebar, the same glass, the same blur, and
# no pointer on it. A neighbour would be inside the hover fade's cross-band.
CONTROL_ROW=$((ROW + 4))
TARGET_DELTA="$(awk -v a="$(band_mean pointer-away "${ROW}")" -v h="$(band_mean pointer-hover "${ROW}")" \
	'BEGIN { d = h - a; print (d < 0 ? -d : d) }')"
CONTROL_DELTA="$(awk -v a="$(band_mean pointer-away "${CONTROL_ROW}")" -v h="$(band_mean pointer-hover "${CONTROL_ROW}")" \
	'BEGIN { d = h - a; print (d < 0 ? -d : d) }')"
echo "probe: row ${ROW} moved ${TARGET_DELTA}, control row ${CONTROL_ROW} moved ${CONTROL_DELTA}" >&2
if ! awk -v t="${TARGET_DELTA}" -v c="${CONTROL_DELTA}" 'BEGIN { exit !(t > 0.0025 && t > 3 * c) }'; then
	echo "probe: NO HOVER BAND -- the row under the pointer did not change, or the whole frame did" >&2
	exit 1
fi
echo "probe: the row under the pointer changed and the control row did not" >&2

click
settle_idle 200 6 2 30
shot pointer-clicked

# The pane, not the checksum. A checksum moves when a clock ticks or a spinner
# turns, so it cannot tell a click that landed from a second that passed. "Dark
# Theme" is an Appearance-only row: it is on screen while Appearance is selected
# and gone once the pointer has selected Providers, so its absence is the click
# arriving, being hit-tested to that row, and the pane rebuilding.
if screen_has "Dark Theme"; then
	echo "probe: CLICK DID NOT SELECT -- the Appearance pane is still on screen" >&2
	exit 1
fi
echo "probe: the click selected Providers -- the Appearance pane is gone" >&2
k Escape
pause 0.5
