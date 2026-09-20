#!/usr/bin/env bash
# Run a goal from the native GPUI window, and stand it down again.
#
# Records visual evidence for:
#   1. goal-none   (a session with no goal: no chip in the composer's footer)
#   2. goal-chip   (an objective set from the palette, stated in one line)
#   3. goal-open   (that chip pressed, the card stating the goal in full)
#   4. goal-paused (the same goal paused from the palette, still stated)
#
# THE CLAIM. Goal mode was the terminal's alone. The window could attach to a
# session that was already driving one and see nothing of it: no objective, no
# turn count, no budget, no way to pause what was opening turns. The row that
# sets a goal, the chip that states it and the card that details it are the
# window reaching the same `GoalRuntime` the terminal drives, over the
# protocol, with no second state machine behind the window.
#
# Both arms run against a session with nothing else holding it, because a plan
# or a vibe mode blocks a goal from driving and that block is the other claim:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh proof/scenes/desktop-goal.sh
#
# The other arm holds the window and the host at the commit before the rows
# existed, where the palette offers no `/goal` and the footer carries no chip.
# The window's half is c1da93c4a2 and the host's is ee319d0ab3, so the hold
# names the earlier of the two and the executable is built from the tree
# before the window's:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --tree c1da93c4a2 goal-before
#   SCENE_ARM=before PROOF_BASE_REF=ee319d0ab3^ SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/goal-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-goal.sh
#
# That build writes into the workspace's own target directory, so the after
# executable at the default path is the before one until `cargo build -p
# veyyon-desktop` relinks it. Compare the two sha256 sums before recording:
# the recorder refuses an arm whose executable is byte-identical to the other.
#
# WHAT IS MEASURED. The tint that names the goal's status, over two bands of
# the window, in the two ways that tint is drawn.
#   * The chip is a filled pill, so it is read by `tint.working.fill` over the
#     card's own footer row. Its ink is a label a few pixels wide once
#     antialiasing has had it, which is under any floor that a stray glyph is
#     also under; its fill is the pill itself. The row is the card's, not the
#     composer band's, because the run bar under the card carries a `Working`
#     badge in the same fill and a band over both counts one for the other.
#   * The card is ringed in `tint.working.ink` (`cards::shell`), so a row of
#     that ink across half the card's measure is the card's own edge.
#   * `tint.attention` is what a paused goal carries instead, in both places,
#     so the fourth frame differs from the third in the colour of the chip and
#     the edge rather than in text a reader has to take on trust.
#   * The card's answer row is read for two things at once: the accent, which
#     is a filled pill, and the error tint's edge, which is the outline of the
#     answer that ends the goal. Both are placed as well as counted, so a row
#     that accents `Drop` is a different reading from one that accents `Pause`
#     beside it rather than the same reading at a different count.
#   Every colour is read from the theme this checkout ships, through the
#   preamble's own pass over each band, so a retheme moves the readings with
#   it.
#
# NOTHING HERE IS STAGED. The objective is typed into the palette, the goal
# record is the session's own, and the pause is the host's. No file is seeded.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

OBJECTIVE="Keep the desktop parity ledger honest"

# ─── Where The Composer Is In The Frame Being Read ───────────────────────────
# A goal drives turns, and turns fill the transcript: the card is centred
# while the session holds few (§5.4) and at the foot once it holds many, so it
# moves between one frame of this scene and the next. Each frame is therefore
# measured in itself rather than against a band taken once, which is how a
# chip read out of the first frame's geometry came back as no chip at all.
#
# Sets CARD_BAND, the band an attached card can occupy above the composer, and
# CHIP_ROW_CROP, the card's own footer row where the chip is drawn beside the
# model selector. The run bar under the card carries a `Working` badge in the
# same fill as an active goal's chip, so the row stops at the card's foot.
bands_from() { # <png>
	measure_composer_card "$1"
	local band_h=$(( CARD_TOP - WIN_Y - TITLEBAR_H ))
	if (( band_h < 160 )); then
		abandon_take "a-card-has-room" \
			"the window leaves ${band_h}px between the titlebar and the composer, which is \
less than a card is drawn in"
	fi
	CARD_BAND="${COMPOSER_CARD_W}x${band_h}+${COMPOSER_CARD_LEFT}+$(( WIN_Y + TITLEBAR_H ))"
	CHIP_ROW_CROP="${COMPOSER_CARD_W}x32+${COMPOSER_CARD_LEFT}+$(( MODEL_CHIP_Y - 16 ))"
}

