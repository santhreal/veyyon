#!/usr/bin/env bash
# Answer a question the product raised, in the native GPUI window, with the
# gestures the window offers for it: the composer's own control, and the digit
# that belongs to an option.
#
# Records visual evidence for:
#   1. question-raised      (a question with its answers, attached above the composer)
#   2. question-typed-press (the composer's control pressed with a draft in it)
#   3. question-empty-press (the same control pressed with nothing typed)
#   4. question-answered    (the question settled by the option that answers it)
#
# THE CLAIM. A question that offers options is answered by choosing one, so the
# composer -- whose answer is its draft -- carries no answer for it and offers
# none. In this arm the card offers its options and nothing else, both presses
# leave the question exactly as it was, and the digit that names an option
# settles it.
#
# In the other arm the card also offers to reply with the composer's text and
# the composer's control reads `Submit answer`, so the draft is sent as free
# text for a question the host takes an option index for. The host refuses it,
# the window states that refusal across its head -- `a choice is answered with
# { option: index }` -- and the card is gone: the decision the host is still
# blocked on is no longer drawn anywhere, and no press or digit after that
# reaches it.
#
# WHERE THE QUESTION COMES FROM. `/review` asks which review to run before it
# reads anything, through the same `select` seam an `ask` tool call crosses, so
# the card is the product's own and no model has to be persuaded to raise it.
# The answers are the command's, the card is the host's, and the take asserts
# neither's text.
#
# WHAT IS MEASURED. Four authored colours, each counted where one thing draws
# it, each matched exactly or to within less than the distance to its nearest
# neighbour in this theme.
#   * `tint.input.fill` is the ring a question card is bordered with, so the
#     first and last row carrying it are the card's own edges.
#   * `role.inset` fills an option row, so a run of it between those edges is
#     one answer the card offers, and the number of runs is how many.
#   * `role.accent` fills the affirmative answer of a card's answer row, which
#     for a question is the composer reply -- and nothing else inside the card.
#   * `tint.attention.fill` is the ground the window's own notice line carries,
#     which is where a refused answer to a decision is stated. It is counted in
#     pixel ROWS spanning the window, so a glyph antialiasing into that hue
#     cannot be read as a notice.
# All four come from the theme this checkout ships, so a retheme moves each
# reading with its colour.
#
# The first press is also the aim's proof: the prompt is submitted by pressing
# the composer's control rather than by Return, so a take that reaches a
# question at all has established that those coordinates are that control, and
# every press below uses the same ones.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. A window that repaints one band of cards
# carries a motion floor. Record it with:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-question-answer.sh
#
# and the other arm against a build that answered a question in whichever shape
# the composer had. That change is entirely inside the executable, so the arm
# holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-question-answer.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

THEME="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"

role_colour() { # <name> -> the [role] colour of that name
	local found
	found="$(sed -n "/^\[role\]/,/^\[/ s/^$1 = \"\(#[0-9a-fA-F]\{6\}\)\".*/\1/p" "${THEME}" | head -1)"
	if [ -z "${found}" ]; then
		abandon_take "the-theme-is-readable" "no [role] $1 in ${THEME}"
	fi
	printf '%s' "${found}"
}

tint_colour() { # <section> -> the fill of that tint section
	local found
	found="$(sed -n "/^\[tint\.$1\]/,/^\[/ s/^fill = \"\(#[0-9a-fA-F]\{6\}\)\".*/\1/p" "${THEME}" | head -1)"
	if [ -z "${found}" ]; then
		abandon_take "the-theme-is-readable" "no [tint.$1] fill in ${THEME}"
	fi
	printf '%s' "${found}"
}

RING="$(tint_colour input)"
INSET="$(role_colour inset)"
ACCENT="$(role_colour accent)"
NOTICE="$(tint_colour attention)"
echo "scene: a card rings in ${RING}, offers rows of ${INSET}, affirms in ${ACCENT};" \
	"the window states a refusal on ${NOTICE}" >&2

# ─── Where A Card And A Notice Can Be Drawn ──────────────────────────────────
# The attached cards share the composer's measure and stack directly above it
# (§5.5), so the band they can occupy is everything between the titlebar and
# the composer band, at the composer card's own width and left edge. Reading
# inside that band keeps every count off the queue rail beside it and off the
# composer's own controls below it, where the accent also draws.
CARD_BAND_Y=$(( WIN_Y + TITLEBAR_H ))
CARD_BAND_H=$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))
if (( CARD_BAND_H < 160 )); then
	abandon_take "the-cards-have-a-band" \
		"the band above the composer resolved to ${CARD_BAND_H}px, too short to hold a card"
fi
CARD_BAND="${COMPOSER_CARD_W}x${CARD_BAND_H}+${COMPOSER_CARD_LEFT}+${CARD_BAND_Y}"

