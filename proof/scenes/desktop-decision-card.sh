#!/usr/bin/env bash
# Drive the attached decision surface (§5.5) in the native GPUI window: a real
# tool call stopped for approval, the four answers the wrapper accepts, the
# answer the pointer gives it, and three decisions arriving at once against a
# stack that draws two.
#
# Records visual evidence for:
#   1. decision-raised        (an approval attached above the composer)
#   2. decision-answered      (the same card answered, the call let through)
#   3. decisions-folded       (three waiting, two drawn, the rest folded)
#   4. decisions-folded-open  (the folded row opened under the pointer)
#
# THE DIFFERENTIAL IS THE APPROVAL MODE, which is a setting and not a keystroke,
# so the arms are two recordings seeded before the session starts:
#
#   OUT_DIR=$PWD/proof/captures/x11/off proof/docker/record-native.sh \
#     proof/scenes/desktop-decision-card.sh
#   OUT_DIR=$PWD/proof/captures/x11/on SCENE_SETTINGS='tools.approvalMode: ask' \
#     proof/docker/record-native.sh proof/scenes/desktop-decision-card.sh
#
# At the default mode a read runs unasked and no card is drawn, which is the off
# arm and is what makes the on arm evidence of anything. Frames 3 and 4 exist
# only where a decision exists, so the off arm records the first two and states
# why the others are absent.
#
# NOTHING HERE IS STAGED. The turn is real, the tool calls are the model's own,
# and the cards are the ones the tool wrapper raised through the host's
# interaction ledger. The scene reads them back by colour: a card's edge is
# `tint.approve` and its affirmative answer is `accent`, both read from the
# theme file this checkout ships, so an assertion follows a retuned palette
# instead of pinning the numbers one take happened to draw.
#
# Sourced state comes from desktop-composer.sh: the helpers, the token-derived
# geometry, a created session and its composer frames. Recorded with
# SCENE_MOTION_FLOOR=5, which is what a window that repaints one band of cards
# measures against a terminal's full-screen redraws.

set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── What The Tokens And The Theme Say A Decision Is Drawn With ──────────────
# Every number and every colour below is authored: the card's tinted edge, the
# accent its affirmative answer is filled with, the hairline the other three are
# outlined in, the padding that puts the answer row inside the card, the gap
# between stacked cards, how many the stack draws, and how tall the row the rest
# fold into is. A scene that restated any of them would keep passing after the
# tokens moved.
read -r ACCENT APPROVE_EDGE HAIRLINE CARD_PAD STACK_GAP STACK_MAX_VISIBLE FOLD_ROW DETAIL_CAP < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
theme = tomllib.loads((root / "themes/dark.toml").read_text())
cards = tomllib.loads((root / "tokens/surface/attached-cards.toml").read_text())
scale = tomllib.loads((root / "tokens/scale.toml").read_text())
print(
    theme["role"]["accent"],
    theme["tint"]["approve"]["fill"],
    theme["role"]["hairline"],
    int(scale["spacing"][cards["approval"]["padding"]]),
    int(scale["spacing"]["s2"]),
    int(cards["stack"]["max_visible"]),
    int(cards["stack"]["overflow_collapsed_height_px"]),
    int(cards["approval"]["detail_mono_pane_cap_px"]),
)
PY
) || true
if [ -z "${DETAIL_CAP:-}" ]; then
	abandon_take "the-decision-tokens-are-readable" \
		"the theme and attached-card tokens produced no geometry for the stack"
fi
echo "scene: a card edges in ${APPROVE_EDGE}, answers in ${ACCENT}, stack draws ${STACK_MAX_VISIBLE}," \
	"folds ${FOLD_ROW}px rows, pads ${CARD_PAD}px" >&2

# Which arm this is, read from the profile config the recorder seeded rather
# than from a knob the scene could disagree with. An unseeded run is the off
# arm, because `auto` is the shipped default; a mode nobody named here ends the
# take rather than recording an arm with no claim attached to it.
APPROVAL_MODE="$(
	python3 - "${HOME}/.veyyon/profiles/${VEYYON_PROFILE:-default}/agent/config.yml" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text() if path.exists() else ""