# Somewhere with nothing under the pointer for every reading, so no hover fill
# is in one frame and not another.
PARK_X=$(( SESSION_REGION_X + SESSION_REGION_W / 2 ))
PARK_Y=$(( WIN_Y + TITLEBAR_H + 24 ))

# A chip is a filled pill about a fifth of the footer row across; a rounded
# corner blended against the card is a handful of pixels. Under this and the
# footer states no goal.
CHIP_PIXELS_MIN=400

# ─── What The Frame States About The Goal ────────────────────────────────────
# The status tint is read twice over: once in the card's footer row, where the
# chip is the window's persistent statement that a goal exists, and once over
# the card band, where a ring across half the measure is the card's own edge.
chip_reading() { # <png> <tint-fill-token> -> "COUNT CX CY" in the row's own coordinates
	local dump="${TMPDIR}/frame-compare/goal-chip.txt" ink
	mkdir -p "${TMPDIR}/frame-compare"
	ink="$(theme_colour "$2")"
	magick "$1" -crop "${CHIP_ROW_CROP}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${ink#\#}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")


def rgb(text):
	return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


wanted = rgb(sys.argv[2].upper())
# The working fill's nearest neighbour in this theme is the attention fill,
# thirteen steps away on the red channel, so four cannot collect one.
columns, rows = [], []
for line in open(sys.argv[1], encoding="ascii"):
	pixel = PIXEL.match(line)
	if not pixel:
		continue
	colour = rgb(pixel.group(3).upper())
	if all(abs(a - b) <= 4 for a, b in zip(colour, wanted)):
		columns.append(int(pixel.group(1)))
		rows.append(int(pixel.group(2)))

if not columns:
	print("0 0 0")
	raise SystemExit(0)
print(f"{len(columns)} {sum(columns) // len(columns)} {sum(rows) // len(rows)}")
PY
}

chip_pixels() { # <png> <tint-fill-token> -> pixels of that fill in the card's footer row
	local count cx cy
	read -r count cx cy < <(chip_reading "$1" "$2")
	printf '%s' "${count}"
}

# The middle of the chip, on the screen: the footer is laid out with the
# composer and a chip appearing beside the model selector moves everything
# after it, so where the chip is is a property of the frame it is in.
chip_centre() { # <png> <tint-fill-token> -> "X Y" on the screen
	local count cx cy offsets
	read -r count cx cy < <(chip_reading "$1" "$2")
	if (( count < CHIP_PIXELS_MIN )); then
		abandon_take "the-chip-is-on-the-screen" \
			"the card's footer row carries ${count}px of $2, which is no chip to press"
	fi
	offsets="${CHIP_ROW_CROP#*+}"
	# Newline-terminated: a caller reads this with `read`, which reports
	# failure on an unterminated line and ends the take under `set -e`.
	printf '%s %s\n' "$(( ${offsets%%+*} + cx ))" "$(( ${offsets##*+} + cy ))"
}

goal_reading() { # <png> <tint-ink-token> -> "RING_PX TOP BOTTOM ACCENT_PX"
	card_reading "$1" "${CARD_BAND}" "${COMPOSER_CARD_W}" "$2"
}

# Whether a card ringed in the named status is up in the frame just taken, with
# the reading printed either way: an absence is a reading too, and the first
# frame is written around one.
card_state() { # <png> <tint-ink-token> -> "0" or "1", and the reading on stderr
	local ring top bottom accent
	read -r ring top bottom accent < <(goal_reading "$1" "$2")
	echo "scene: $(basename "$1") rings ${ring}px of $2 between y ${top} and ${bottom}," \
		"with ${accent}px of accent between them" >&2
	if (( bottom > top )); then
		printf '1'
	else
		printf '0'
	fi
}

