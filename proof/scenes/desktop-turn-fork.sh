#!/usr/bin/env bash
# Fork a session at the turn the operator is looking at, and read which prompt
# the fork handed back.
#
# Records visual evidence for:
#   1. the-session-holds-two-prompts (both prompts sent and answered)
#   2. the-turn-offers-a-fork        (the first prompt's own menu)
#   3. the-fork-hands-that-turn-back (one press later, in the composer)
#
# THE CLAIM. A branch is cut where the operator is reading. The host forks at
# whatever entry it is given and the window could name exactly one of them --
# the last prompt on the branch -- so a session read back several turns and
# forked from there was unreachable: taking a different road from an earlier
# prompt meant copying its words out and opening a session that shared none of
# its history. A turn's own menu now offers `Branch from here`, and the fork it
# cuts keeps the entries before that turn and hands that turn's prompt to the
# composer.
#
# In the other arm the same press on the same turn offers `Copy` and nothing
# else, so the only fork the window has is the rail's, which is taken here to
# show what it answers with: the session's last prompt, which is not the turn
# that was pressed. Both arms fork, and the difference is where.
#
# Both arms are seeded the same way:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-turn-fork.sh
#
# and the other arm against a build from before a turn could carry a fork. That
# change is inside the executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-turn-fork.sh
#
# WHAT MAKES THE READING EXACT. Both prompts are this scene's own sentences,
# and each is photographed in the editor as it is typed. The prompt the fork
# hands back is then read against both rectangles: it must be the same drawing
# as the first prompt and a different drawing from the second. A fork that
# answered with the transcript's end lands inside the second reading and far
# outside the first, which is the whole difference between the arms.
#
# WHERE THE TURN AND THE ROWS ARE IS READ, NOT COUNTED. The first prompt's turn
# is found by the fill the transcript draws an operator's turn on, named as the
# first of the two such boxes the column holds, so a session that drew one
# prompt or three abandons the take rather than aiming at whichever came first.
# The menu is then found by the fill a floated surface is drawn on and its rows
# by the bands of ink inside it, named as two rows here and one in the other
# arm, so a menu that grew or lost a row abandons the take rather than clicking
# whichever band came second. A transcript is anchored to its foot, so a
# counted aim at either would land in the empty space a short session leaves
# above it.
#
# NOT RECORDED HERE: which entry a turn index resolves to and the prompt kept
# for it, which are
# `crates/veyyon-desktop/tests/a-fork-can-be-cut-at-a-turn-other-than-the-last.rs`
# over every turn of a seeded transcript; the menu that offers the row, which is
# `crates/veyyon-desktop-surface/tests/a-fork-is-offered-at-the-turn-that-can-carry-one.rs`;
# and the host's own fork at a named entry, which is
# `packages/coding-agent/test/gui-host/a-branch-forks-at-the-entry-the-desktop-named.test.ts`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# ─── What A Card And The Rail Measure ────────────────────────────────────────
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

TRANSCRIPT_TOP=$(( WIN_Y + TITLEBAR_H ))
TRANSCRIPT_H=$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))
TRANSCRIPT_CROP="${SESSION_REGION_W}x${TRANSCRIPT_H}+${SESSION_REGION_X}+${TRANSCRIPT_TOP}"

# ─── The Editor A Fork Hands A Prompt Back Into ──────────────────────────────
# The composer card above its footer row, the same rectangle
# `desktop-branch-draft.sh` and `desktop-turn-copy.sh` read a restored prompt
# over: the footer's own top, less the gap the card keeps, down to the top of
# the card's text area.
FOOTER_ROW_H=32
FOOTER_TOP=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - FOOTER_ROW_H ))
EDITOR_TOP=$(( COMPOSER_EDITOR_Y - GUTTER_PX ))
EDITOR_H=$(( FOOTER_TOP - GUTTER_PX - EDITOR_TOP ))
EDITOR_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H ))
EDITOR_W=$(( COMPOSER_CARD_W - 2 * CARD_PAD_H ))
if (( EDITOR_H < 16 || EDITOR_W < 200 )); then
	abandon_take "the-editor-is-measurable" \
		"the composer's editor came to ${EDITOR_W}x${EDITOR_H}, which is not a rectangle a line of prose is read over"
fi
EDITOR_CROP="${EDITOR_W}x${EDITOR_H}+${EDITOR_X}+${EDITOR_TOP}"
echo "scene: a fork hands its prompt back into ${EDITOR_CROP}" >&2

