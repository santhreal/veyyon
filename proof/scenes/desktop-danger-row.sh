#!/usr/bin/env bash
# Open a session row's context menu and photograph the one row in it that
# destroys something.
#
# Records visual evidence for:
#   1. the-row-menu-marks-what-it-destroys (the menu, with `Delete` in it)
#
# THE DIFFERENTIAL. A menu row is drawn in one of three inks: an offered row in
# the foreground, a refused row in muted, and a destructive row in the error
# tint. The before arm draws the destructive row in the tint's FILL, which is
# the dark red a badge is filled with, so `Delete` is set at 1.12:1 against the
# float ground the menu itself fills with and reads as an empty row. The after
# arm draws it in the tint's INK, which is what the tint pairs with that fill,
# at 8.35:1. Both arms open the same menu on the same card, so the only thing
# that changed between the frames is whether the row that deletes a session can
# be read before it is clicked.
#
# WHAT IS MEASURED. Not the whole window, which carries a clock in its footer
# and an age on every card: the menu's own rows, read out of the frame it
# opened in. The menu is found by the ground colour it fills, its rows are the
# bands of ink inside that box, and each band is scored against the menu's
# first row, which is the one item no gate decides. `Delete` is the eighth row.
# The after arm requires it inked to at least READABLE_MIN_STRENGTH of that
# reference and the before arm requires it under UNREADABLE_MAX_STRENGTH, so an
# arm recorded from the wrong build abandons the take instead of publishing a
# pair of one state.
#
# THE ROW IS THERE IN BOTH ARMS. The before arm is not a menu with seven rows.
# Both arms require all eight, so the defect being photographed is legibility
# and not a missing row: the eighth band is found in both, and the before arm
# fails the take if that band reads as brightly as an offered one.
#
# WHERE THE CARD IS IS READ, NOT COUNTED. The rail draws whatever sections its
# sessions come to, so a card position counted down from the rail's top lands a
# section out. The card the window is on is found by its own fill, and the menu
# is opened on it.
#
# NOT RECORDED HERE: the ratio itself, which is measured off the rendered frame
# for every tone a row resolves to by
# `crates/veyyon-desktop-kit/tests/a-row-a-menu-draws-is-readable-on-the-ground-it-draws-on.rs`,
# and the signal menu's own destructive row, `Kill (SIGKILL)`, which is the same
# ink through the same renderer.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-danger-row.sh
#
# and its other arm, whose change is in the desktop binary, so the arm names a
# build of HEAD with the ink change reversed out of it:
#
#   .internal/build-commit-before.py --holdback .internal/danger-ink.patch danger-ink
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/danger-ink/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-danger-row.sh
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
# `Open`, `Park`, `Defer`, `Branch`, `Export`, `Compact`, `Handoff`, `Delete`.
DELETE_ITEM=8
# What share of the menu's first row a destructive row is inked to once it is
# drawn in the error tint's ink. Greyscale luminance puts that ink at 70% of the
# foreground an offered row is set in, and the fill the before arm uses at under
# 10%, so the two arms are separated by a wide margin either side of the gap.
READABLE_MIN_STRENGTH=40
UNREADABLE_MAX_STRENGTH=20

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

# ─── 1. Find The Card The Window Is On ───────────────────────────────────────
# Park the pointer on the composer first so no row carries hover styling while
# the card is read.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.0
RAIL_AT_REST="${PROBE_DIR}/danger-rail-at-rest.png"
probe_frame "${RAIL_AT_REST}"
read -r CARD_TOP FILL_LEFT < <(selected_card "${RAIL_AT_REST}") || \
	abandon_take "the-session-on-screen-is-drawn-as-selected" \
		"the rail's selected card was not readable out of the screen the menu is opened on"
echo "scene: the window is on the card at ${CARD_TOP}px, filled from ${FILL_LEFT}px" >&2

# ─── 2. Open That Row's Context Menu ─────────────────────────────────────────
MENU_ORIGIN_Y=$(( CARD_TOP + CARD_PX / 2 ))
ROW_HOVERED="${PROBE_DIR}/danger-row-hovered.png"
MENU_OPEN="${PROBE_DIR}/danger-row-menu.png"

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