# ─── What The Card Invites ───────────────────────────────────────────────────
# `Drop` ends the goal, so it is drawn as an edge in the error tint with no
# fill behind it, and the accent goes to the control beside it. Both are read
# between the card's own edges, counted and placed: the accent is a filled
# pill of some hundreds of pixels and the destructive answer is a hairline
# ring of some tens, and the two are told apart by where their middles sit.
# An accent to the right of the error edge is the row accenting the answer
# that discards the run, which is the reading this scene exists to refuse.
answer_row_reading() { # <png> <tint-ink-token> -> "ACCENT_PX ACCENT_CX ERROR_PX ERROR_CX"
	local dump="${TMPDIR}/frame-compare/goal-answers.txt" ring accent error
	mkdir -p "${TMPDIR}/frame-compare"
	ring="$(theme_colour "$2")"
	accent="$(theme_colour role.accent)"
	error="$(theme_colour tint.error.fill)"
	magick "$1" -crop "${CARD_BAND}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${ring#\#}" "${accent#\#}" "${error#\#}" "${COMPOSER_CARD_W}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")


def rgb(text):
	return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def near(colour, wanted, tolerance):
	return all(abs(a - b) <= tolerance for a, b in zip(colour, wanted))


ring, accent, error = (rgb(argument.upper()) for argument in sys.argv[2:5])
width = int(sys.argv[5])
# The accent's nearest neighbour is the focus colour, twenty-seven steps away
# on one channel; the error fill's is the card's own ground, forty-seven away
# on the red channel. Neither collects the other.
ring_rows, marks = {}, {"accent": [], "error": []}
for line in open(sys.argv[1], encoding="ascii"):
	found = PIXEL.match(line)
	if not found:
		continue
	column, row, colour = int(found.group(1)), int(found.group(2)), rgb(found.group(3).upper())
	if near(colour, ring, 3):
		ring_rows[row] = ring_rows.get(row, 0) + 1
	elif near(colour, accent, 10):
		marks["accent"].append((column, row))
	elif near(colour, error, 4):
		marks["error"].append((column, row))

