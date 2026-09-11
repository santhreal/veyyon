#!/usr/bin/env bash
# Open a session row's context menu and photograph the row the pointer is on.
#
# Records visual evidence for:
#   1. the-row-under-the-pointer-is-lit (the menu, with one row filled)
#
# THE DIFFERENTIAL. A row menu is eight words one row apart, with no selection
# and no keyboard: the pointer is the only thing that states which answer the
# next click takes. The before arm draws every row on the same ground, so the
# menu looks identical wherever the pointer is. The after arm fills the row
# under the pointer with the hairline fill every row surface in the product
# lights with. Both arms open the same menu on the same card and park the
# pointer on the same row, so the only thing that changed between the frames is
# whether the menu states where the click will land.
#
# WHAT IS MEASURED. Not the whole window, which carries a clock in its footer
# and an age on every card: two bands inside the menu itself, one across the
# row the pointer is on and one across the row below it, read before and after
# the pointer moves onto the row. The after arm requires the pointer's own row
# to repaint at least LIT_MIN_PIXELS of its band and the row below it to stay
# under QUIET_MAX_PIXELS, so a fill that covers the whole menu fails the take
# as loudly as no fill at all. The before arm requires the row to stay under
# QUIET_MAX_PIXELS, so an arm recorded from the wrong build abandons the take
# instead of publishing a pair of one state.
#
# THE POINTER IS NOT IN THE FRAME. The recorder's captures carry no cursor, so
# the pixels that separate the arms are the fill and nothing else.
#
# WHERE THE CARD AND THE ROWS ARE IS READ, NOT COUNTED. The rail draws whatever
# sections its sessions come to, so a card position counted down from the
# rail's top lands a section out, and a row position counted down from the
# menu's corner lands on its padding. The card is found by its own fill and the
# rows are the bands of ink inside the menu's ground, both read out of the
# screen this take is of.
#
# NOT RECORDED HERE: that a refused row stays dark under the pointer, which
# needs an answer held in flight for as long as a frame takes and is swept over
# every row of every menu by
# `crates/veyyon-desktop-surface/tests/a-menu-row-lights-only-where-a-press-answers.rs`,
# and the answer a press on the lit row gives, which is
# `a-menu-row-the-window-draws-answers-the-click-it-names`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-menu-hover.sh
#
# and its other arm, whose change is in the desktop binary, so the arm names a
# build of HEAD with the hover fill reversed out of it:
#
#   .internal/build-commit-before.py --holdback .internal/menu-hover.patch menu-hover
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/menu-hover/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-menu-hover.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── What A Card Measures ────────────────────────────────────────────────────
# Read from the tokens this checkout ships rather than restated as literals, so
# a retuned row height moves the rectangles the frames are read over.
read -r CARD_PX FOOTER_PX CONTENT_INSET NAV_HEADER_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())

gap_below = scale["spacing"][queue["section_layout"]["gap_below"]]
content_inset = scale["spacing"][queue["insets"]["content_inset"]]