# The window's notice line is drawn under the titlebar, across everything: the
# rail, the session surface and the panel. Its band is the window's own width
# and as deep as a two-line notice with its padding could reach.
NOTICE_BAND="${WIN_W}x120+${WIN_X}+${CARD_BAND_Y}"
echo "scene: a card can occupy ${CARD_BAND}, a notice ${NOTICE_BAND}" >&2

# The composer's primary control: a 28px box in the card's footer, against the
# card's trailing inset, mirroring the model chip on the other side.
PRIMARY_X=$(( COMPOSER_CARD_LEFT + COMPOSER_CARD_W - CARD_PAD_H - GUTTER_PX ))
PRIMARY_Y=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - GUTTER_PX ))

# An option row runs the card's measure less its padding, so a floor of 120
# columns separates a row from a glyph that happens to sit on the inset. A ring
# row is a straight edge across the card, so half the measure is the floor
# there. An affirmative pill is hundreds of pixels of accent; a stray
# accent-inked word is not. A notice row spans the window, so a floor of a
# fifth of its width keeps a word off the count, and one line of notice with
# its padding is around twenty such rows.
ROW_COLUMNS_MIN=120
ACCENT_PIXELS_MIN=400
NOTICE_ROWS_MIN=10
QUIET_ROWS_MAX=2

# One reading of one frame: the card's ring, the answers it offers as rows, and
# the accent-filled answer it offers beside them. Everything is counted between
# the ring's own edges, so a transcript block behind the card cannot be read as
# part of it.
card_reading() { # <png> -> "RING_PX TOP BOTTOM OPTION_RUNS ACCENT_PX"
	local dump="${TMPDIR}/frame-compare/card-reading.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${CARD_BAND}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${RING#\#}" "${INSET#\#}" "${ACCENT#\#}" \
		"${COMPOSER_CARD_W}" "${ROW_COLUMNS_MIN}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")


def rgb(text):
	return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def near(colour, wanted, tolerance):
	return all(abs(a - b) <= tolerance for a, b in zip(colour, wanted))


ring, inset, accent = (rgb(argument.upper()) for argument in sys.argv[2:5])
width, row_columns_min = int(sys.argv[5]), int(sys.argv[6])
# A hairline sits six steps from the ring and the float ground seven from the
# inset, so three is under both and cannot collect the neighbour. The accent's
# nearest neighbour is the focus colour, twenty-seven away on one channel.
ring_rows, inset_rows, accent_rows, ring_total = {}, {}, {}, 0
for line in open(sys.argv[1], encoding="ascii"):
	found = PIXEL.match(line)
	if not found:
		continue
	row, colour = int(found.group(2)), rgb(found.group(3).upper())
	if near(colour, ring, 3):
		ring_rows[row] = ring_rows.get(row, 0) + 1
		ring_total += 1
	elif near(colour, inset, 3):
		inset_rows[row] = inset_rows.get(row, 0) + 1
	elif near(colour, accent, 10):
		accent_rows[row] = accent_rows.get(row, 0) + 1

edges = sorted(row for row, count in ring_rows.items() if count >= width // 2)
if not edges:
	print(f"{ring_total} 0 0 0 0")
	raise SystemExit(0)

top, bottom = edges[0], edges[-1]
lit = sorted(
	row
	for row, count in inset_rows.items()
	if count >= row_columns_min and top < row < bottom
)
runs, previous = 0, None
for row in lit:
	if previous is None or row - previous > 1:
		runs += 1
	previous = row
accent_pixels = sum(count for row, count in accent_rows.items() if top < row < bottom)
print(f"{ring_total} {top} {bottom} {runs} {accent_pixels}")
PY
}

notice_rows() { # <png> -> pixel rows of the window's notice ground under the titlebar
	local dump="${TMPDIR}/frame-compare/notice-rows.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${NOTICE_BAND}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${NOTICE#\#}" "$(( WIN_W / 5 ))" <<'PY'
import re
import sys

PIXEL = re.compile(r"^\d+,(\d+): \([^)]*\)\s+#([0-9A-Fa-f]+)")
wanted, columns_min = sys.argv[2].upper()[:6], int(sys.argv[3])
per_row = {}
with open(sys.argv[1], encoding="ascii") as dump:
	for line in dump:
		found = PIXEL.match(line)
		if found and found.group(2).upper()[:6] == wanted:
			row = int(found.group(1))
			per_row[row] = per_row.get(row, 0) + 1
print(sum(1 for count in per_row.values() if count >= columns_min))
PY
}