found = re.findall(r"^tools\.approvalMode:\s*(\S+)\s*$", text, re.M)
print(found[-1] if found else "auto")
PY
)"
case "${APPROVAL_MODE}" in
	ask) ARM=on ;;
	auto) ARM=off ;;
	*)
		abandon_take "the-arm-is-named" \
			"tools.approvalMode is '${APPROVAL_MODE}', which is neither arm this scene records"
		;;
esac
echo "scene: recording the ${ARM} arm at tools.approvalMode=${APPROVAL_MODE}" >&2

# ─── Reading The Stack Off The Screen ────────────────────────────────────────
# The stack shares the composer's measure and sits directly above it (§5.5), so
# the band it can occupy is bounded: two cards at their authored maximum, the
# gap between them, and the folded row opened. The detail pane's cap and the
# card's padding are what decide a card's height, so the bound is derived rather
# than guessed, and the crop stops at the composer band, which leaves the send
# button -- the one other accent-filled control on this surface -- outside every
# reading below.
STACK_BAND_H=$(( 2 * (2 * CARD_PAD + DETAIL_CAP + 64) + STACK_GAP + FOLD_ROW * 4 ))
STACK_BAND_Y=$(( WIN_Y + WIN_H - COMPOSER_BAND_H - STACK_BAND_H ))
if (( STACK_BAND_Y < WIN_Y + TITLEBAR_H )); then
	STACK_BAND_H=$(( WIN_H - COMPOSER_BAND_H - TITLEBAR_H ))
	STACK_BAND_Y=$(( WIN_Y + TITLEBAR_H ))
fi
STACK_BAND="${SESSION_REGION_W}x${STACK_BAND_H}+${SESSION_REGION_X}+${STACK_BAND_Y}"
echo "scene: the stack can occupy ${STACK_BAND}" >&2

# Every region of one authored colour in that band, in root coordinates, one
# `X Y W H` per line ordered top to bottom. A card's edge is a hairline ring in
# `tint.approve` and its affirmative answer is a filled pill in `accent`, so
# both are regions of a colour nothing else on this surface fills. The fuzz stays
# under the distance to the nearest role of the same theme -- accent to focus,
# the approve tint to the float ground it is drawn on -- so a reading cannot
# collect the neighbour it exists to tell apart.
colour_boxes() { # <png> <hex> <fuzz-percent> <area-floor>
	magick "$1" -crop "${STACK_BAND}" +repage \
		-fuzz "$3%" -fill white -opaque "$2" -fill black +opaque white \
		-define connected-components:verbose=true \
		-define "connected-components:area-threshold=$4" \
		-connected-components 8 null: 2>/dev/null |
		awk -v ox="${SESSION_REGION_X}" -v oy="${STACK_BAND_Y}" '
			/srgb\(255,255,255\)/ {
				split($2, box, /[x+]/)
				print box[3] + ox, box[4] + oy, box[1], box[2]
			}' | sort -k2 -n
}

# The screen as it is now, for one of the readings above.
probe_stack() {
	local frame="${SCENE_RUNTIME_DIR}/frame-compare/stack.png"
	probe_frame "${frame}"
	printf '%s' "${frame}"
}

# The affirmative answers on screen: one accent pill per card the stack drew, so
# the count is the number of cards and each line is a place to click. The area
# floor is what separates a filled pill from an accent-inked word in a tool card
# the transcript is streaming behind the stack.
answer_boxes() { # <png>
	colour_boxes "$1" "${ACCENT}" 6 700
}

# The horizontal runs of a card's tinted edge. A rounded corner blends into the
# ground, so the ring reads as segments rather than one box, and the two that
# span the card are its top and bottom edges: the first line is the topmost
# card's top edge and the last is the lowest card's bottom. Anything narrower
# than half the composer's measure is not a card edge.
edge_runs() { # <png>
	colour_boxes "$1" "${APPROVE_EDGE}" 4 60 |
		awk -v floor="$(( COMPOSER_CARD_W / 2 ))" '$3 >= floor'
}

# Wait until the stack is drawing exactly this many cards. The host raises a
# decision when the model calls a tool and not when the prompt is sent, so the
# wait is on the window rather than on a timer; a stack that never reaches the
# count ends the take naming what it did draw.
await_cards() { # <count> <seconds>
	local want="$1" ceiling="${2:-180}" waited=0 seen=0
	while [ "${waited}" -lt "${ceiling}" ]; do
		seen="$(answer_boxes "$(probe_stack)" | wc -l)"
		if [ "${seen}" -eq "${want}" ]; then
			echo "scene: the stack is drawing ${seen} card(s) after ${waited}s" >&2
			return 0
		fi
		sleep 2
		waited=$((waited + 2))
	done
	echo "scene: the stack drew ${seen} card(s), not ${want}, within ${ceiling}s" >&2
	return 1
}

