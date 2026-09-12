#!/usr/bin/env bash
# Have the host refuse a real settings write in the native GPUI window, and
# photograph the trailing edge where the window announces it.
#
# Records visual evidence for:
#   1. announcement-rest      (the General page, nothing refused)
#   2. announcement-raised    (the host refused it, the card at the trailing edge)
#   3. announcement-dismissed (a press on the card, the edge as it was)
#
# THE CLAIM. A request the host refuses is announced where it is read, on a
# stack at the window's trailing edge under the chrome, and a press on the card
# takes it down for good. The before arm's window raises nothing there: the
# refusal reaches the row that sent it and nowhere else, so a refusal whose
# control is under a closed sheet or a collapsed section is stated nowhere.
#
# WHY THIS ROW. `Argot Models` is a free-form array, so it takes the JSON text
# control and any valid JSON is sent as typed. An object is valid JSON and is
# not a list of model ids, so the host answers `INVALID_VALUE` over the wire it
# already answers on, with no credential, no network and no turn involved. This
# is the same trigger `desktop-settings-refusal.sh` uses, for the same reason.
#
# WHAT IS MEASURED. Two colours counted in one rectangle: the band between the
# settings page's trailing edge and the window's own, under the titlebar, which
# is where the stack draws and where nothing else does. The page is left out of
# the band on purpose -- the page states the refusal on its own row, which is a
# different surface answering a different question.
#
#   * `tint.error.fill`, the ground a refusal's card is filled with. A card
#     there fills thousands of pixels of the band; a band with no card in it
#     draws none at all.
#   * `tint.plan.fill`, the ground a card about the window's own trouble is
#     filled with. The recorder image ships neither a notification service nor
#     a sound player, so this is what the two delivery settings turn on: with
#     them off the band holds no plan ground, and with them on the window says
#     which program it could not run.
#
# Both colours come from the theme this checkout ships, so a retheme moves the
# reading with the colour.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The sheet is still between keystrokes, so
# the take carries a motion floor. Record the three arms with:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh \
#     proof/scenes/desktop-announcement.sh
#
#   SCENE_MOTION_FLOOR=4 SCENE_SETTINGS='notify.sound: on
#   notify.system: on' proof/docker/record-native.sh \
#     proof/scenes/desktop-announcement.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build of the pre-change tree:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     <commit> announcement-before
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/announcement-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-announcement.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Stack Draws, And In Which Colours ─────────────────────────────
read -r PALETTE_W TITLEBAR_H MARGIN SHEET_H COLUMN_W BODY_INSET ERROR_FILL PLAN_FILL < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
palette = tomllib.loads((root / "tokens/surface/palette.toml").read_text())
shell = tomllib.loads((root / "tokens/surface/shell.toml").read_text())
settings = tomllib.loads((root / "tokens/surface/settings.toml").read_text())
scale = tomllib.loads((root / "tokens/scale.toml").read_text())
theme = tomllib.loads((root / "themes/dark.toml").read_text())
print(
	palette["geometry"]["width_px"],
	shell["titlebar"]["height_px"],
	scale["spacing"]["s4"],
	settings["layout"]["sheet_height_px"],
	settings["layout"]["control_column_width_px"],
	scale["spacing"]["s6"],
	theme["tint"]["error"]["fill"].lstrip("#").upper(),
	theme["tint"]["plan"]["fill"].lstrip("#").upper(),
)
PY
)
PALETTE_LEFT=$(( WIN_X + (WIN_W - PALETTE_W) / 2 ))
PALETTE_RIGHT=$(( PALETTE_LEFT + PALETTE_W ))
COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
COLUMNS_CENTER_Y=$(( WIN_Y + TITLEBAR_H + COLUMNS_H / 2 ))
DEST_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( DEST_H > SHEET_H )); then DEST_H=$SHEET_H; fi
DEST_TOP=$(( COLUMNS_CENTER_Y - DEST_H / 2 ))
if (( DEST_H < 480 )); then
	abandon_take "announcement-rest" \
		"the settings page is ${DEST_H}px tall, too short to hold the row this scene types into"
fi