# Wait until a question card is drawn, or say what was there instead. The
# command raises its question the moment the prompt reaches the host, so the
# wait is on the window rather than on a timer.
await_card() { # <seconds> -> 0 once a card offers rows
	local deadline=$(( SECONDS + $1 )) probe="${TMPDIR}/awaiting-card.png" runs=0
	while (( SECONDS < deadline )); do
		probe_frame "${probe}"
		read -r _ _ _ runs _ < <(card_reading "${probe}")
		if (( runs > 0 )); then
			echo "scene: a card is up, offering ${runs} row(s)" >&2
			return 0
		fi
		pause 1.5
	done
	echo "scene: no question card after $1s" >&2
	return 1
}

# ─── The Model The Session Runs On ───────────────────────────────────────────
# Named even though the question below needs no model: the session states the
# model it would run, and a picker left at whatever the profile held would put
# a different chip in every frame.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
k "ctrl+shift+m"
pause 0.4
t "local/qwen2.5-1.5b"
pause 0.5
k "Return"
pause 0.5

# ─── One Question, Asked By The Command That Asks It ─────────────────────────
# A slash opens the command palette over the composer, so it is dismissed
# before the control is pressed: the draft survives that, and the press then
# lands on the composer rather than on an overlay above it.
type_prompt "/review"
k "Escape"
pause 0.6
BEFORE_PRESS="${TMPDIR}/before-press.png"
probe_frame "${BEFORE_PRESS}"
move_px "${PRIMARY_X}" "${PRIMARY_Y}"
pause 0.3
click
pause 1.0
SENT_PX="$(screen_differs_from_frame_pixels_at "${BEFORE_PRESS}" "${COMPOSER_BAND_CROP}")"
if (( SENT_PX < 300 )); then
	abandon_take "question-raised" \
		"pressing ${PRIMARY_X},${PRIMARY_Y} changed ${SENT_PX} pixels of the composer band, so the draft was never sent and that point is not the composer's control"
fi
echo "scene: the control sent the prompt, ${SENT_PX} pixels of composer band changed" >&2

if ! await_card 120; then
	abandon_take "question-raised" \
		"the command raised no question above the composer, so there is nothing to answer"
fi
pause 0.6
shot question-raised
RAISED_FRAME="${SCENE_OUT}/${SCENE_NAME}-question-raised.png"
read -r RAISED_RING _ _ RAISED_RUNS RAISED_ACCENT < <(card_reading "${RAISED_FRAME}")
RAISED_NOTICE="$(notice_rows "${RAISED_FRAME}")"
echo "scene: the card rings ${RAISED_RING}px, offers ${RAISED_RUNS} option row(s)," \
	"draws ${RAISED_ACCENT}px of accent inside itself, and the window states ${RAISED_NOTICE} notice row(s)" >&2
if (( RAISED_RUNS < 3 )); then
	abandon_take "question-raised" \
		"the card offers ${RAISED_RUNS} option row(s), so the question it is asking is not the one with answers to choose between"
fi
if (( RAISED_NOTICE > QUIET_ROWS_MAX )); then
	abandon_take "question-raised" \
		"the window already states ${RAISED_NOTICE} rows of notice ground before an answer was attempted"
fi
case "${ARM}" in
	after)
		if (( RAISED_ACCENT >= ACCENT_PIXELS_MIN )); then
			abandon_take "question-raised" \
				"the card draws ${RAISED_ACCENT} pixels of accent inside itself, which is an affirmative answer offered for a question that takes an option"
		fi
		;;
	before)
		if (( RAISED_ACCENT < ACCENT_PIXELS_MIN )); then
			abandon_take "question-raised" \
				"the before arm draws ${RAISED_ACCENT} pixels of accent inside the card, under the ${ACCENT_PIXELS_MIN} an affirmative pill fills, so this build did not offer the composer reply the arm exists to show"
		fi
		;;
esac

# ─── The Composer, With A Draft In It ────────────────────────────────────────
# A draft is what the composer answers with, and this question is not answered
# with one. In this arm the press sends nothing and the question stays exactly
# as it was; in the other it sends the draft as free text, the host refuses it,
# and the card the decision was drawn on is gone.
type_prompt "Review the parser module and its tests"
move_px "${PRIMARY_X}" "${PRIMARY_Y}"
pause 0.3
click
pause 2.5
shot question-typed-press
TYPED_FRAME="${SCENE_OUT}/${SCENE_NAME}-question-typed-press.png"
read -r _ _ _ TYPED_RUNS _ < <(card_reading "${TYPED_FRAME}")
TYPED_NOTICE="$(notice_rows "${TYPED_FRAME}")"
echo "scene: after the typed press the card offers ${TYPED_RUNS} row(s) and the window states" \
	"${TYPED_NOTICE} notice row(s)" >&2
