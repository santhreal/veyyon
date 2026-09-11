#!/usr/bin/env bash
# Open the window's menu bar from the keyboard and photograph the verbs it offers.
#
# Records visual evidence for:
#   1. the-titlebar-offers-every-verb (the first menu open under its word)
#   2. the-keyboard-walks-the-verbs (another menu open, the walk two entries in)
#
# THE DIFFERENTIAL. Before this change the window offered no menu: every verb
# was reached through the palette or through the chord it is bound to, and a
# verb with no chord was reached nowhere. The before arm presses the same keys
# this take drives the bar with -- the menu key, then the arrows -- and the
# window answers none of them, because neither the bar nor the binding that
# opens it exists in that build. The after arm draws the bar's five words in
# the titlebar and floats the pressed menu under its word, walks it with the
# arrows and leaves the draft in the composer untouched.
#
# WHAT IS MEASURED. Not the whole window, which carries a clock in its footer
# and an age on every card: the band the open menu occupies, from the titlebar's
# lower edge down over the card's own height, read between the frame taken
# before the menu key and the frame taken after it. The after arm requires that
# band to repaint at least MENU_MIN_PIXELS, which is what a menu card covering
# it does, and the before arm requires it to stay under QUIET_MAX_PIXELS, which
# is the rail's own ticking ages and nothing else. An arm recorded from the
# wrong build abandons the take rather than publishing a pair of one state.
#
# THE BAR IS DRIVEN BY THE KEYBOARD, NOT BY A POINTER. A word's position in the
# titlebar is a text measurement no scene can compute, and the menu key reaches
# the bar in the after arm and does nothing in the before arm, which is the
# state this pair is of. The pointer is parked on the composer throughout so no
# control carries hover styling in either arm.
#
# NOT RECORDED HERE: which verb each entry runs, what a refused entry looks
# like, and that the walk skips it. Those are swept over every section and every
# verb by
# `crates/veyyon-desktop-surface/tests/the-menu-bar-takes-the-verb-the-keyboard-walked-to.rs`
# and `every-verb-the-window-has-is-reachable-without-a-chord.rs`, and the
# window and process lifecycle the first menu reaches is
# `crates/veyyon-desktop/tests/closing-the-window-ends-the-process-only-when-nothing-can-reopen.rs`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh \
#     proof/scenes/desktop-menu-bar.sh
#
# and its other arm, whose change is in the desktop binary, so the arm names a
# build of the commit before the bar existed:
#
#   .internal/build-commit-before.py --tree <commit-before> menu-bar
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/menu-bar/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-menu-bar.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── The Band An Open Menu Occupies ──────────────────────────────────────────
# The bar's words sit in the titlebar's leading group and the pressed menu
# floats under the word from the titlebar's lower edge, so the band starts
# there and is as wide as the widest card the table can fill and as tall as its
# longest section comes to. Both are ceilings read against the window rather
# than a card's measured size, which is text metrics no scene can compute.
MENU_BAND_W=480
MENU_BAND_H=380
if [ "${WIN_W}" -lt $(( MENU_BAND_W + 40 )) ] || [ "${WIN_H}" -lt $(( TITLEBAR_H + MENU_BAND_H )) ]; then
	abandon_take "the-menu-band-is-inside-the-window" \
		"a ${WIN_W}x${WIN_H} window has no room for the ${MENU_BAND_W}x${MENU_BAND_H} band an open menu occupies"
fi
MENU_BAND="${MENU_BAND_W}x${MENU_BAND_H}+${WIN_X}+$(( WIN_Y + TITLEBAR_H ))"

# A menu card fills most of the band, so a floor a tenth of it still separates
# an open menu from the rail's ticking ages underneath.
MENU_MIN_PIXELS=18000
# The rail redraws an age and the footer a clock between two frames. Nothing
# else moves while a key the build does not bind is pressed.
QUIET_MAX_PIXELS=400
# A walk moves the fill from one row to another and changes which section is
# down, so the band repaints its rows. A floor well under one card's area
# separates that from nothing having moved.
WALK_MIN_PIXELS=2000

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# ─── 1. Leave A Draft In The Composer ────────────────────────────────────────
# The bar takes the keyboard from whatever held it, so the draft is what states
# that the keys the bar answers never reached the composer and that the draft
# comes back when the bar closes.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
click
pause 0.5
t "a draft nobody asked to send"
pause 1.0