edges = sorted(row for row, count in ring_rows.items() if count >= width // 2)
if not edges:
	print("0 0 0 0")
	raise SystemExit(0)

top, bottom = edges[0], edges[-1]
reading = []
for name in ("accent", "error"):
	inside = [column for column, row in marks[name] if top < row < bottom]
	reading += [len(inside), sum(inside) // len(inside) if inside else 0]
print(" ".join(str(number) for number in reading))
PY
}

# A filled pill against a hairline ring of the same shape: the fill is the
# whole of it and the ring is its outline, so the two floors are an order
# apart. Under either the card is drawing no such answer at all.
ACCENT_PILL_MIN=400
ERROR_EDGE_MIN=60

# Run one row from the palette, by the query that names it, with whatever the
# row takes after it typed in the same draft.
run_command() { # <query>
	k "ctrl+k"
	pause 0.8
	t "$1"
	pause 0.8
	k "Return"
	pause 1.5
}

# ─── The Window With No Goal ─────────────────────────────────────────────────
# The preamble left a slash in the draft and the editor focused, so the draft
# is cleared: a goal set from the palette is the claim, and a draft under the
# card is a different frame. The aim comes from the screen as it stands, since
# the preamble measured the card before its own turns landed.
measure_composer_card
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.4
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot goal-none
NONE_FRAME="${SCENE_OUT}/${SCENE_NAME}-goal-none.png"
bands_from "${NONE_FRAME}"
NONE_CHIP="$(chip_pixels "${NONE_FRAME}" tint.working.fill)"
NONE_CARD="$(card_state "${NONE_FRAME}" tint.working.ink)"
echo "scene: with no goal the footer row carries ${NONE_CHIP}px of the working fill" >&2

# ─── Setting One ─────────────────────────────────────────────────────────────
run_command "goal ${OBJECTIVE}"
move_px "${PARK_X}" "${PARK_Y}"
pause 1.5
shot goal-chip
CHIP_FRAME="${SCENE_OUT}/${SCENE_NAME}-goal-chip.png"
bands_from "${CHIP_FRAME}"
DRIVING_CHIP="$(chip_pixels "${CHIP_FRAME}" tint.working.fill)"
CHIP_CARD="$(card_state "${CHIP_FRAME}" tint.working.ink)"
echo "scene: with a goal driving the footer row carries ${DRIVING_CHIP}px of the working fill" >&2

# ─── Opening The Card It States ──────────────────────────────────────────────
# The chip is pressed where the frame just taken says it is, rather than at a
# point computed from the composer: the footer lays out with the composer, and
# a chip that arrived with the goal moved everything drawn after it.
if (( DRIVING_CHIP >= CHIP_PIXELS_MIN )); then
	read -r CHIP_X CHIP_Y < <(chip_centre "${CHIP_FRAME}" tint.working.fill)
	echo "scene: the goal chip is at ${CHIP_X},${CHIP_Y}" >&2
	move_px "${CHIP_X}" "${CHIP_Y}"
	pause 0.4
	click
	pause 1.0
fi
move_px "${PARK_X}" "${PARK_Y}"
pause 0.8
shot goal-open
OPEN_FRAME="${SCENE_OUT}/${SCENE_NAME}-goal-open.png"
bands_from "${OPEN_FRAME}"
DRIVING_CARD="$(card_state "${OPEN_FRAME}" tint.working.ink)"
read -r OPEN_ACCENT OPEN_ACCENT_CX OPEN_ERROR OPEN_ERROR_CX \
	< <(answer_row_reading "${OPEN_FRAME}" tint.working.ink)
echo "scene: the driving card's answers carry ${OPEN_ACCENT}px of accent about column" \
	"${OPEN_ACCENT_CX} and ${OPEN_ERROR}px of the error edge about column ${OPEN_ERROR_CX}" >&2

# ─── Standing It Down ────────────────────────────────────────────────────────
# From the palette rather than from the card's own control, because the claim
# is the host driving the runtime: a press of a control the window drew proves
# the window, and this proves the round trip. The card stays up across it, so
# the status is read off one surface in two states.
run_command "goal pause"
move_px "${PARK_X}" "${PARK_Y}"
pause 1.5
shot goal-paused
PAUSED_FRAME="${SCENE_OUT}/${SCENE_NAME}-goal-paused.png"
bands_from "${PAUSED_FRAME}"
PAUSED_WORKING="$(card_state "${PAUSED_FRAME}" tint.working.ink)"
PAUSED_ATTENTION="$(card_state "${PAUSED_FRAME}" tint.attention.ink)"
PAUSED_CHIP_WORKING="$(chip_pixels "${PAUSED_FRAME}" tint.working.fill)"
PAUSED_CHIP_ATTENTION="$(chip_pixels "${PAUSED_FRAME}" tint.attention.fill)"
read -r PAUSED_ACCENT PAUSED_ACCENT_CX PAUSED_ERROR PAUSED_ERROR_CX \
	< <(answer_row_reading "${PAUSED_FRAME}" tint.attention.ink)
echo "scene: the paused card's answers carry ${PAUSED_ACCENT}px of accent about column" \
	"${PAUSED_ACCENT_CX} and ${PAUSED_ERROR}px of the error edge about column" \
	"${PAUSED_ERROR_CX}" >&2
echo "scene: paused, the footer row carries ${PAUSED_CHIP_WORKING}px of the working fill and" \
	"${PAUSED_CHIP_ATTENTION}px of the attention fill" >&2

case "${ARM}" in
after)
	if (( NONE_CHIP >= CHIP_PIXELS_MIN )) || [ "${NONE_CARD}" = "1" ]; then
		abandon_take "a-session-without-a-goal-states-none" \
			"the window states a goal on a session that has none, so the chip is drawn off \
something other than the goal record"
	fi
	if (( DRIVING_CHIP < CHIP_PIXELS_MIN )); then
		abandon_take "the-goal-reaches-the-footer" \
			"the card's footer row carries ${DRIVING_CHIP}px of the working fill after an \
objective was set, so the goal reached no chip"
	fi
	if [ "${CHIP_CARD}" = "1" ]; then
		abandon_take "the-chip-is-not-the-card" \
			"a card is up before the chip was pressed, so the goal takes the band over \
instead of stating itself in one line"
	fi
	if [ "${DRIVING_CARD}" != "1" ]; then
		abandon_take "the-goal-states-itself" \
			"no card ringed in the working tint is up after an objective was set, so the \
objective reached no surface"
	fi
	if [ "${PAUSED_ATTENTION}" != "1" ]; then
		abandon_take "a-paused-goal-says-so" \
			"the card is not ringed in the attention tint after \`/goal pause\`, so the pause \
reached the runtime without reaching the window"
	fi
	if [ "${PAUSED_WORKING}" = "1" ]; then
		abandon_take "a-paused-goal-is-not-driving" \
			"the card is still ringed as driving after \`/goal pause\`, so the window states \
two statuses at once"
	fi
	if (( PAUSED_CHIP_ATTENTION < CHIP_PIXELS_MIN )) || (( PAUSED_CHIP_WORKING > 0 )); then
		abandon_take "a-paused-goal-says-so-in-the-footer" \
			"the chip carries ${PAUSED_CHIP_WORKING}px of the working fill and \
${PAUSED_CHIP_ATTENTION}px of the attention fill after \`/goal pause\`, so the line the \
operator reads while the card is closed states the status it had before"
	fi
	for state in "driving ${OPEN_ACCENT} ${OPEN_ACCENT_CX} ${OPEN_ERROR} ${OPEN_ERROR_CX}" \
		"paused ${PAUSED_ACCENT} ${PAUSED_ACCENT_CX} ${PAUSED_ERROR} ${PAUSED_ERROR_CX}"; do
		read -r which accent accent_cx error error_cx <<<"${state}"
		if (( error < ERROR_EDGE_MIN )); then
			abandon_take "the-answer-that-ends-the-goal-is-marked" \
				"the ${which} card's answers carry ${error}px of the error edge, so the \
control that discards the run is drawn as an ordinary answer"
		fi
		if (( accent < ACCENT_PILL_MIN )); then
			abandon_take "the-card-invites-an-answer" \
				"the ${which} card's answers carry ${accent}px of accent, so the card offers \
nothing to press and the row it does draw reads as two refusals"
		fi
		if (( accent_cx >= error_cx )); then
			abandon_take "the-accent-is-not-on-the-drop" \
				"the ${which} card's accent sits about column ${accent_cx}, at or past the \
error edge about column ${error_cx}, so the answer the card invites is the one that ends \
the goal"
		fi
	done
	echo "scene: after arm -- no goal, a goal in the footer, its card, then that card paused" >&2
	;;