# The two prompts. Each is one sentence the model answers in one short turn,
# and they are different lengths, so the drawing of one is nowhere near the
# drawing of the other.
FIRST_PROMPT="answer in one short sentence: what does a linker do?"
SECOND_PROMPT="now answer in one short sentence: and what does an assembler do instead?"

# The fill the transcript draws an operator's own turn on, and the fill a
# floated surface is drawn at, which is what a menu is. Both are read from the
# theme this checkout ships rather than restated as literals.
read -r USER_TURN_FILL MENU_FILL < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
surface = tomllib.loads((root / "tokens" / "surface" / "transcript.toml").read_text())
roles = tomllib.loads((root / "themes" / "dark.toml").read_text())["role"]
print(roles[surface["user_turn"]["ground"]], roles["float"])
PY
)
if [ -z "${MENU_FILL:-}" ]; then
	abandon_take "the-fills-are-known" \
		"no colour resolved for the roles the transcript fills a turn with and a menu floats on"
fi
echo "scene: an operator's turn is filled ${USER_TURN_FILL} and a menu floats on ${MENU_FILL}" >&2

# The prompts the session must hold when the fork is taken, and which of them
# is pressed: the first, which is the one no rail fork can name.
PROMPTS_DRAWN=2
PRESSED_PROMPT=1
# A menu is a surface floated over the transcript, so opening one repaints far
# more than a hover does. The floor is under one such menu.
MENU_MIN_PIXELS=2000
# The rows a turn menu offers once a turn can carry a fork, and the row that
# cuts one.
TURN_MENU_ITEMS=2
TURN_FORK_ITEM=2
# `Open`, `Park`, `Defer`, `Branch`, `Export`, `Compact`, `Handoff`, `Delete`.
ROW_MENU_ITEMS=8
ROW_FORK_ITEM=4
# What share of a menu's first row -- the one item no gate decides -- an offered
# answer is inked to. A refused one is drawn at 0.6 or 0.4 of its strength
# (§4.3), which lands far under this.
OFFERED_MIN_STRENGTH=85
# How many times a press is repeated while the window is still settling after
# the turn it just ran.
OFFER_ATTEMPTS=4
# A fork replaces the transcript with the prefix it kept, which repaints the
# turns that were drawn there. The floor is under one line of one turn.
TRANSCRIPT_MIN_PIXELS=400
# A line of a prompt's own prose, back in the editor.
EDITOR_MIN_PIXELS=600
# What the same sentence, drawn twice in the same place, may differ by: the
# caret is the one thing that moves between the two readings.
SAME_WORDS_MAX_PIXELS=200
# What two different sentences differ by at the least. Both are read over the
# same rectangle in the same face, so this is the ink of the words themselves.
OTHER_WORDS_MIN_PIXELS=400

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

operator_turn() { # <frame> <band> -> <y> <x>
	python3 "${MEASURE}" filled-band "$1" "${SESSION_REGION_X}" "${TRANSCRIPT_TOP}" \
		"${SESSION_REGION_W}" "${TRANSCRIPT_H}" "${USER_TURN_FILL}" "$2" "${PROMPTS_DRAWN}"
}

# A menu's rows, read over the band between the corner it opened at and the
# transcript's foot. The composer's own card is floated on the same fill, so a
# reading that took in the band below it would find the card and the menu as
# one box and aim between them.
menu_item() { # <frame> <origin-x> <origin-y> <items> <item> -> <y> <x> <strength>
	python3 "${MEASURE}" menu-item "$1" "$2" "$3" \
		"$(( WIN_X + WIN_W - $2 ))" "$(( WIN_Y + WIN_H - COMPOSER_BAND_H - $3 ))" \
		"${MENU_FILL}" "$5" "$4"
}

selected_card() { # <frame> -> <top> <left>
	python3 "${MEASURE}" selected-card "$1" "${RAIL_LEFT}" "${RAIL_LIST_TOP}" \
		"$(( RAIL_W - 2 * CONTENT_INSET ))" "$(( RAIL_LIST_BOTTOM - RAIL_LIST_TOP ))" "${CARD_PX}"
}

# The pointer is parked in the empty top of the transcript for every reading,
# so no chip of the footer and no row of the rail carries a hover fill in one
# frame and not another.
PARK_X="${TRANSCRIPT_COLUMN_LEFT}"
PARK_Y=$(( WIN_Y + TITLEBAR_H + 8 ))

