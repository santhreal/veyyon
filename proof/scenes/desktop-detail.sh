#!/usr/bin/env bash
# Photograph the composer's model chip before a secondary press, under one, and
# after the press was dismissed.
#
# Records visual evidence for:
#   1. detail-closed    (the idle session, pointer parked away from the chip)
#   2. detail-open      (a secondary press on the chip, the popover above it)
#   3. detail-dismissed (Escape pressed, the popover gone)
#
# WHAT IS MEASURED. Two readings per shot, both over one rectangle: the band
# directly above the composer card, which is transcript ground until a popover
# is drawn there.
#
#   * THE FLOAT GROUND IN THE BAND, counted as pixels of the exact colour the
#     installed theme authors for `role.float`, with the theme resolved from
#     the resting frame's own ground rather than assumed. A card drawn there
#     fills tens of thousands of them and the transcript under it draws none,
#     so the reading separates a popover from any other change in the band.
#   * HOW MANY PIXELS THE BAND CHANGED against the shot before it, which is
#     what tells a popover that was drawn from one that was drawn somewhere
#     else: a card placed below the chip, or slid against the window's foot,
#     leaves this band as it was.
#
# The band is above the card rather than over it: the composer blinks a caret
# and the session rail ticks each session's age, so a rectangle that included
# either would differ between two shots whatever the press did.
#
# THE ARMS. The after arm draws the card in the band, fills it with the float
# ground, and leaves the band as it found it once Escape was pressed -- so a
# popover that never appeared, one placed below the chip, and one that outlived
# its dismissal are separate failures. The before arm's chip answers no
# secondary press: the band holds no float ground in any of the three shots and
# changes by nothing between them.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-detail.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build of the pre-change tree:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     <commit> detail-before
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/detail-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-detail.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Band A Popover Anchored To The Chip Is Drawn In ────────────────────
# A detail opened on the chip puts its lower left corner at the press, so the
# band is the authored anchored measure wide from the press point, and tall
# enough to hold a popover of every fact this build states.
POPOVER_W="$(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
palette = tomllib.loads((root / "surface/palette.toml").read_text())
print(int(palette["geometry"]["anchored_width_px"]))
PY
)"
BAND_H=260
BAND_X="${MODEL_CHIP_X}"
BAND_W="${POPOVER_W}"
BAND_Y=$(( MODEL_CHIP_Y - BAND_H ))
if (( BAND_Y < WIN_Y + TITLEBAR_H )); then
	abandon_take "detail-closed" \
		"the band above the chip starts at ${BAND_Y}, above the window's titlebar at $(( WIN_Y + TITLEBAR_H ))"
fi
if (( BAND_X + BAND_W > WIN_X + WIN_W )); then
	abandon_take "detail-closed" \
		"the ${BAND_W}px band at ${BAND_X} runs past the window's right edge at $(( WIN_X + WIN_W ))"
fi
# The band stops at the composer card's top edge. The card is drawn on the same
# floating ground the popover is, and it holds the draft's caret, so a
# rectangle that reached over its top edge would report the card that was
# always there and blink between two shots whatever the press did. What is left
# is the ground a resting session draws nothing on at all.
COMPOSER_CARD_TOP=$(( COMPOSER_CARD_BOTTOM - COMPOSER_BAND_H ))
BAND_H=$(( COMPOSER_CARD_TOP - BAND_Y ))
if (( BAND_H < 80 )); then
	abandon_take "detail-closed" \
		"only ${BAND_H}px sit between the top of the band at ${BAND_Y} and the composer card at ${COMPOSER_CARD_TOP}, too few to read a card in"
fi
BAND_CROP="${BAND_W}x${BAND_H}+${BAND_X}+${BAND_Y}"

# The card clears the composer card by about thirty-four rows of its full
# width, which is 13079 pixels of floating ground in this build. The floor is
# under half of that, so a card whose facts come to one row less still clears
# it, while a hairline, a shadow or a row of hover tint does not.
FLOAT_FLOOR=6000
# What the band reads when nothing is floating in it. The transcript draws no
# float ground, so this is the ceiling for a band with no card in it.
FLOAT_CEILING=2000
# A card appearing or going changes the band wholesale: its ground, its heading
# and the rows of facts under it, which comes to 15122 pixels in this build.
# The floor is a little over half of that, so a card one row shorter still
# clears it.
DREW_FLOOR=8000
# What is left when a dismissal took the card away: nothing but the transcript
# the band was reading before the press.
QUIET_CEILING=600

