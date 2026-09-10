#!/usr/bin/env bash
# Enter and leave plan mode from the native GPUI window, and read the mode the
# session runs in off the composer's own footer.
#
# Records visual evidence for:
#   1. mode-rows     (the command list, filtered to the two rows that set a mode)
#   2. mode-stated   (the same window in plan mode, with the footer stating it)
#   3. mode-left     (the footer one command later, stating no mode)
#
# THE CLAIM. A mode is state the window states. `/plan` enters plan mode on the
# live session, the host restates the session header, and the footer draws the
# mode beside the model as a chip filled with `tint.plan`; `/plan off` leaves,
# and the chip goes with the mode. Both are reached from the command list,
# which is where every other session command is reached.
#
# In the other arm the window could not set a mode at all: the same query
# reaches the list and lists whatever else that word matches, with no row for a
# mode among them, and the footer states no mode however many of them are run.
# Plan mode was reachable there only by having been started in it, which no
# press could enter and no press could leave.
#
# Both arms are seeded the same way:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-session-mode.sh
#
# and the other arm against a build from before the mode was settable. That
# change is inside the executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-session-mode.sh
#
# WHAT IS MEASURED. One authored colour and two rectangles of the window.
#   * `tint.plan.fill` is the chip's own ground, and nothing else in the
#     composer's footer paints it, so an exact count of that colour inside the
#     footer row is a reading of whether the mode is stated there. Exact rather
#     than fuzzed: `role.hairline` is within a few percent of it and draws
#     every border in the band, so a fuzzed count would report a card edge as a
#     mode.
#   * The list's own surface is compared against itself under a query no
#     command answers, which reads whether the list is open and filtered to
#     the query at all. WHICH rows it offers is not a colour: that is read off
#     frame 1, where one arm lists the two rows that set a mode and the other
#     lists whatever else the word reaches. So the reading bounds the frame and
#     the chip below carries the claim.
#
# The colour comes from the theme this checkout ships, so a retheme moves the
# reading with it.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

THEME="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"

# The chip's ground, read from the theme rather than restated as a literal.
CHIP_FILL="$(sed -n '/^\[tint.plan\]/,/^\[/ s/^fill = "\(#[0-9a-fA-F]\{6\}\)".*/\1/p' \
	"${THEME}" | head -1)"
if [ -z "${CHIP_FILL}" ]; then
	abandon_take "the-chip-colour-is-authored" "no [tint.plan] fill in ${THEME}"
fi
echo "scene: a mode chip is filled with ${CHIP_FILL}" >&2

# ─── The Footer Row The Mode Is Stated In ────────────────────────────────────
# The footer is the last row inside the composer card: the mode chip and the
# model chip on its leading side, the turn's control on its trailing one. The
# row's lower edge is the card's own, less the inset the card keeps under it,
# and the row is one control tall. Reading the row and not the whole band keeps
# a transcript block, an attached card and the run bar out of the count.
FOOTER_ROW_H=32
FOOTER_BOTTOM=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM ))
FOOTER_TOP=$(( FOOTER_BOTTOM - FOOTER_ROW_H ))
FOOTER_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H ))
FOOTER_W=$(( COMPOSER_CARD_W - 2 * CARD_PAD_H ))
if (( FOOTER_TOP <= WIN_Y || FOOTER_W < 200 )); then
	abandon_take "the-footer-row-is-locatable" \
		"the derived footer row ${FOOTER_W}x${FOOTER_ROW_H}+${FOOTER_X}+${FOOTER_TOP} is not inside the window"
fi
FOOTER_CROP="${FOOTER_W}x${FOOTER_ROW_H}+${FOOTER_X}+${FOOTER_TOP}"
echo "scene: the mode is stated in ${FOOTER_CROP}" >&2

# The surface the command list draws over, which is everything between the
# titlebar and the composer band.
LIST_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"

# A chip is a filled pill around a word: at the authored micro ramp it is some
# hundreds of pixels of ground once the letters are taken out of it. A floor of
# 300 is under that and far above the nothing a border contributes, since the
# count is exact.
CHIP_PIXELS_MIN=300
# A row of the command list is a line of prose on its own ground, and the list
# redraws its whole listing for a query, so a filtered list differs from an
# unanswered one by thousands of pixels. The floor is what one row draws.
ROWS_PIXELS_MIN=400

