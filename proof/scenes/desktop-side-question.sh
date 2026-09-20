#!/usr/bin/env bash
# Ask a question beside the work from the native GPUI window.
#
# Records visual evidence for:
#   1. nothing-asked    (a session whose transcript holds no side question)
#   2. question-answered (the same window after `/btw`, the pair in the transcript)
#
# THE CLAIM. `/btw` is answered by the host from the session's own context and
# drawn as its own pair of rows: the question under one name, the answer under
# another, both in the subordinate register the transcript keeps for records
# that are not the conversation. In the other arm no host offers the row, so
# the same keystrokes reach the slash menu, which states no matching item, and
# the words are left in the draft: the column is the column it was.
#
# The question is asked of a local model, so the answer is the session's own
# rather than a fixture:
#
#   SCENE_MOTION_FLOOR=5 proof/record.sh proof/scenes/desktop-side-question.sh
#
# The row is the host's and the label is the window's, so the other arm holds
# both back: the whole tree before the commit that brought them, and an
# executable built from that tree.
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --tree <this-commit> side-question-before
#   BEFORE=.internal/before-tokens/side-question-before/crates/veyyon-desktop-tokens
#   SCENE_ARM=before PROOF_BASE_REF=<this-commit>^ SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/side-question-before/veyyon-desktop \
#     PROOF_TOKENS_DIR="/repo/${BEFORE}/tokens" PROOF_THEMES_DIR="/repo/${BEFORE}/themes" \
#     proof/docker/record-native.sh proof/scenes/desktop-side-question.sh
#
# WHAT IS MEASURED. Two authored colours over the transcript column, because
# neither states the claim on its own.
#   * `role.muted` is the ink a subordinate record is drawn in, so the pair
#     this row writes reads there. A count of it alone does not separate that
#     pair from the conversation: prose is drawn in `foreground` against a
#     dark ground, and the antialiased edge of every glyph passes through the
#     subordinate colour on its way down. The column reads 703px of it with
#     one ordinary turn in it and no record of any kind.
#   * `role.foreground` is the ink the conversation is drawn in, and a
#     subordinate row never reaches it. It is what separates a pair written
#     beside the work from words that landed in the work: the after arm gains
#     subordinate ink and not one pixel of prose. The before arm writes
#     neither, so its reading is taken with the slash menu dismissed and the
#     draft cleared, and both colours come back to the column they were.
#   Both are read from the theme this checkout ships, so a retheme moves the
#   readings with it.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

MUTED="$(theme_colour role.muted)"
PROSE="$(theme_colour role.foreground)"
echo "scene: a subordinate record is inked in ${MUTED}, the conversation in ${PROSE}" >&2

# ─── Where The Pair Is Drawn ─────────────────────────────────────────────────
# The transcript column, which is everything between the titlebar and the band
# the composer occupies. The pair joins the turns there rather than attaching
# above the composer, because it is a record and not a decision.
#
# Where that band sits depends on what the session holds: a session with no
# turns in it centres the composer in the column and fills the space above it
# with the empty state, which is drawn in the same subordinate ink this scene
# counts. So the rectangle is taken below, once a turn has landed and the
# window is in the shape both frames are read in.
transcript_crop() {
	local height=$(( $(composer_band_top) - WIN_Y - TITLEBAR_H ))
	printf '%sx%s+%s+%s' \
		"${SESSION_REGION_W}" "${height}" "${SESSION_REGION_X}" "$(( WIN_Y + TITLEBAR_H ))"
}

# The question this scene asks inks 139px of subordinate ink on its own, so a
# column that gains more than 150px of it gained a second row as well.
PAIR_INK_MIN=150

# A word of prose inks tens of pixels. Both registers read the column they
# read before -- the conversation while the pair is written in the after arm,
# and the whole column in the before arm, where nothing was written at all --
# so this tolerance admits a stray glyph of drift and no row.
COLUMN_DRIFT_MAX=24