AT_REST="${PROBE_DIR}/menu-bar-at-rest.png"
probe_frame "${AT_REST}"

# ─── 2. Open The Bar With The Menu Key ───────────────────────────────────────
k F10
pause 1.0
BAR_OPEN="${PROBE_DIR}/menu-bar-open.png"
probe_frame "${BAR_OPEN}"
OPEN_PX="$(frames_differ_pixels_at "${AT_REST}" "${BAR_OPEN}" "${MENU_BAND}")"
echo "scene: the menu key repainted ${OPEN_PX}px of the band an open menu occupies" >&2

case "${ARM}" in
before)
	if [ "${OPEN_PX}" -gt "${QUIET_MAX_PIXELS}" ]; then
		abandon_take "the-menu-key-reaches-nothing" \
			"the menu key repainted ${OPEN_PX}px of the band, over the ${QUIET_MAX_PIXELS}px a build with no menu bar in it can move, so this arm is not the before state"
	fi
	;;
after)
	if [ "${OPEN_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
		abandon_take "the-menu-key-opens-the-bar" \
			"the menu key repainted ${OPEN_PX}px of the band, under the ${MENU_MIN_PIXELS}px an open menu covers, so no menu came down"
	fi
	;;
*)
	abandon_take "the-arm-is-named" "SCENE_ARM=${ARM} is neither before nor after"
	;;
esac

# ─── 3. Photograph The Bar Under Its First Word ──────────────────────────────
shot the-titlebar-offers-every-verb

# ─── 4. Walk The Bar And The Menu It Opened ──────────────────────────────────
# One step along the bar and two down its entries: a walk that crosses both
# axes, so the frame states that the arrows reach the bar rather than the queue
# the same keys are bound to underneath.
k Right
pause 0.6
k Down
pause 0.4
k Down
pause 1.0
WALKED="${PROBE_DIR}/menu-bar-walked.png"
probe_frame "${WALKED}"
WALK_PX="$(frames_differ_pixels_at "${BAR_OPEN}" "${WALKED}" "${MENU_BAND}")"
echo "scene: the walk repainted ${WALK_PX}px of the band" >&2

case "${ARM}" in
before)
	if [ "${WALK_PX}" -gt "${QUIET_MAX_PIXELS}" ]; then
		abandon_take "the-arrows-reach-nothing" \
			"the arrows repainted ${WALK_PX}px of the band in a build with no menu bar in it"
	fi
	;;
after)
	if [ "${WALK_PX}" -lt "${WALK_MIN_PIXELS}" ]; then
		abandon_take "the-arrows-walk-the-bar" \
			"the arrows repainted ${WALK_PX}px of the band, under the ${WALK_MIN_PIXELS}px a walk across a section and two entries moves"
	fi
	;;
esac

shot the-keyboard-walks-the-verbs

# ─── 5. Leave The Bar Closed And The Draft Where It Was ──────────────────────
# Escape rather than Return, so the take ends without running the verb the walk
# is on, and the composer gets the keyboard back with its draft still in it.
k Escape
pause 1.0
CLOSED="${PROBE_DIR}/menu-bar-closed.png"
probe_frame "${CLOSED}"
GONE_PX="$(frames_differ_pixels_at "${WALKED}" "${CLOSED}" "${MENU_BAND}")"
echo "scene: Escape repainted ${GONE_PX}px of the band" >&2
if [ "${ARM}" = "after" ] && [ "${GONE_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "escape-closes-the-bar" \
		"Escape repainted ${GONE_PX}px of the band, under the ${MENU_MIN_PIXELS}px a menu leaving it uncovers"
fi

BACK_PX="$(frames_differ_pixels_at "${AT_REST}" "${CLOSED}" "${COMPOSER_BAND_CROP}")"
echo "scene: the composer band differs from its pre-menu state by ${BACK_PX}px" >&2
if [ "${BACK_PX}" -gt "${QUIET_MAX_PIXELS}" ]; then
	abandon_take "the-draft-is-where-it-was" \
		"the composer band moved ${BACK_PX}px while the bar was up, so the keys the bar answered reached the draft"
fi
