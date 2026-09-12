#!/usr/bin/env bash
# Ask the native GPUI window to abort a turn while the session is idle, and
# read what the refusal it gets back offers to do about it.
#
# Records visual evidence for:
#   1. at-rest  (the composer with no refusal under it)
#   2. refusal  (the refusal the host answered `/abort` with)
#   3. cleared  (the composer after the refusal's own control was pressed)
#
# THE CLAIM. A refusal offers to send the request again only when the host
# said the request is worth sending again. The host states that per error:
# `AbortTurn` with nothing running is `NOT_RUNNING`, `retryable: false`, final
# -- the same `Session` scope as `TURN_IN_PROGRESS`, which is `retryable:
# true`. Before, the window read retryability off the scope, so every `Session`
# refusal drew a `Retry`, including the ones the host had already ruled out,
# and pressing it cleared the error and sent nothing. After, the refusal draws
# only the control it has: `Dismiss`.
#
# HOW IT IS REACHED. `/abort` is a palette row gated by the `TurnControl`
# capability and by nothing else, so it is reachable with the session idle,
# which is when the host refuses it. The error carries the request id, so it
# lands on the control that sent it -- the composer's abort control -- and the
# composer draws its hairline at the foot of the card.
#
# WHAT IS MEASURED. The hairline's own row is profiled column by column and
# its ink is grouped into controls: 40px of fill separates two controls, 5px
# separates two words of one label. The rightmost
# control is `Dismiss`, which both arms draw, and it is the scale the reading
# is judged against rather than a width this scene decided. The after arm
# holds one control there; the before arm holds two, the leading one no
# narrower than half the dismissal beside it. Pressing the rightmost control
# returns the band to the frame it started from, so the after arm's single
# control is the remedy rather than a dead end.
#
# The before arm's two controls are pressed apart from each other, which is
# itself a reading: a control whose id it shares with the one beside it
# answers no press at all, so the dismissal beside `Retry` clearing the band
# is the two-sibling case of that contract in the product.
#
# The same row holds the card's own footer while no refusal is under it,
# which is why the reading is taken from the refusal frame rather than from a
# row asserted to be empty: the hairline is the card's last child, so it takes
# the lowest row and pushes the footer up while it is drawn.
#
# WHAT IT DOES NOT SHOW. That a `Retry` under a retryable refusal now sends
# the request the host refused rather than one re-derived from the control's
# own id. A frame cannot photograph a request that was never sent, and the
# reachable retryable refusals need a second party -- a turn already running,
# an extension that cancels a switch -- so that half is proved by
# `crates/veyyon-desktop/tests/a-retry-sends-the-request-the-host-refused.rs`
# and its mutation gate instead.
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build with the change removed:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh proof/scenes/desktop-refusal-retry.sh
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-refusal-retry.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Refusal Is Read ───────────────────────────────────────────────
# The hairline is the last child of the composer card, and the card is
# bottom-anchored, so the row sits against the card's inner lower edge however
# tall the rest of the card came out. §6.10 sets a small control at 24px and
# the row pads it by one spacing step, which puts the controls' own box inside
# the 16px band this reads. The band spans the row end to end: the row lays
# its message and its controls out with the space between them, so a control
# is wherever the count of them put it rather than against the trailing edge.
ROW_BOTTOM=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM ))
BAND_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H ))
BAND_W=$(( COMPOSER_CARD_W - 2 * CARD_PAD_H ))
BAND_Y=$(( ROW_BOTTOM - 23 ))
BAND_H=16
if [ "${BAND_W}" -lt 240 ] || [ "${BAND_Y}" -le "${WIN_Y}" ]; then
	abandon_take "the-hairline-has-a-band" \
		"the row resolved to ${BAND_W}x${BAND_H}+${BAND_X}+${BAND_Y}, too small to hold a refusal"
fi
BAND_CROP="${BAND_W}x${BAND_H}+${BAND_X}+${BAND_Y}"
echo "scene: the refusal's row is read over ${BAND_CROP}" >&2

# Ink is grouped into controls here rather than in the shell: a column profile
# is two `magick` calls and the grouping is arithmetic over them. A column
# counts as ink when its darkest and lightest pixel differ, which the row's
# own fill does not do and a glyph does. Ink separated by up to 12px is one
# label, since the row's words sit 5px apart; a run of 40px or more of fill
# separates the message from a control and one control from the next, since
# the row distributes what is left over between them. What is printed is the
# controls: every group but the leading one, as its centre and its width, so
# one reading answers both how many the row drew and where to press one.
row_controls() { # <png> -> "<centre>:<width> ..." in left-to-right order
python3 - "$1" "${BAND_X}" "${BAND_Y}" "${BAND_W}" "${BAND_H}" <<'PY'
import re
import subprocess
import sys

png, x, y, w, h = sys.argv[1], *(int(value) for value in sys.argv[2:6])
INK = 24
MERGE = 12
APART = 40


def profile(statistic):
	rendered = subprocess.run(
		[
			"magick", png,
			"-crop", f"{w}x{h}+{x}+{y}", "+repage",
			"-colorspace", "gray",
			"-statistic", statistic, f"1x{h}",
			"-crop", f"{w}x1+0+0", "+repage",
			"-depth", "8", "txt:-",
		],
		capture_output=True,
		text=True,
		check=True,
	).stdout
	return [
		int(found.group(1), 16)
		for found in (re.search(r"#([0-9A-Fa-f]{2})", line) for line in rendered.splitlines())
		if found
	]


darkest, lightest = profile("Minimum"), profile("Maximum")
if len(darkest) != w or len(lightest) != w:
	raise SystemExit(f"the profile came back {len(darkest)} columns wide, not {w}")

groups: list[list[int]] = []
for column in (c for c in range(w) if lightest[c] - darkest[c] > INK):
	if groups and column - groups[-1][1] <= MERGE:
		groups[-1][1] = column
	else:
		groups.append([column, column])
controls = [
	group
	for index, group in enumerate(groups)
	if index and group[0] - groups[index - 1][1] >= APART
]
print(" ".join(f"{x + (start + end) // 2}:{end - start + 1}" for start, end in controls))
PY
}