# Pixels of the chip's own ground inside a crop, matched exactly.
chip_pixels() { # <png> <crop> -> pixels of tint.plan fill inside the crop
	local counted
	counted="$(magick "$1" -crop "$2" +repage \
		-fill white -opaque "${CHIP_FILL}" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "the-chip-is-countable" \
				"counting ${CHIP_FILL} in $(basename "$1") reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

# Run one command from the list, by the query that names it.
run_command() { # <query>
	k "ctrl+k"
	pause 0.8
	t "$1"
	pause 0.8
	k "Return"
	pause 1.5
}

# ─── The Composer, With Nothing In It And No Mode Set ────────────────────────
# The preamble leaves a slash in the editor from the palette it opened, so the
# draft is cleared first: a mode is read off the footer, and a draft moves the
# footer's own controls.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.6

# The pointer rests on the editor for every reading below, so the model chip
# beside the mode is never under a hover fill in one frame and not in another.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.4
AT_REST="${SCENE_RUNTIME_DIR}/footer-at-rest.png"
probe_frame "${AT_REST}"
REST_CHIP="$(chip_pixels "${AT_REST}" "${FOOTER_CROP}")"
echo "scene: at rest the footer carries ${REST_CHIP}px of chip ground" >&2
if (( REST_CHIP >= CHIP_PIXELS_MIN )); then
	abandon_take "no-mode-is-stated-at-rest" \
		"the footer carries ${REST_CHIP}px of ${CHIP_FILL} before any mode was set, so the reading below cannot tell a mode from the window's own ground"
fi

# ─── The Rows That Set A Mode ────────────────────────────────────────────────
# The list under a query nothing answers, which is what the query for a mode is
# read against.
k "ctrl+k"
pause 0.8
t "zzqqxx"
pause 0.8
EMPTY_LIST="${SCENE_RUNTIME_DIR}/list-no-match.png"
probe_frame "${EMPTY_LIST}"
k "Escape"
pause 0.6

k "ctrl+k"
pause 0.8
t "plan"
pause 0.8
shot mode-rows
ROWS_FRAME="${SCENE_OUT}/${SCENE_NAME}-mode-rows.png"
ROWS_PX="$(frames_differ_pixels_at "${EMPTY_LIST}" "${ROWS_FRAME}" "${LIST_CROP}")"
echo "scene: the query for a mode brought ${ROWS_PX} pixels of rows up" >&2

# ─── Entering The Mode, From That Row ────────────────────────────────────────
k "Return"
pause 1.5
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.6
shot mode-stated
STATED_FRAME="${SCENE_OUT}/${SCENE_NAME}-mode-stated.png"
STATED_CHIP="$(chip_pixels "${STATED_FRAME}" "${FOOTER_CROP}")"
echo "scene: in the mode the footer carries ${STATED_CHIP}px of chip ground" >&2

# ─── Leaving It, From The Row Beside It ──────────────────────────────────────
run_command "plan off"
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.6
shot mode-left
LEFT_FRAME="${SCENE_OUT}/${SCENE_NAME}-mode-left.png"
LEFT_CHIP="$(chip_pixels "${LEFT_FRAME}" "${FOOTER_CROP}")"
echo "scene: after leaving, the footer carries ${LEFT_CHIP}px of chip ground" >&2

# The list answered the query in both arms -- what it answered WITH is frame
# 1's to state -- so this reading is taken once and not per arm.
if (( ROWS_PX < ROWS_PIXELS_MIN )); then
	abandon_take "the-list-answered-the-query" \
		"the list changed ${ROWS_PX} pixels between a query nothing answers and the query for a mode, under the ${ROWS_PIXELS_MIN} one row draws, so the list was not open or not filtered"
fi

case "${ARM}" in
	after)
		if (( STATED_CHIP < CHIP_PIXELS_MIN )); then
			abandon_take "the-mode-is-stated" \
				"the footer carries ${STATED_CHIP}px of ${CHIP_FILL} after the mode was entered, under the ${CHIP_PIXELS_MIN} a chip fills, so the mode reached no chip"
		fi
		if (( LEFT_CHIP >= CHIP_PIXELS_MIN )); then
			abandon_take "the-mode-was-left" \
				"the footer still carries ${LEFT_CHIP}px of ${CHIP_FILL} after the mode was left, so the chip outlived the mode"
		fi
		;;
	before)
		if (( STATED_CHIP >= CHIP_PIXELS_MIN )); then
			abandon_take "no-mode-is-stated" \
				"the footer carries ${STATED_CHIP}px of ${CHIP_FILL} in a build that cannot set a mode"
		fi
		;;
	*)
		abandon_take "the-arm-is-known" "SCENE_ARM was '${ARM}', which is neither after nor before"
		;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is the command list under one query, offering the two rows that set a
# mode: two rows rather than one that toggles, so a press has one outcome.
#
# Frame 2 is the session in plan mode, one press later, with the footer stating
# it beside the model. The mode came back from the host on the session's own
# header, so what is drawn is what the agent is running under rather than what
# the window asked for.
#
# Frame 3 is the footer after the row beside it was run. Here the mode is gone
# and so is the chip. There the footer is the frame it always was: no row set a
# mode, so none was ever stated.
#
# WHAT IS NOT HERE. What plan mode does to the agent -- the read-only working
# tree and the plan the turn is told to write -- which is
# packages/coding-agent/test/gui-host/a-mode-the-operator-set-is-the-mode-the-agent-runs-in.test.ts;
# the refusals, which draw no frame of their own; and the modes the agent's own
# tools enter, which no row here sets.