# The band the stack draws in: from the settings page's trailing edge to the
# window's own, under the titlebar. Stopping at the page keeps the reading off
# the refusal the page states on its own row, which is drawn in the same
# ground.
BAND_X=$(( PALETTE_RIGHT ))
BAND_W=$(( WIN_X + WIN_W - BAND_X ))
BAND_Y=$(( WIN_Y + TITLEBAR_H ))
BAND_H=260
if (( BAND_Y + BAND_H > WIN_Y + WIN_H )); then
	BAND_H=$(( WIN_Y + WIN_H - BAND_Y ))
fi
if (( BAND_W < 120 )); then
	abandon_take "announcement-rest" \
		"the band between the settings page and the window's trailing edge is ${BAND_W}px, too narrow to hold a card"
fi
BAND_GEOM="${BAND_W}x${BAND_H}+${BAND_X}+${BAND_Y}"

# The row this scene types into, reached the way desktop-settings-refusal.sh
# reaches it: the page lists every setting the host reports in key order, and
# eight wheel steps bring `argot.encode.models` to the top of the list.
SETTINGS_SCROLL_X=$(( PALETTE_LEFT + PALETTE_W / 2 ))
FIELD_X=$(( PALETTE_LEFT + PALETTE_W - BODY_INSET - COLUMN_W / 2 ))
FIELD_Y=$(( DEST_TOP + 88 ))
VALUE_GEOM="${COLUMN_W}x32+$(( FIELD_X - COLUMN_W / 2 ))+$(( FIELD_Y - 16 ))"

# A card is the stack's authored width by two lines of text and its padding,
# and the band sees most of that width. The floor is well under what one card
# fills and well over the antialiased edge of a rounded corner.
CARD_FILL_MIN=4000
QUIET_MAX=200
# `[]` at rest is two glyphs of a 13px ramp; the object typed over it is
# thirty. The rise is what says the press reached a field that takes text.
FIELD_INK_RISE=25

# Where a press on the card lands: the top card of the stack, which is drawn
# at the trailing edge a margin under the chrome. The card is 320px wide and
# right-anchored, so its centre is a margin plus half a card in from the
# window's trailing edge, and its first line sits about thirty rows down.
CARD_CENTRE_X=$(( WIN_X + WIN_W - MARGIN - 160 ))
CARD_CENTRE_Y=$(( BAND_Y + MARGIN + 30 ))

fill_pixels() { # <shot> <geometry> <hex> -> count of pixels of exactly that colour
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local dump="${TMPDIR}/frame-compare/$1-$3.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "${png}" -crop "$2" +repage txt:- >"${dump}"
	python3 - "${dump}" "$3" <<'PY'
import re
import sys

pixel = re.compile(r"^\d+,\d+: \([^)]*\)\s+#([0-9A-Fa-f]+)")
wanted = sys.argv[2]
counted = 0
with open(sys.argv[1], encoding="ascii") as dump:
	for line in dump:
		match = pixel.match(line)
		if match and match.group(1).upper()[:6] == wanted[:6]:
			counted += 1
print(counted)
PY
}