# ─── 1. Say Two Things, So The End Is Not The Only Fork Point ────────────────
# The preamble leaves a slash in the editor from the palette it opened, and
# `type_prompt` clears the editor before it types, so these two sentences are
# the whole of what the session holds from the operator. Each is photographed
# in the editor as it is typed: those are the two references the prompt the
# fork hands back is read against.
type_prompt "${FIRST_PROMPT}"
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
TYPED_FIRST="${PROBE_DIR}/turn-fork-typed-first.png"
probe_frame "${TYPED_FIRST}"
k "Return"
if ! native_session_ready finished 2; then
	abandon_take "the-first-prompt-was-answered" \
		"the first prompt was not answered, so the session holds no earlier turn to fork at"
fi
pause 1.5

type_prompt "${SECOND_PROMPT}"
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
TYPED_SECOND="${PROBE_DIR}/turn-fork-typed-second.png"
probe_frame "${TYPED_SECOND}"
k "Return"
if ! native_session_ready finished 4; then
	abandon_take "the-second-prompt-was-answered" \
		"the second prompt was not answered, so the transcript holds one prompt and its end is its only fork point"
fi
pause 1.5

TYPED_APART="$(frames_differ_pixels_at "${TYPED_FIRST}" "${TYPED_SECOND}" "${EDITOR_CROP}")"
if [ "${TYPED_APART}" -lt "${OTHER_WORDS_MIN_PIXELS}" ]; then
	abandon_take "the-two-prompts-are-different-drawings" \
		"the two prompts are ${TYPED_APART}px apart in the editor, under the ${OTHER_WORDS_MIN_PIXELS} two different sentences ink, so neither reading below could tell them apart"
fi
echo "scene: the two prompts are ${TYPED_APART}px apart in the editor" >&2

move_px "${PARK_X}" "${PARK_Y}"
pause 1.0
shot the-session-holds-two-prompts
BEFORE_FORK="${SCENE_OUT}/${SCENE_NAME}-the-session-holds-two-prompts.png"

# ─── 2. Press The First Prompt ───────────────────────────────────────────────
read -r TURN_Y TURN_X < <(operator_turn "${BEFORE_FORK}" "${PRESSED_PROMPT}") || \
	abandon_take "the-earlier-turn-is-readable" \
		"the ${PROMPTS_DRAWN} prompts of this session were not readable out of the frame the fork is taken from, so the turn the fork is cut at could not be aimed at"
echo "scene: the first prompt's turn is drawn at ${TURN_X}+${TURN_Y}" >&2

TURN_MENU_OPEN="${PROBE_DIR}/turn-fork-turn-menu.png"

open_turn_menu() { # -> the pixels the press repainted
	local opened
	move_px "${TURN_X}" "${TURN_Y}"
	pause 0.4
	right_click
	pause 1.0
	probe_frame "${TURN_MENU_OPEN}"
	opened="$(frames_differ_pixels_at "${BEFORE_FORK}" "${TURN_MENU_OPEN}" "${WINDOW_CROP}")"
	printf '%s' "${opened}"
}

MENU_PX=0
for attempt in $(seq 1 "${OFFER_ATTEMPTS}"); do
	MENU_PX="$(open_turn_menu)"
	echo "scene: the press on the turn repainted ${MENU_PX}px, on attempt ${attempt}" >&2
	if [ "${MENU_PX}" -ge "${MENU_MIN_PIXELS}" ]; then
		break
	fi
	pause 1.0