print(
    int(queue["row_heights"]["card_px"]),
    int(queue["footer"]["height_px"]),
    int(content_inset),
    int(content_inset + 32 + gap_below),
)
PY
)
if [ -z "${NAV_HEADER_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read queue layout tokens"
fi

if [ "${WIN_W}" -le 800 ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px has no queue rail"
fi

RAIL_LEFT=$(( WIN_X + CONTENT_INSET ))
RAIL_LIST_TOP=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
RAIL_LIST_BOTTOM=$(( WIN_Y + WIN_H - FOOTER_PX ))
CARD_X=$(( WIN_X + RAIL_W / 2 ))
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

MENU_MIN_PIXELS=2000
MENU_ITEMS=8
# `Open` is the row the pointer is parked on and `Park` is the row under it.
# The first row is the one item no gate decides, so it is the row that is
# offered in every state the rail can be in.
LIT_ITEM=1
QUIET_ITEM=2
# The band each row is read over: wide enough to sit inside the menu's ground
# on both sides of the label, tall enough to cover the row's fill, and centred
# on the ink the row was measured at.
BAND_W=60
BAND_H=20
# The hairline fill covers the whole row, so a band of BAND_W x BAND_H over it
# repaints every pixel that is not glyph. A floor a fifth of that band still
# separates it from the nothing an unlit row does.
LIT_MIN_PIXELS=240
QUIET_MAX_PIXELS=20

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

selected_card() { # <frame> -> <top> <left>
	python3 "${MEASURE}" selected-card "$1" "${RAIL_LEFT}" "${RAIL_LIST_TOP}" \
		"$(( RAIL_W - 2 * CONTENT_INSET ))" "$(( RAIL_LIST_BOTTOM - RAIL_LIST_TOP ))" "${CARD_PX}"
}

menu_item() { # <frame-with-menu> <origin-x> <origin-y> <item> -> <y> <x> <strength>
	python3 "${MEASURE}" menu-rows "$1" "$2" "$3" "${MENU_ITEMS}" "$4" "$(( WIN_Y + WIN_H ))"
}

band_of() { # <centre-x> <centre-y> -> <crop>
	echo "${BAND_W}x${BAND_H}+$(( $1 - BAND_W / 2 ))+$(( $2 - BAND_H / 2 ))"
}

# ─── 1. Find The Card The Window Is On ───────────────────────────────────────
# Park the pointer on the composer first so no row carries hover styling while
# the card is read.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.0
RAIL_AT_REST="${PROBE_DIR}/hover-rail-at-rest.png"
probe_frame "${RAIL_AT_REST}"
read -r CARD_TOP FILL_LEFT < <(selected_card "${RAIL_AT_REST}") || \
	abandon_take "the-session-on-screen-is-drawn-as-selected" \
		"the rail's selected card was not readable out of the screen the menu is opened on"
echo "scene: the window is on the card at ${CARD_TOP}px, filled from ${FILL_LEFT}px" >&2

# ─── 2. Open That Row's Context Menu ─────────────────────────────────────────
# The menu's corner lands at the pointer, which is outside every row of it, so
# the frame it opens in is the menu with no row lit.
MENU_ORIGIN_Y=$(( CARD_TOP + CARD_PX / 2 ))
ROW_HOVERED="${PROBE_DIR}/hover-row-hovered.png"
MENU_OPEN="${PROBE_DIR}/hover-row-menu.png"

move_px "${CARD_X}" "${MENU_ORIGIN_Y}"
pause 0.5
probe_frame "${ROW_HOVERED}"
right_click
pause 1.0
probe_frame "${MENU_OPEN}"
MENU_PX="$(frames_differ_pixels_at "${ROW_HOVERED}" "${MENU_OPEN}" "${WINDOW_CROP}")"
if [ "${MENU_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "the-row-menu-opened" \
		"the right-click on the card at ${MENU_ORIGIN_Y}px changed ${MENU_PX}px of the window, under the ${MENU_MIN_PIXELS} a menu draws"
fi
echo "scene: the menu repainted ${MENU_PX}px of the window" >&2

# ─── 3. Read The Row The Pointer Will Be Parked On ───────────────────────────
# Both rows are read out of the unlit menu, because a row is found by the ink
# it carries on the menu's ground and the fill this take is of changes that
# ground under one row.
read -r LIT_Y LIT_X _ < <(
	menu_item "${MENU_OPEN}" "${CARD_X}" "${MENU_ORIGIN_Y}" "${LIT_ITEM}"
) || abandon_take "the-menu-rows-are-drawn" \
	"the ${MENU_ITEMS} rows of the row menu were not readable out of the frame it opened in, so the arm does not draw the menu this pair is of"
read -r QUIET_Y QUIET_X _ < <(
	menu_item "${MENU_OPEN}" "${CARD_X}" "${MENU_ORIGIN_Y}" "${QUIET_ITEM}"
) || abandon_take "the-menu-rows-are-drawn" \
	"the row under the one the pointer is parked on was not readable out of the frame the menu opened in"
LIT_BAND="$(band_of "${LIT_X}" "${LIT_Y}")"
QUIET_BAND="$(band_of "${QUIET_X}" "${QUIET_Y}")"
echo "scene: the pointer's row is drawn at ${LIT_X}+${LIT_Y}, the row below it at ${QUIET_X}+${QUIET_Y}" >&2

# ─── 4. Park The Pointer On That Row ─────────────────────────────────────────
MENU_LIT="${PROBE_DIR}/hover-row-lit.png"
move_px "${LIT_X}" "${LIT_Y}"
pause 0.8
probe_frame "${MENU_LIT}"
LIT_PX="$(frames_differ_pixels_at "${MENU_OPEN}" "${MENU_LIT}" "${LIT_BAND}")"
QUIET_PX="$(frames_differ_pixels_at "${MENU_OPEN}" "${MENU_LIT}" "${QUIET_BAND}")"
echo "scene: the pointer's row repainted ${LIT_PX}px of its band, the row below it ${QUIET_PX}px" >&2

case "${ARM}" in
	after)
		if [ "${LIT_PX}" -lt "${LIT_MIN_PIXELS}" ]; then
			abandon_take "the-row-under-the-pointer-lights" \
				"the row the pointer is on repainted ${LIT_PX}px of its band, under the ${LIT_MIN_PIXELS} the hover fill covers, so this arm still draws every row on one ground"
		fi
		if [ "${QUIET_PX}" -gt "${QUIET_MAX_PIXELS}" ]; then
			abandon_take "only-the-row-under-the-pointer-lights" \
				"the row below the pointer repainted ${QUIET_PX}px of its band, over the ${QUIET_MAX_PIXELS} an untouched row draws, so the fill covers more than the row the click will land on"
		fi
		;;
	before)
		if [ "${LIT_PX}" -gt "${QUIET_MAX_PIXELS}" ]; then
			abandon_take "the-row-under-the-pointer-stays-dark" \
				"the row the pointer is on repainted ${LIT_PX}px of its band, over the ${QUIET_MAX_PIXELS} an unlit row draws, so this arm is not the state the fix changed"
		fi
		;;
	*)
		abandon_take "the-arm-is-one-of-the-two" "SCENE_ARM=${ARM} names neither arm"
		;;
