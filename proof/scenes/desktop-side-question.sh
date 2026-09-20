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
# that are not the conversation. In the other arm the window runs no such row
# and the words reach the model as an ordinary prompt, so the transcript gains
# an operator bubble and a reply rather than a labelled pair.
#
# The question is asked of a local model, so the answer is the session's own
# rather than a fixture:
#
#   SCENE_MOTION_FLOOR=5 proof/record.sh proof/scenes/desktop-side-question.sh
#
# The row is the host's and the label is the window's, so the other arm holds
# both back: the source at the commit before this one, and an executable built
# from it.
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     <this-commit> side-question-before
#   SCENE_ARM=before PROOF_BASE_REF=<this-commit>^ SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/side-question-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-side-question.sh
#
# WHAT IS MEASURED. One authored colour over the transcript column.
#   * `role.muted` is the ink a subordinate record is drawn in, and the
#     conversation itself is not drawn in it: prose is `foreground`, the
#     operator's own words sit on their bubble. So the muted ink the transcript
#     gains between the two frames is the pair this row wrote, and an arm that
#     drew a prompt and a reply instead gains none of it.
#   The colour is read from the theme this checkout ships, so a retheme moves
#   the reading with it.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

MUTED="$(theme_colour role.muted)"
echo "scene: a subordinate record is inked in ${MUTED}" >&2

# ─── Where The Pair Is Drawn ─────────────────────────────────────────────────
# The transcript column, which is everything between the titlebar and the band
# the composer occupies. The pair joins the turns there rather than attaching
# above the composer, because it is a record and not a decision.
TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( $(composer_band_top) - WIN_Y - TITLEBAR_H ))"
TRANSCRIPT_CROP="${TRANSCRIPT_CROP}+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"
echo "scene: the transcript column is ${TRANSCRIPT_CROP}" >&2

# Two rows of small prose ink several hundred core pixels; a word of muted
# chrome drifting into the column does not.
MUTED_PIXELS_MIN=300

muted_ink() { # <png> -> pixels of subordinate ink in the transcript column
	local counted
	counted="$(magick "$1" -crop "${TRANSCRIPT_CROP}" +repage \
		-fuzz 6% -fill white -opaque "${MUTED}" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "subordinate-ink-countable" \
				"counting ${MUTED} in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

# Somewhere with nothing under the pointer for every reading, so no hover fill
# is in one frame and not another.
PARK_X=$(( SESSION_REGION_X + SESSION_REGION_W / 2 ))
PARK_Y=$(( WIN_Y + TITLEBAR_H + 24 ))

# Run one row from the palette, by the query that names it and the words it
# is being run with.
run_command() { # <query>
	k "ctrl+k"
	pause 0.8
	t "$1"
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

# ─── The Transcript With Nothing Asked Beside It ─────────────────────────────
# The model picker left the editor focused and the preamble left a slash in
# it, so the draft is cleared: a draft in the composer is ink of its own and
# the reading below is of the column above it.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.4
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot nothing-asked
BEFORE_INK="$(muted_ink "${SCENE_OUT}/${SCENE_NAME}-nothing-asked.png")"
echo "scene: the column holds ${BEFORE_INK}px of subordinate ink at rest" >&2

# ─── Asking It ───────────────────────────────────────────────────────────────
run_command "btw name one file this project builds"
move_px "${PARK_X}" "${PARK_Y}"
# The answer is a whole provider turn, and the request settles on it rather
# than on its acceptance, so the frame is taken once it can be there.
pause 6.0
shot question-answered
AFTER_INK="$(muted_ink "${SCENE_OUT}/${SCENE_NAME}-question-answered.png")"
GAINED=$(( AFTER_INK - BEFORE_INK ))
echo "scene: the column holds ${AFTER_INK}px afterwards, ${GAINED}px of it new" >&2

case "${ARM}" in
after)
	if (( GAINED < MUTED_PIXELS_MIN )); then
		abandon_take "the-row-writes-the-pair" \
			"the transcript column gained ${GAINED}px of subordinate ink after \`/btw\` ran, \
under the ${MUTED_PIXELS_MIN} two rows of it ink, so the question reached no pair"
	fi
	echo "scene: after arm -- an empty column, then a question and its answer beside the work" >&2
	;;
before)
	if (( GAINED >= MUTED_PIXELS_MIN )); then
		abandon_take "the-baseline-has-no-such-row" \
			"the baseline drew ${GAINED}px of subordinate ink, so this arm is not the window \
from before the row existed"
	fi
	echo "scene: before arm -- the words reach the model as a prompt and no pair is written" >&2
	;;
*)
	abandon_take "the-arm-is-named" "SCENE_ARM=${ARM} is neither before nor after"
	;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is a session with nothing asked beside it: the column carries the
# conversation and nothing in the subordinate register.
#
# Frame 2 is the question and its answer, written by the host into that column
# under their own names, while the conversation is unchanged.
#
# WHAT IS NOT HERE. That neither row is recorded, which is a property of the
# session file rather than of the window and is
# packages/coding-agent/test/gui-host/a-question-asked-beside-the-work-is-answered-from-the-same-context.test.ts;
# and the labels themselves, which
# crates/veyyon-desktop/tests/transcript-roles-retain-their-register-and-searchable-content.rs
# pins by name.