done
if [ "${MENU_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "the-turn-opened-a-menu" \
		"the press on the turn repainted ${MENU_PX}px, under the ${MENU_MIN_PIXELS} a menu floated over the transcript inks, so the turn offered nothing in either arm"
fi
shot the-turn-offers-a-fork

# ─── 3. Take The Fork The Window Offers ──────────────────────────────────────
case "${ARM}" in
	after)
		read -r FORK_Y FORK_X FORK_STRENGTH < <(
			menu_item "${TURN_MENU_OPEN}" "${TURN_X}" "${TURN_Y}" "${TURN_MENU_ITEMS}" "${TURN_FORK_ITEM}"
		) || abandon_take "the-fork-row-is-readable" \
			"the ${TURN_MENU_ITEMS} rows a turn menu offers were not readable out of the frame it opened in"
		if [ "${FORK_STRENGTH}" -lt "${OFFERED_MIN_STRENGTH}" ]; then
			abandon_take "the-fork-row-is-offered" \
				"the fork row is inked to ${FORK_STRENGTH}% of the menu's first row, under the ${OFFERED_MIN_STRENGTH} an offered answer draws, so a click on it answers nothing"
		fi
		echo "scene: the fork row is drawn at ${FORK_X}+${FORK_Y}, inked to ${FORK_STRENGTH}% of the first row" >&2
		move_px "${FORK_X}" "${FORK_Y}"
		pause 0.4
		click
		pause 3.0
		;;
	before)
		# The menu of this arm has one row, `Copy`, so asking it for a second
		# is the reading that states the fork is not offered here.
		if menu_item "${TURN_MENU_OPEN}" "${TURN_X}" "${TURN_Y}" "${TURN_MENU_ITEMS}" "${TURN_FORK_ITEM}" \
			> /dev/null 2>&1; then
			abandon_take "the-turn-offers-no-fork" \
				"the turn's menu drew ${TURN_MENU_ITEMS} rows in the arm whose menu has one, so this arm is not the state the fix changed"
		fi
		read -r _ _ COPY_STRENGTH < <(menu_item "${TURN_MENU_OPEN}" "${TURN_X}" "${TURN_Y}" 1 1) || \
			abandon_take "the-turn-offers-its-words" \
				"the one row a turn menu offers here was not readable out of the frame it opened in"
		echo "scene: before arm -- the turn offers one row, inked to ${COPY_STRENGTH}% of itself" >&2
		k "Escape"
		pause 0.8

		# The only fork this arm has is the rail's, taken from the row the
		# window is on, which is the session both prompts were sent to.
		read -r CARD_TOP FILL_LEFT < <(selected_card "${BEFORE_FORK}") || \
			abandon_take "the-session-on-screen-is-drawn-as-selected" \
				"the rail's selected card was not readable out of the frame the fork is taken from"
		echo "scene: the window is on the card at ${CARD_TOP}px, filled from ${FILL_LEFT}px" >&2
		ROW_MENU_Y=$(( CARD_TOP + CARD_PX / 2 ))
		ROW_HOVERED="${PROBE_DIR}/turn-fork-row-hovered.png"
		ROW_MENU_OPEN="${PROBE_DIR}/turn-fork-row-menu.png"
		move_px "${CARD_X}" "${ROW_MENU_Y}"
		pause 0.5
		probe_frame "${ROW_HOVERED}"
		right_click
		pause 0.8
		probe_frame "${ROW_MENU_OPEN}"
		ROW_MENU_PX="$(frames_differ_pixels_at "${ROW_HOVERED}" "${ROW_MENU_OPEN}" "${WINDOW_CROP}")"
		if [ "${ROW_MENU_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
			abandon_take "the-row-menu-opened" \
				"the right-click on the row at ${ROW_MENU_Y}px changed ${ROW_MENU_PX}px of the window, under the ${MENU_MIN_PIXELS} a menu draws"
		fi
		read -r ROW_FORK_Y ROW_FORK_X ROW_FORK_STRENGTH < <(
			menu_item "${ROW_MENU_OPEN}" "${CARD_X}" "${ROW_MENU_Y}" "${ROW_MENU_ITEMS}" "${ROW_FORK_ITEM}"
		) || abandon_take "the-row-fork-is-readable" \
			"the ${ROW_MENU_ITEMS} rows of the row menu were not readable out of the frame it opened in"
		if [ "${ROW_FORK_STRENGTH}" -lt "${OFFERED_MIN_STRENGTH}" ]; then
			abandon_take "the-row-fork-is-offered" \
				"the rail's Branch row is inked to ${ROW_FORK_STRENGTH}% of the menu's first row, under the ${OFFERED_MIN_STRENGTH} an offered answer draws"
		fi
		move_px "${ROW_FORK_X}" "${ROW_FORK_Y}"
		pause 0.4
		click
		pause 3.0
		;;
	*)
		abandon_take "the-arm-is-known" "SCENE_ARM=${ARM} is neither arm of this scene"
		;;
esac

# ─── 4. Which Prompt Came Back ───────────────────────────────────────────────
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.5
move_px "${PARK_X}" "${PARK_Y}"
pause 1.0
shot the-fork-hands-that-turn-back
AFTER_FORK="${SCENE_OUT}/${SCENE_NAME}-the-fork-hands-that-turn-back.png"