# ─── The Composer With Nothing Under It ──────────────────────────────────────
# The preamble left a slash in the composer and the palette dismissed. The
# draft is cleared first, so the frame the refusal is measured against is the
# card at its resting height.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
pause 0.3
k "ctrl+a"
k "BackSpace"
pause 0.8
shot at-rest

# ─── The Refusal ─────────────────────────────────────────────────────────────
# `/abort` runs the same intent the composer's stop control sends, from the
# palette, which offers it whenever the session carries turn control. Nothing
# is running, so the host answers with a refusal it has marked final.
t "/abort"
pause 1.0
k "Return"

REFUSED=0
for _ in $(seq 1 40); do
	pause 0.25
	if [ "$(screen_differs_from_frame_pixels_at "${SCENE_OUT}/${SCENE_NAME}-at-rest.png" "${BAND_CROP}")" -gt 200 ]; then
		REFUSED=1
		break
	fi
done
if [ "${REFUSED}" != "1" ]; then
	abandon_take "the-host-answered" \
		"nothing was drawn in the card's lowest row within 10s of running /abort"
fi
pause 0.8
shot refusal

use_crop "${BAND_X}" "${BAND_Y}" "${BAND_W}" "${BAND_H}"
REFUSAL_PX="$(shots_differ_pixels at-rest refusal)"
read -r -a CONTROLS <<<"$(row_controls "${SCENE_OUT}/${SCENE_NAME}-refusal.png")"
echo "scene: the refusal drew ${#CONTROLS[@]} control(s) -- ${CONTROLS[*]} -- over ${REFUSAL_PX}px of change" >&2

ARM="${SCENE_ARM:-after}"
if [ "${#CONTROLS[@]}" -eq 0 ]; then
	abandon_take "the-refusal-drew-controls" \
		"the row holds no control at all, so the hairline is not what changed in it"
fi
DISMISS_X="${CONTROLS[-1]%%:*}"
DISMISS_W="${CONTROLS[-1]##*:}"
if [ "${DISMISS_W}" -lt 24 ]; then
	abandon_take "the-dismissal-is-a-control" \
		"the trailing control measured ${DISMISS_W}px, too narrow to be a label"
fi
if [ "${ARM}" = "before" ]; then
	# Retry, then Dismiss. `Retry` is the shorter label of the two, so it is
	# read against half the width of the control beside it rather than against
	# a number of its own.
	if [ "${#CONTROLS[@]}" -ne 2 ]; then
		abandon_take "the-refusal-offered-a-retry" \
			"the before arm's refusal drew ${#CONTROLS[@]} control(s), not the retry and the dismissal"
	fi
	RETRY_W="${CONTROLS[0]##*:}"
	if [ "${RETRY_W}" -lt "$(( DISMISS_W / 2 ))" ]; then
		abandon_take "the-retry-is-a-control" \
			"the leading control measured ${RETRY_W}px against a ${DISMISS_W}px dismissal, too narrow to be a label"
	fi
elif [ "${#CONTROLS[@]}" -ne 1 ]; then
	abandon_take "the-refusal-is-final" \
		"the after arm's refusal drew ${#CONTROLS[@]} control(s), so it still offers to send a request the host ruled out"
fi

# ─── The Remedy ──────────────────────────────────────────────────────────────
# The rightmost control is the dismissal in both arms. Pressing it clears the
# refusal and the card returns to its resting height, which is what makes the
# after arm's single control a way out rather than a message with no answer.
move_px "${DISMISS_X}" "$(( BAND_Y + BAND_H / 2 ))"
pause 0.4
click
pause 1.2
shot cleared

CLEARED_PX="$(shots_differ_pixels at-rest cleared)"
if [ "${CLEARED_PX}" -gt "$(( REFUSAL_PX / 5 ))" ]; then
	abandon_take "the-refusal-was-dismissed" \
		"the band still differs from rest by ${CLEARED_PX}px of the ${REFUSAL_PX}px the refusal drew"
fi

echo "scene: ${ARM} arm -- the refusal offered ${#CONTROLS[@]} control(s)," \
	"and the dismissal returned the band to ${CLEARED_PX}px of the ${REFUSAL_PX}px it moved" >&2