# Which of the shipped themes the window is drawing, and the ground that theme
# authors for a floating surface. The appearance is read off the frame rather
# than assumed: the resting band holds one flat colour, and the theme whose own
# ground is that colour is the one installed. A theme that draws a floating
# surface on the same ground as the band cannot report one, and says so.
resolve_float_ground() { # <resting-shot>
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png" hist
	hist="$(magick "${png}" -crop "${BAND_CROP}" +repage -alpha off \
		-format '%c' histogram:info: 2>/dev/null)" || return 1
	python3 - \
		"${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes" \
		"$(( BAND_W * BAND_H ))" \
		"${hist}" <<'THEME'
import re
import sys
from pathlib import Path
import tomllib

themes, band, hist = sys.argv[1], int(sys.argv[2]), sys.argv[3]
rows = re.findall(r"(\d+):\s*\(\s*(\d+),\s*(\d+),\s*(\d+)", hist)
if not rows:
    sys.exit(f"the resting band reported no histogram: {hist[:120]!r}")
held, *channels = max(((int(n), int(r), int(g), int(b)) for n, r, g, b in rows))
dominant = tuple(channels)
if held < band * 0.9:
    sys.exit(f"the resting band is not one flat colour: {dominant} holds {held} of {band}")


def rgb(value):
    return tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))


for theme in sorted(Path(themes).glob("*.toml")):
    role = tomllib.loads(theme.read_text())["role"]
    if rgb(role["ground"]) != dominant:
        continue
    if role["float"] == role["ground"]:
        sys.exit(f"{theme.stem} draws a floating surface on the ground the band holds")
    print(f"{theme.stem}\t{role['float']}")
    break
else:
    sys.exit(f"no shipped theme draws its ground as {dominant}, which the resting band holds")
THEME
}