esac

# ─── 5. Photograph The Menu Under The Pointer ────────────────────────────────
shot the-row-under-the-pointer-is-lit

FRAME="${SCENE_OUT}/${SCENE_NAME}-the-row-under-the-pointer-is-lit.png"
SHOT_PX="$(frames_differ_pixels_at "${MENU_OPEN}" "${FRAME}" "${LIT_BAND}")"
if [ "${SHOT_PX}" != "${LIT_PX}" ]; then
	abandon_take "the-photographed-menu-is-the-measured-one" \
		"the row the pointer is on repainted ${LIT_PX}px of its band when it was measured and ${SHOT_PX}px in the frame that was published"
fi
echo "scene: the published frame draws the pointer's row over ${SHOT_PX}px of its band" >&2

# ─── 6. Leave The Menu Closed ────────────────────────────────────────────────
# Escape rather than a click, so the take ends without answering the row the
# pointer is parked on.
k Escape
pause 1.0
MENU_CLOSED="${PROBE_DIR}/hover-row-menu-closed.png"
probe_frame "${MENU_CLOSED}"
GONE_PX="$(frames_differ_pixels_at "${MENU_LIT}" "${MENU_CLOSED}" "${WINDOW_CROP}")"
if [ "${GONE_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "the-menu-closes-on-escape" \
		"Escape changed ${GONE_PX}px of the window, under the ${MENU_MIN_PIXELS} the menu covers, so the menu the take opened is still standing"
fi
echo "scene: Escape closed the menu, repainting ${GONE_PX}px" >&2