ink() { # <png> <colour> -> pixels of that ink in the transcript column
	local counted
	counted="$(magick "$1" -crop "${TRANSCRIPT_CROP}" +repage \
		-fuzz 6% -fill white -opaque "$2" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "column-ink-countable" \
				"counting $2 in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

# Somewhere with nothing under the pointer for every reading, so no hover fill
# is in one frame and not another.
PARK_X=$(( SESSION_REGION_X + SESSION_REGION_W / 2 ))
PARK_Y=$(( WIN_Y + TITLEBAR_H + 24 ))

# Run one command from the composer, spelled with the message it is run with.
#
# A command that takes a message is run the way an operator runs it: the slash
# menu is the draft, so the whole line is typed into the composer and Enter
# takes the row the first word names. The palette's own search field is not
# that path -- it is a search, and a message typed into it is scored against
# the rows rather than carried to the command.
run_command() { # <command with its message, without the leading slash>
	move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
	click
	k "ctrl+a"
	k "BackSpace"
	t "/$1"
	pause 0.8
	k "Return"
	pause 1.5
}

# ─── The Model The Question Is Asked Of ──────────────────────────────────────
# A side question is a provider request like any other, so the session states
# which model answers it rather than leaving whatever the profile held.
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

# ─── The Turn The Question Is Asked Beside ───────────────────────────────────
# The pair joins a conversation, and a session with nothing in it is not one:
# its column draws the empty state where the turns would be and centres the
# composer in the space. One ordinary turn puts the window in the shape both
# frames are read in and gives the question something to be beside.
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
submit_prompt "answer in one short sentence: what is a compiler?"
if ! native_session_ready finished 2; then
	abandon_take "native-turn-recorded" \
		"the turn the question is asked beside did not complete within the turn ceiling"
fi
pause 1.0

# The composer dropped to the foot of the window when the column filled, so
# every aim placed against the card, and the band a reading crops to, are
# measured again before a frame is read through either.
measure_composer_card
TRANSCRIPT_CROP="$(transcript_crop)"
echo "scene: the transcript column is ${TRANSCRIPT_CROP}" >&2

# ─── The Transcript With Nothing Asked Beside It ─────────────────────────────
# The draft is cleared first: a draft in the composer is ink of its own and
# the reading below is of the column above it.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.4
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot nothing-asked
BEFORE_PAIR="$(ink "${SCENE_OUT}/${SCENE_NAME}-nothing-asked.png" "${MUTED}")"
BEFORE_PROSE="$(ink "${SCENE_OUT}/${SCENE_NAME}-nothing-asked.png" "${PROSE}")"
echo "scene: the turn alone holds ${BEFORE_PAIR}px subordinate, ${BEFORE_PROSE}px prose" >&2

# ─── Asking It ───────────────────────────────────────────────────────────────
# A side question is recorded nowhere, so the host probes the other desktop
# scenes wait on -- the session's own file, the message count it carries --
# state nothing about this one. What the window draws is the only report there
# is, so the wait reads the column: it changes while the pair arrives and
# stops once the answer is whole.
#
# The frame it is read against is taken BEFORE the command is typed, not after
# it has run. This model answers a question of a warm session in under a
# second, so a wait that photographs the column first and then asks whether it
# has moved since sees a column that already holds the answer, never observes
# the change, and spends its whole ceiling waiting for one.
#
# Both arms move it. The arm without the row sends the words as an ordinary
# prompt, which draws a bubble and a reply; a column that never moves at all
# is a question that reached no model, and the take is abandoned rather than
# photographed.
await_answer() { # <frame-from-before-the-command> <ceiling-seconds>
	local probe="$1" ceiling="${2:-90}" waited=0 moved=0 still=0 changed
	local rolling="${TMPDIR}/side-answer-rolling.png"
	cp "${probe}" "${rolling}"
	while (( waited < ceiling )); do
		sleep 1
		waited=$(( waited + 1 ))
		changed="$(screen_differs_from_frame_pixels_at "${rolling}" "${TRANSCRIPT_CROP}")"
		probe_frame "${rolling}"
		if (( changed > 0 )); then
			moved=1
			still=0
			continue
		fi
		still=$(( still + 1 ))
		if (( moved == 1 && still >= 3 )); then
			echo "scene: the column settled ${waited}s after the question" >&2
			return 0
		fi
	done
	abandon_take "the-answer-arrives" \
		"the transcript column never changed and settled within ${ceiling}s of \`/btw\` running"
}

ASKED_FROM="${TMPDIR}/side-question-before-asking.png"
probe_frame "${ASKED_FROM}"
run_command "btw name one file this project builds"
move_px "${PARK_X}" "${PARK_Y}"
await_answer "${ASKED_FROM}" 90
shot question-answered

case "${ARM}" in
after)
	AFTER_PAIR="$(ink "${SCENE_OUT}/${SCENE_NAME}-question-answered.png" "${MUTED}")"
	AFTER_PROSE="$(ink "${SCENE_OUT}/${SCENE_NAME}-question-answered.png" "${PROSE}")"
	PAIR_GAINED=$(( AFTER_PAIR - BEFORE_PAIR ))
	PROSE_GAINED=$(( AFTER_PROSE - BEFORE_PROSE ))
	echo "scene: the column gained ${PAIR_GAINED}px subordinate and ${PROSE_GAINED}px prose" >&2
	if (( PAIR_GAINED < PAIR_INK_MIN )); then
		abandon_take "the-row-writes-the-pair" \
			"the transcript column gained ${PAIR_GAINED}px of subordinate ink after \`/btw\` \
ran, under the ${PAIR_INK_MIN} a question and an answer ink, so the question reached no pair"
	fi
	if (( PROSE_GAINED > COLUMN_DRIFT_MAX )); then
		abandon_take "the-conversation-is-untouched" \
			"the column gained ${PROSE_GAINED}px of prose while the pair was written, over \
the ${COLUMN_DRIFT_MAX} a stray glyph inks, so the words landed in the work, not beside it"
	fi
	echo "scene: after arm -- a question and its answer beside a conversation that did not move" >&2
	;;