before)
	if (( DRIVING_CHIP >= CHIP_PIXELS_MIN )) || [ "${DRIVING_CARD}" = "1" ]; then
		abandon_take "the-baseline-has-no-such-row" \
			"the baseline stated a goal, so this arm is not the window from before the rows \
existed"
	fi
	echo "scene: before arm -- the palette offers no goal, and the footer stays empty" >&2
	;;
*)
	abandon_take "the-arm-is-named" "SCENE_ARM=${ARM} is neither before nor after"
	;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is a session the window can say nothing about, which is every session
# an operator drove a goal on from the window before these rows existed.
#
# Frame 2 is an objective typed into the palette reaching the session's own
# goal record and coming back as one line in the footer, which is what the
# window states about a goal while the work is what the operator is reading.
#
# Frame 3 is that line pressed: the objective, the turns it has taken, the time
# it has run and the budget it is spending against, with the controls the
# status accepts. Its answer row states which press the card is for: `Pause`
# carries the accent, and `Drop`, which ends the run, carries the error tint's
# edge and no fill to invite it.
#
# Frame 4 is the same goal paused over the protocol. The card is still up and
# still states the objective; its edge carries the attention tint instead of
# the working one, which is the window reading a status it was told rather than
# one it decided.
#
# WHAT IS NOT HERE. The continuation turns themselves, which depend on a model
# rather than on this window and are
# packages/coding-agent/test/goals/a-goal-drives-a-turn-only-when-nothing-else-holds-the-session.test.ts;
# the budget ceiling, which needs a goal run to exhaustion; and what the host
# does with each control, which is
# packages/coding-agent/test/gui-host/a-goal-set-from-the-window-drives-turns-and-states-itself.test.ts.