# ─── The Model The Turn Runs On ──────────────────────────────────────────────
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

# ─── One Tool Call, Stopped For An Answer ────────────────────────────────────
# The prompt names the tool and the file so the call is the model's to make and
# not the scene's to fake: one read of a file this repository has, with the
# answer asked for in the reply so the turn ends in prose after the tool.
READ_PROMPT="Call the read tool once with path AGENTS.md, then tell me the first heading in it. Call no other tool."
submit_prompt "${READ_PROMPT}"

if [ "${ARM}" = "on" ]; then
	if ! await_cards 1 180; then
		abandon_take "a-tool-call-raised-a-decision" \
			"the host ran the turn but no approval card was drawn above the composer within 180s"
	fi
else
	# Nothing stops at the default, so the claim is the turn finishing with the
	# tool's own result in it: a card drawn here would be the defect.
	if ! native_session_ready finished 2; then
		abandon_take "the-call-ran-unasked" \
			"the turn never completed at the default approval mode"
	fi
	OFF_ARM_FRAME="$(probe_stack)"
	if [ "$(answer_boxes "${OFF_ARM_FRAME}" | wc -l)" != "0" ] ||
		[ "$(edge_runs "${OFF_ARM_FRAME}" | wc -l)" != "0" ]; then
		abandon_take "the-default-asks-nothing" \
			"a decision card was drawn at tools.approvalMode=${APPROVAL_MODE}, which stops for nothing"
	fi
fi
pause 0.6
shot decision-raised

if [ "${ARM}" = "off" ]; then
	# The off arm's second frame is the same turn settled, which is the state the
	# on arm reaches only by answering. Nothing to fold and nothing to open, so
	# the two frames the fold needs are on-arm only, by construction.
	pause 1.2
	shot decision-answered
	echo "scene: the off arm ends here -- a fold needs decisions, and this mode raises none" >&2
	exit 0
fi

# THE CARD'S OWN MEASURE, against the composer it sits above (§5.5). A stack
# drawn at the window's width, or off the composer's centre, would still
# photograph as a card.
CARD_FRAME="$(probe_stack)"
read -r EDGE_X EDGE_Y EDGE_W EDGE_H < <(edge_runs "${CARD_FRAME}") || true
if [ -z "${EDGE_W:-}" ]; then
	abandon_take "a-card-draws-the-edge-of-its-kind" \
		"the stack drew an answer but no ${APPROVE_EDGE} edge, so the card states no kind"
fi
if (( EDGE_W < COMPOSER_CARD_W - 6 || EDGE_W > COMPOSER_CARD_W + 6 )); then
	abandon_take "a-card-takes-the-composers-measure" \
		"the card edge is ${EDGE_W}px wide against the composer's authored ${COMPOSER_CARD_W}px"
fi
if (( EDGE_X < COMPOSER_CARD_LEFT - 6 || EDGE_X > COMPOSER_CARD_LEFT + 6 )); then
	abandon_take "a-card-sits-over-the-composer" \
		"the card's left edge is at ${EDGE_X} against the composer's ${COMPOSER_CARD_LEFT}"
fi

# THE FOUR ANSWERS. The affirmative one is filled with accent and the other
# three are ink on a hairline, so the row reads as one accent pill and three
# outlined ones. Both are asserted, and so is their order: a card offering the
# affirmative alone is the surface this row exists to prevent (§5.5), a card
# offering two answers is the terminal's old pair rather than the wrapper's
# four, and an affirmative that is not the last of them is a card whose default
# reading is a refusal.
#
# An outlined pill is a one-pixel rounded border, so its vertical sides are
# 22 pixels of ink and its horizontal ones are the width of the label: the run
# along the row's top edge is what identifies a pill, and the sides fall under
# any threshold that keeps a glyph out.
outlined_answers() { # <png> <x> <y> <w> <h>
	magick "$1" -crop "$4x$5+$2+$3" +repage \
		-fuzz 4% -fill white -opaque "${HAIRLINE}" -fill black +opaque white \
		-define connected-components:verbose=true \
		-define connected-components:area-threshold=20 \
		-connected-components 8 null: 2>/dev/null |
		awk -v ox="$2" '
			/srgb\(255,255,255\)/ {
				split($2, box, /[x+]/)
				if (box[2] <= 2 && box[4] <= 3) print box[3] + ox, box[1]
			}' | sort -n
}
read -r PILL_X PILL_Y PILL_W PILL_H < <(answer_boxes "${CARD_FRAME}") || true
if [ -z "${PILL_H:-}" ]; then
	abandon_take "the-affirmative-answer-is-drawn" \
		"no accent-filled answer was found inside the card the stack drew"