case "${ARM}" in
	after)
		if (( TYPED_RUNS != RAISED_RUNS )); then
			abandon_take "question-typed-press" \
				"the card offers ${TYPED_RUNS} option row(s) where it offered ${RAISED_RUNS}, so a press carrying a draft changed which question is open"
		fi
		if (( TYPED_NOTICE > QUIET_ROWS_MAX )); then
			abandon_take "question-typed-press" \
				"the window states ${TYPED_NOTICE} rows of notice ground, so the composer sent an answer the host would not take"
		fi
		;;
	before)
		if (( TYPED_RUNS != 0 )); then
			abandon_take "question-typed-press" \
				"the before arm still offers ${TYPED_RUNS} option row(s) after the typed press, so this build did not send the shape the arm exists to show"
		fi
		if (( TYPED_NOTICE < NOTICE_ROWS_MIN )); then
			abandon_take "question-typed-press" \
				"the before arm states ${TYPED_NOTICE} rows of notice ground, under the ${NOTICE_ROWS_MIN} one line of it takes, so the host's refusal of that answer is not on screen"
		fi
		;;
esac

# ─── The Composer, With Nothing In It ────────────────────────────────────────
# An empty draft is not an answer either. In this arm the question is still
# open and still unchanged; in the other it has been gone since the typed
# press, and nothing brings it back.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.4
move_px "${PRIMARY_X}" "${PRIMARY_Y}"
pause 0.3
click
pause 2.5
shot question-empty-press
EMPTY_FRAME="${SCENE_OUT}/${SCENE_NAME}-question-empty-press.png"
read -r EMPTY_RING _ _ EMPTY_RUNS _ < <(card_reading "${EMPTY_FRAME}")
echo "scene: after the empty press the card rings ${EMPTY_RING}px and offers ${EMPTY_RUNS} row(s)" >&2
case "${ARM}" in
	after)
		if (( EMPTY_RUNS != RAISED_RUNS )); then
			abandon_take "question-empty-press" \
				"the card offers ${EMPTY_RUNS} option row(s) where it offered ${RAISED_RUNS}, so a press carrying nothing answered a question with something"
		fi
		;;
	before)
		if (( EMPTY_RUNS != 0 )); then
			abandon_take "question-empty-press" \
				"the before arm draws ${EMPTY_RUNS} option row(s) again, so the question came back and the arm is not the state it was recorded for"
		fi
		;;
esac

# ─── The Answer This Question Takes ─────────────────────────────────────────
# The digit belongs to the option beside it and the composer is empty, so `2`
# is the second answer on the card. The other arm has no card for it to reach,
# which is the state that arm records.
k "2"
pause 3.0
shot question-answered
ANSWERED_FRAME="${SCENE_OUT}/${SCENE_NAME}-question-answered.png"
read -r ANSWERED_RING _ _ ANSWERED_RUNS _ < <(card_reading "${ANSWERED_FRAME}")
ANSWERED_NOTICE="$(notice_rows "${ANSWERED_FRAME}")"
echo "scene: after the digit the band rings ${ANSWERED_RING}px, offers ${ANSWERED_RUNS} row(s)," \
	"and the window states ${ANSWERED_NOTICE} notice row(s)" >&2
if (( ANSWERED_RUNS > 0 )); then
	abandon_take "question-answered" \
		"a card still offers ${ANSWERED_RUNS} row(s) after the digit that names an option, so choosing an option did not answer the question"
fi
if [ "${ARM}" = "after" ] && (( ANSWERED_NOTICE > QUIET_ROWS_MAX )); then
	abandon_take "question-answered" \
		"the window states ${ANSWERED_NOTICE} rows of notice ground after an option was chosen, so the host would not take the shape the digit sent"
fi

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is a real question, raised by `/review` through the seam every asked
# question crosses, drawn at the composer's own measure with the answers it
# offers on it. The same frame in the other arm carries one more answer -- an
# accent-filled offer to reply with the composer's text -- and a composer whose
# control reads `Submit answer`, for a question the host does not take text
# for.
#
# Frames 2 and 3 are the two presses that sent the wrong shape. Here the
# question is open and unchanged after both, because the composer carries no
# answer for it. There, frame 2 is the host's refusal stated across the window
# -- `a choice is answered with { option: index }` -- with the card gone, and
# frame 3 is the same window a press later: the decision the host is still
# blocked on is drawn nowhere and nothing reaches it.
#
# Frame 4 is the question settled by the digit that names one of its options,
# with nothing refused.
#
# WHAT IS NOT HERE. How the composer's control is PAINTED while it carries no
# answer: the dimming is opacity and a cursor, which these frames show and no
# reading here counts, and nothing is asserted about it. A question that offers
# no options -- which the composer does answer, with its draft -- is not in this
# take either; that shape, and the reply the card keeps for it, is held by
# crates/veyyon-desktop-surface/tests/a-question-is-answered-in-the-shape-the-host-takes-for-it.rs
# with the mutation gate recorded in the pull request.