# Pixels of exactly that ground. The marker is a colour no surface in the
# window draws, so a ground that is itself white is counted once rather than
# folded into the pixels the second pass keeps.
float_ground_pixels() { # <shot> <crop>
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png" counted
	counted="$(magick "${png}" -crop "$2" +repage -alpha off \
		-fuzz 0 -fill '#ff00ff' -opaque "${FLOAT_GROUND}" \
		-fill white -opaque '#ff00ff' -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "detail-ground-countable" \
				"counting the float ground in $1 over $2 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

band_differs() { # <shot-a> <shot-b>
	frames_differ_pixels_at \
		"${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		"${SCENE_OUT}/${SCENE_NAME}-$2.png" \
		"${BAND_CROP}"
}

echo "scene: reading ${BAND_CROP}, the band between the composer card and a chip at ${MODEL_CHIP_X},${MODEL_CHIP_Y}" >&2

# The float ground the readings count, resolved from the resting frame once the
# first shot is taken.
FLOAT_THEME=""
FLOAT_GROUND=""

# ─── The Session Before Any Press ───────────────────────────────────────────
# The preamble created the session and left a draft in the composer, so the
# chip is drawn and the window is the one a session is open in.
#
# The pointer rests on the session row in the rail, which is left of every band
# reading and answers a hover: that is what makes each frame differ from the one
# before it in an arm where the press draws nothing, so the byte-identical guard
# reports a take that captured the same frame twice rather than a build that
# answered nothing. The band readings never see it.
PARK_X=$(( WIN_X + RAIL_W / 2 ))
PARK_Y=$(( WIN_Y + TITLEBAR_H + 100 ))
move_px "${PARK_X}" "${PARK_Y}"
settle_idle
pause 1.0
shot detail-closed
RESOLVED="$(resolve_float_ground detail-closed 2>&1)" || abandon_take "detail-closed" \
	"the band's own appearance did not resolve to a shipped theme: ${RESOLVED}"
FLOAT_THEME="${RESOLVED%%$'\t'*}"
FLOAT_GROUND="${RESOLVED##*$'\t'}"
case "${FLOAT_GROUND}" in
	'#'[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
	*)
		abandon_take "detail-closed" \
			"the installed theme resolved to '${RESOLVED}', which states no float ground to count"
		;;
esac
echo "scene: the window is drawing ${FLOAT_THEME}, whose floating surfaces sit on ${FLOAT_GROUND}" >&2
CLOSED_FLOAT="$(float_ground_pixels detail-closed "${BAND_CROP}")"
if [ "${CLOSED_FLOAT}" -gt "${FLOAT_CEILING}" ]; then
	abandon_take "detail-closed" \
		"the band above the chip already holds ${CLOSED_FLOAT} pixels of float ground, over the ${FLOAT_CEILING} an empty band reads: this take is measuring a surface that was already floating there"
fi

# ─── The Secondary Press On The Chip ────────────────────────────────────────
move_px "${MODEL_CHIP_X}" "${MODEL_CHIP_Y}"
pause 0.4
right_click
pause 1.2
shot detail-open
OPEN_FLOAT="$(float_ground_pixels detail-open "${BAND_CROP}")"
OPEN_DREW="$(band_differs detail-closed detail-open)"

# ─── The Dismissal ──────────────────────────────────────────────────────────
# The pointer goes back to where the resting frame was taken from, so the band
# is read against the same hover state it was read against before the press.
k "Escape"
pause 0.6
move_px "${PARK_X}" "${PARK_Y}"
pause 1.2
shot detail-dismissed
GONE_FLOAT="$(float_ground_pixels detail-dismissed "${BAND_CROP}")"
GONE_QUIET="$(band_differs detail-closed detail-dismissed)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${OPEN_FLOAT}" -gt "${FLOAT_CEILING}" ]; then
		abandon_take "detail-open" \
			"the baseline floated ${OPEN_FLOAT} pixels of ground above the chip, over the ${FLOAT_CEILING} an empty band reads, so this arm proves nothing about the press"
	fi
	if [ "${OPEN_DREW}" -gt "${QUIET_CEILING}" ]; then
		abandon_take "detail-open" \
			"the baseline changed ${OPEN_DREW} pixels of the band on a secondary press, over the ${QUIET_CEILING} a settled band moves by"
	fi
	echo "scene: before arm -- float ground ${CLOSED_FLOAT} -> ${OPEN_FLOAT} -> ${GONE_FLOAT}, band moved ${OPEN_DREW} on the press and ${GONE_QUIET} by the dismissal: the chip answers no secondary press" >&2
else
	if [ "${OPEN_FLOAT}" -lt "${FLOAT_FLOOR}" ]; then
		abandon_take "detail-open" \
			"the press floated ${OPEN_FLOAT} pixels of ground above the chip, under the ${FLOAT_FLOOR} a card of this measure fills: the popover was drawn somewhere other than above the control it belongs to"
	fi
	if [ "${OPEN_DREW}" -lt "${DREW_FLOOR}" ]; then
		abandon_take "detail-open" \
			"the press changed ${OPEN_DREW} pixels of the band, under the ${DREW_FLOOR} a card appearing changes"
	fi
	if [ "${GONE_FLOAT}" -gt "${FLOAT_CEILING}" ]; then
		abandon_take "detail-dismissed" \
			"the dismissal left ${GONE_FLOAT} pixels of float ground in the band, over the ${FLOAT_CEILING} an empty band reads: the popover outlived the press that dismissed it"
	fi
	if [ "${GONE_QUIET}" -gt "${QUIET_CEILING}" ]; then
		abandon_take "detail-dismissed" \
			"the dismissed popover left ${GONE_QUIET} pixels of the band changed from before the press, over the ${QUIET_CEILING} a settled band moves by"
	fi
	echo "scene: after arm -- float ground ${CLOSED_FLOAT} -> ${OPEN_FLOAT} -> ${GONE_FLOAT}, band moved ${OPEN_DREW} on the press and ${GONE_QUIET} by the dismissal: the press drew the card above the chip and the dismissal took it away" >&2
fi