fi
OUTLINED="$(outlined_answers "${CARD_FRAME}" "${EDGE_X}" "$(( PILL_Y - 2 ))" "${EDGE_W}" "$(( PILL_H + 4 ))")"
if [ "$(printf '%s\n' "${OUTLINED}" | grep -c . || true)" != "3" ]; then
	abandon_take "a-decision-offers-every-answer-the-host-accepts" \
		"the answer row draws $(printf '%s\n' "${OUTLINED}" | grep -c . || true) outlined answer(s) beside the accent one, not the three the wrapper accepts"
fi
LAST_OUTLINED_END="$(printf '%s\n' "${OUTLINED}" | tail -1 | awk '{ print $1 + $2 }')"
if (( LAST_OUTLINED_END > PILL_X )); then
	abandon_take "the-affirmative-answer-is-the-last-one" \
		"an outlined answer runs to ${LAST_OUTLINED_END}, past the accent answer's leading edge at ${PILL_X}"
fi
echo "scene: the card edges ${EDGE_W}px at ${EDGE_X},${EDGE_Y}, answering with three outlined" \
	"pills at $(printf '%s\n' "${OUTLINED}" | awk '{ printf "%s ", $1 }')and the accent one at ${PILL_X}" >&2

# ANSWERING IT. The pointer goes to the accent pill, which is the answer an
# operator reaches for, and the claim is what the host did with it: the card is
# gone and the turn it was holding finished with the tool's result in it.
move_px "$(( PILL_X + PILL_W / 2 ))" "$(( PILL_Y + PILL_H / 2 ))"
pause 0.3
click
if ! await_cards 0 60; then
	abandon_take "an-answer-releases-the-card" \
		"the approval card was still drawn 60s after its affirmative answer was clicked"
fi
if ! native_session_ready finished 2; then
	abandon_take "an-approved-call-runs" \
		"the turn never completed after its tool call was approved"
fi
pause 0.6
shot decision-answered

# ─── Three At Once, Against A Stack That Draws Two ───────────────────────────
# Three tools in one reply, so the wrapper raises three decisions concurrently:
# same-tool calls in a batch queue behind one card by design, and these are
# three different tools. The stack draws `max_visible` of them and folds the
# rest into one row that states how many are waiting.
TRIO_PROMPT="In one reply call exactly these three tools, once each: read with path README.md; search with type text and input TODO; bash with command 'echo scene'. Call nothing else afterwards."
submit_prompt "${TRIO_PROMPT}"
if ! await_cards "${STACK_MAX_VISIBLE}" 240; then
	abandon_take "a-stack-past-its-cap-folds" \
		"three tool calls did not leave the stack drawing its authored ${STACK_MAX_VISIBLE} cards within 240s"
fi
FOLDED_FRAME="${SCENE_RUNTIME_DIR}/folded.png"
probe_frame "${FOLDED_FRAME}"
pause 0.4
shot decisions-folded

# The row the rest folded into: under the lowest card the stack drew, one gap
# below its lower edge, and `overflow_collapsed_height_px` tall. Both numbers
# are authored, so the aim follows a retuned stack.
read -r LAST_X LAST_Y LAST_W LAST_H < <(edge_runs "${FOLDED_FRAME}" | tail -1) || true
if [ -z "${LAST_H:-}" ]; then
	abandon_take "the-folded-row-is-locatable" \
		"the folded frame carries no card edge to measure the row under"