TRANSCRIPT_PX="$(frames_differ_pixels_at "${BEFORE_FORK}" "${AFTER_FORK}" "${TRANSCRIPT_CROP}")"
EDITOR_PX="$(frames_differ_pixels_at "${BEFORE_FORK}" "${AFTER_FORK}" "${EDITOR_CROP}")"
LIKE_FIRST="$(frames_differ_pixels_at "${TYPED_FIRST}" "${AFTER_FORK}" "${EDITOR_CROP}")"
LIKE_SECOND="$(frames_differ_pixels_at "${TYPED_SECOND}" "${AFTER_FORK}" "${EDITOR_CROP}")"
echo "scene: the fork repainted ${TRANSCRIPT_PX}px of the transcript and put ${EDITOR_PX}px in the editor," \
	"${LIKE_FIRST}px from the first prompt and ${LIKE_SECOND}px from the second" >&2

# The fork happened in both arms or neither reading means anything, so these
# two are read once and not per arm.
if [ "${TRANSCRIPT_PX}" -lt "${TRANSCRIPT_MIN_PIXELS}" ]; then
	abandon_take "the-fork-cut-the-transcript" \
		"the transcript changed ${TRANSCRIPT_PX}px across the fork, under the ${TRANSCRIPT_MIN_PIXELS} dropping a turn draws, so no fork was taken"
fi
if [ "${EDITOR_PX}" -lt "${EDITOR_MIN_PIXELS}" ]; then
	abandon_take "the-fork-handed-a-prompt-back" \
		"the fork put ${EDITOR_PX}px in the editor, under the ${EDITOR_MIN_PIXELS} a line of prose inks, so it handed nothing back and neither arm states which prompt it cut"
fi

case "${ARM}" in
	after)
		if [ "${LIKE_FIRST}" -gt "${SAME_WORDS_MAX_PIXELS}" ]; then
			abandon_take "the-fork-hands-the-pressed-turn-back" \
				"what came back is ${LIKE_FIRST}px from the prompt the pressed turn holds, over the ${SAME_WORDS_MAX_PIXELS} a caret accounts for, so the fork was cut somewhere other than the turn that was pressed"
		fi
		if [ "${LIKE_SECOND}" -lt "${OTHER_WORDS_MIN_PIXELS}" ]; then
			abandon_take "the-fork-is-not-the-transcript-s-end" \
				"what came back is ${LIKE_SECOND}px from the session's last prompt, under the ${OTHER_WORDS_MIN_PIXELS} two different sentences ink, so the fork answered with the end after all"
		fi
		echo "scene: after arm -- the fork handed the pressed turn's prompt back, ${LIKE_FIRST}px from how it was typed" >&2
		;;
	before)
		if [ "${LIKE_SECOND}" -gt "${SAME_WORDS_MAX_PIXELS}" ]; then
			abandon_take "the-baseline-hands-the-end-back" \
				"the rail's fork answered with something ${LIKE_SECOND}px from the session's last prompt, over the ${SAME_WORDS_MAX_PIXELS} a caret accounts for, so this arm is not the state the fix changed"
		fi
		if [ "${LIKE_FIRST}" -lt "${OTHER_WORDS_MIN_PIXELS}" ]; then
			abandon_take "the-baseline-cannot-reach-the-turn" \
				"the rail's fork answered with something ${LIKE_FIRST}px from the pressed turn's prompt, under the ${OTHER_WORDS_MIN_PIXELS} two different sentences ink, so the arms do not differ"
		fi
		echo "scene: before arm -- the only fork available answered with the session's last prompt, ${LIKE_FIRST}px from the turn that was pressed" >&2
		;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is the session holding two prompts and their answers, with the
# composer empty: the state a fork is taken from, and the state in which the
# transcript's end is not the turn the operator is reading.
#
# Frame 2 is the first prompt's own menu. Here it offers `Branch from here`
# beside `Copy`. There it offers `Copy` alone, which is every answer that turn
# had.
#
# Frame 3 is the window after the fork. Here the transcript is the prefix that
# ends before the pressed turn and the composer holds that turn's prompt, ready
# to be edited and sent down the new branch. There the fork is the rail's, the
# only one the window has, and the composer holds the session's last prompt:
# the same fork the operator could always take, cut at the end they were not
# reading.
#
# WHAT IS NOT HERE. The fork's own file -- the entries it kept, the source it
# left whole -- which is the host suite named above; and a fork asked for at a
# turn no fork can be cut at, which sends nothing and is the Rust suite's.