# ─── 3. Read The Row That Destroys Something ─────────────────────────────────
read -r DELETE_Y DELETE_X DELETE_STRENGTH < <(
	menu_item "${MENU_OPEN}" "${CARD_X}" "${MENU_ORIGIN_Y}" "${DELETE_ITEM}"
) || abandon_take "the-destructive-row-is-drawn" \
	"the ${MENU_ITEMS} rows of the row menu were not readable out of the frame it opened in, so the arm does not draw the menu this pair is of"
echo "scene: the Delete row is drawn at ${DELETE_X}+${DELETE_Y}, inked to ${DELETE_STRENGTH}% of the menu's first row" >&2

case "${ARM}" in
	after)
		if [ "${DELETE_STRENGTH}" -lt "${READABLE_MIN_STRENGTH}" ]; then
			abandon_take "the-destructive-row-is-readable" \
				"the Delete row is inked to ${DELETE_STRENGTH}% of the menu's first row, under the ${READABLE_MIN_STRENGTH} the error tint's ink comes to, so this arm is still drawing the row in the tint's fill"
		fi
		;;
	before)
		if [ "${DELETE_STRENGTH}" -gt "${UNREADABLE_MAX_STRENGTH}" ]; then
			abandon_take "the-destructive-row-is-unreadable" \
				"the Delete row is inked to ${DELETE_STRENGTH}% of the menu's first row, over the ${UNREADABLE_MAX_STRENGTH} the error tint's fill comes to, so this arm is not the state the fix changed"
		fi
		;;
	*)
		abandon_take "the-arm-is-one-of-the-two" "SCENE_ARM=${ARM} names neither arm"
		;;
esac

# ─── 4. Photograph The Menu ──────────────────────────────────────────────────
# The pointer is parked off the menu, on the card the menu was opened from, so
# no row carries hover styling in either frame. Nothing in the kit's menu draws
# a hover fill today, and a frame taken with the pointer on a row would start
# depending on that.
move_px "${CARD_X}" "${MENU_ORIGIN_Y}"
pause 0.6
shot the-row-menu-marks-what-it-destroys

FRAME="${SCENE_OUT}/${SCENE_NAME}-the-row-menu-marks-what-it-destroys.png"
read -r SHOT_Y SHOT_X SHOT_STRENGTH < <(
	menu_item "${FRAME}" "${CARD_X}" "${MENU_ORIGIN_Y}" "${DELETE_ITEM}"
) || abandon_take "the-photographed-menu-is-the-measured-one" \
	"the ${MENU_ITEMS} rows of the row menu were not readable out of the frame that was published"
if [ "${SHOT_Y}" != "${DELETE_Y}" ] || [ "${SHOT_X}" != "${DELETE_X}" ]; then
	abandon_take "the-photographed-menu-is-the-measured-one" \
		"the Delete row measured at ${DELETE_X}+${DELETE_Y} is drawn at ${SHOT_X}+${SHOT_Y} in the frame that was published"
fi
echo "scene: the published frame draws the Delete row at ${SHOT_STRENGTH}% of the menu's first row" >&2

# ─── 5. Leave The Menu Closed ────────────────────────────────────────────────
# Escape rather than a click, so the take ends without answering anything the
# menu offered.
k Escape
pause 1.0
MENU_CLOSED="${PROBE_DIR}/danger-row-menu-closed.png"
probe_frame "${MENU_CLOSED}"
GONE_PX="$(frames_differ_pixels_at "${MENU_OPEN}" "${MENU_CLOSED}" "${WINDOW_CROP}")"
if [ "${GONE_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "the-menu-closes-on-escape" \
		"Escape changed ${GONE_PX}px of the window, under the ${MENU_MIN_PIXELS} the menu covers, so the menu the take opened is still standing"
fi
echo "scene: Escape closed the menu, repainting ${GONE_PX}px" >&2