before)
	# The frame above is this arm's evidence: the slash menu open over the
	# column with no row to offer, and the words still in the draft. Both are
	# ink of their own, so the reading of the column is taken with the menu
	# dismissed and the draft cleared -- what is left is what those keystrokes
	# wrote, which is nothing.
	k "Escape"
	pause 0.4
	move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
	click
	k "ctrl+a"
	k "BackSpace"
	pause 0.4
	move_px "${PARK_X}" "${PARK_Y}"
	pause 0.6
	REFUSED="${TMPDIR}/side-question-column-after-refusal.png"
	probe_frame "${REFUSED}"
	PAIR_GAINED=$(( $(ink "${REFUSED}" "${MUTED}") - BEFORE_PAIR ))
	PROSE_GAINED=$(( $(ink "${REFUSED}" "${PROSE}") - BEFORE_PROSE ))
	echo "scene: the column moved ${PAIR_GAINED}px subordinate and ${PROSE_GAINED}px prose" >&2
	if (( PAIR_GAINED > COLUMN_DRIFT_MAX || PAIR_GAINED < -COLUMN_DRIFT_MAX )); then
		abandon_take "the-baseline-writes-no-record" \
			"the column moved ${PAIR_GAINED}px of subordinate ink in this arm, over the \
${COLUMN_DRIFT_MAX} a stray glyph inks, so something was written beside the work and this is not \
the window from before the row existed"
	fi
	if (( PROSE_GAINED > COLUMN_DRIFT_MAX || PROSE_GAINED < -COLUMN_DRIFT_MAX )); then
		abandon_take "the-baseline-keeps-its-conversation" \
			"the column moved ${PROSE_GAINED}px of prose in this arm, over the \
${COLUMN_DRIFT_MAX} a stray glyph inks, so the words reached the model as a turn rather than \
being refused by a menu that has no row for them"
	fi
	echo "scene: before arm -- no row to run, nothing written beside the work" >&2
	;;
*)
	abandon_take "the-arm-is-named" "SCENE_ARM=${ARM} is neither before nor after"
	;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is a session with nothing asked beside it: the column carries one
# turn of conversation and no record under any name.
#
# Frame 2 is the question and its answer, written by the host into that column
# under their own names, with the conversation above them at the pixel it was.
# The same frame of the before arm is the slash menu with no row to offer for
# those words, the column behind it as it was and the words still in the draft.
#
# WHAT IS NOT HERE. That neither row is recorded, which is a property of the
# session file rather than of the window and is
# packages/coding-agent/test/gui-host/a-question-asked-beside-the-work-is-answered-from-the-same-context.test.ts;
# and the labels themselves, which
# crates/veyyon-desktop/tests/transcript-roles-retain-their-register-and-searchable-content.rs
# pins by name.