lit_pixels() { # <shot> <geometry> -> count of lit pixels in that rectangle
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" -crop "$2" +repage \
		-colorspace Gray -threshold 40% \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "value-ink-countable" \
				"counting the value column in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

echo "scene: reading ${BAND_GEOM}, the band between the settings page and the window's trailing edge" >&2

# ─── Open The General Page ───────────────────────────────────────────────────
k "ctrl+k"
pause 0.3
t "settings"
pause 0.3
k "Return"
pause 0.3
k "Return"
pause 2.0

# ─── Scroll To The Row, With Nothing Refused ─────────────────────────────────
move_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
wheel_down 8
pause 0.6
shot announcement-rest
REST_ERROR="$(fill_pixels announcement-rest "${BAND_GEOM}" "${ERROR_FILL}")"
REST_PLAN="$(fill_pixels announcement-rest "${BAND_GEOM}" "${PLAN_FILL}")"
if [ "${REST_ERROR}" -gt "${QUIET_MAX}" ]; then
	abandon_take "announcement-rest" \
		"the trailing edge already carried ${REST_ERROR} pixels of error ground before anything was refused"
fi
if [ "${REST_PLAN}" -gt "${QUIET_MAX}" ]; then
	abandon_take "announcement-rest" \
		"the trailing edge already carried ${REST_PLAN} pixels of plan ground before anything was announced"
fi

# ─── Type A Value The Host Will Not Take ─────────────────────────────────────
VALUE_REST="$(lit_pixels announcement-rest "${VALUE_GEOM}")"
move_px "${FIELD_X}" "${FIELD_Y}"
click
pause 0.4
k "ctrl+a"
k "BackSpace"
pause 0.2
t '{"model":"local/qwen2.5-1.5b"}'
pause 0.8
shot announcement-typed
VALUE_TYPED="$(lit_pixels announcement-typed "${VALUE_GEOM}")"
if [ "${VALUE_TYPED}" -lt $(( VALUE_REST + FIELD_INK_RISE )) ]; then
	abandon_take "announcement-typed" \
		"the press reached no field that takes text: value ink ${VALUE_REST} -> ${VALUE_TYPED}, under a rise of ${FIELD_INK_RISE}"
fi

# ─── Commit It And Let The Host Refuse ───────────────────────────────────────
k "Return"
pause 2.0
shot announcement-raised
RAISED_ERROR="$(fill_pixels announcement-raised "${BAND_GEOM}" "${ERROR_FILL}")"
RAISED_PLAN="$(fill_pixels announcement-raised "${BAND_GEOM}" "${PLAN_FILL}")"

# ─── Read The Card ───────────────────────────────────────────────────────────
# A press on the top card takes it down and clears what raised it, so the next
# frame the window projects agrees with the frame the press left.
move_px "${CARD_CENTRE_X}" "${CARD_CENTRE_Y}"
pause 0.4
click
pause 1.2
shot announcement-dismissed
GONE_ERROR="$(fill_pixels announcement-dismissed "${BAND_GEOM}" "${ERROR_FILL}")"

DELIVERY_ON="off"
case "${SCENE_SETTINGS:-}" in
	*notify.sound*on* | *notify.system*on*) DELIVERY_ON="on" ;;
esac

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${RAISED_ERROR}" -ge "${CARD_FILL_MIN}" ]; then
		abandon_take "announcement-raised" \
			"the baseline already announced the refusal at the trailing edge: ${RAISED_ERROR} pixels of error ground"
	fi
	echo "scene: before arm -- trailing edge error ground ${REST_ERROR} -> ${RAISED_ERROR} -> ${GONE_ERROR}: the refusal was stated on the row that sent it and nowhere else" >&2
else
	if [ "${RAISED_ERROR}" -lt "${CARD_FILL_MIN}" ]; then
		abandon_take "announcement-raised" \
			"nothing was announced: ${RAISED_ERROR} pixels of error ground at the trailing edge, under ${CARD_FILL_MIN}"
	fi
	if [ "${GONE_ERROR}" -gt "${QUIET_MAX}" ]; then
		abandon_take "announcement-dismissed" \
			"the press left ${GONE_ERROR} pixels of error ground at the trailing edge: the card the press took down came back"
	fi
	if [ "${DELIVERY_ON}" = "on" ]; then
		if [ "${RAISED_PLAN}" -lt "${CARD_FILL_MIN}" ]; then
			abandon_take "announcement-raised" \
				"the delivery settings are on and the window said nothing about the notifier it could not run: ${RAISED_PLAN} pixels of plan ground, under ${CARD_FILL_MIN}"
		fi
		echo "scene: on arm -- trailing edge error ground ${REST_ERROR} -> ${RAISED_ERROR} -> ${GONE_ERROR}, plan ground ${REST_PLAN} -> ${RAISED_PLAN}: the announcement was carried, and the window said which program it could not run" >&2
	else
		if [ "${RAISED_PLAN}" -gt "${QUIET_MAX}" ]; then
			abandon_take "announcement-raised" \
				"both delivery settings are off and the window announced a delivery anyway: ${RAISED_PLAN} pixels of plan ground"
		fi
		echo "scene: off arm -- trailing edge error ground ${REST_ERROR} -> ${RAISED_ERROR} -> ${GONE_ERROR}, plan ground ${REST_PLAN} -> ${RAISED_PLAN}: the announcement went on the stack and nowhere else" >&2
	fi
fi