fi
FOLD_Y=$(( LAST_Y + LAST_H + STACK_GAP + FOLD_ROW / 2 ))
FOLD_X=$(( LAST_X + LAST_W / 2 ))
if (( FOLD_Y >= WIN_Y + WIN_H - COMPOSER_BAND_H )); then
	abandon_take "the-folded-row-is-locatable" \
		"the derived fold row at ${FOLD_Y} is inside the composer band rather than above it"
fi

# OPENING IT. The row's height comes from the state and not from a paint-time
# refinement (§5.5), so the pointer's arrival has to change the layout: the
# cards above it move up and the waiting decisions it was holding are drawn.
move_px "${FOLD_X}" "${FOLD_Y}"
pause 1.2
OPENED_PX="$(screen_differs_from_frame_pixels_at "${FOLDED_FRAME}" "${STACK_BAND}")"
if [ "${OPENED_PX}" -lt 600 ]; then
	abandon_take "a-folded-row-opens-under-the-pointer" \
		"the stack band changed ${OPENED_PX} pixels when the pointer reached the folded row, under the ${FOLD_ROW}px row of text it opens to"
fi
shot decisions-folded-open

# AND CLOSING AGAIN. A row that opened and stayed open is a row that never read
# the pointer leaving, which is the same defect from the other side.
move_px "$(( SESSION_REGION_X + SESSION_REGION_W / 2 ))" "$(( WIN_Y + TITLEBAR_H + 24 ))"
pause 1.2
CLOSED_PX="$(screen_differs_from_frame_pixels_at "${FOLDED_FRAME}" "${STACK_BAND}")"
if [ "${CLOSED_PX}" -ge "$(( OPENED_PX / 4 ))" ]; then
	abandon_take "a-folded-row-closes-behind-the-pointer" \
		"the stack band is ${CLOSED_PX} pixels from the folded frame after the pointer left, against the ${OPENED_PX} it opened by"
fi
echo "scene: the folded row opened by ${OPENED_PX} pixels and closed back to ${CLOSED_PX}" >&2

# ─── Answering Every Waiting Decision ───────────────────────────────────────
# The stack is drained through the same accent answer, which also states that
# the fold is a queue rather than a count: each answer promotes the decision
# behind it into view, and the row is gone when nothing is left to fold.
for _ in $(seq 1 6); do
	DRAIN_FRAME="$(probe_stack)"
	read -r PILL_X PILL_Y PILL_W PILL_H < <(answer_boxes "${DRAIN_FRAME}") || true
	[ -z "${PILL_H:-}" ] && break
	move_px "$(( PILL_X + PILL_W / 2 ))" "$(( PILL_Y + PILL_H / 2 ))"
	pause 0.3
	click
	pause 2.0
	PILL_H=
done
if ! await_cards 0 90; then
	abandon_take "an-answered-stack-empties" \
		"cards were still drawn after every visible answer had been clicked"
fi

# ─── What These Frames State ───────────────────────────────────────────────
# Frame 1 is a real tool call the host stopped, drawn at the composer's own
# measure with the wrapper's four answers on it, and the off arm's frame 1 is
# the same prompt running unasked: that pair is the whole differential, and it
# is a setting rather than a keystroke, which is why the arms are two
# recordings.
#
# Frame 2 is the host acting on the answer the pointer gave, so the row is
# established as live rather than drawn. Frames 3 and 4 are three decisions
# against a stack that draws two: the cap held, the rest folded into one row,
# and the row opened for the pointer and closed behind it.
#
# WHAT IS NOT HERE. A plan card is not in this take: a plan arrives when the
# model presents one, and this recorder's model does not. Two claims about one
# therefore have no frame -- the fade over a body cut at
# `max_markdown_height_px`, and the flattening of the markdown a plan arrives
# in -- and they are the only parts of §5.5 without one. The fade is held by
# crates/veyyon-desktop-surface/tests/a-plan-cut-at-its-cap-fades-where-it-was-cut.rs
# and the mutation gate in .internal/mutate-card-decisions.py; the flattening by
# crates/veyyon-desktop/tests/a-decision-card-draws-text-and-never-the-markdown-it-arrived-in.rs
# and the mutation gate in .internal/check-plan-markdown-mutations.py.
#
# The approval card's own detail IS here, in frame 1 of the on arm: it is the
# text the tool wrapper's card states, and the host is what turns that card's
# markdown into the lines this pane draws.
