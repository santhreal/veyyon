#!/usr/bin/env bash
# Exercise persisted host output, transcript navigation, find, and panel transitions.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

PANEL_OVERLAY_BREAKPOINT="$(python3 -c 'import sys, tomllib; print(tomllib.load(open(sys.argv[1], "rb"))["right_panel"]["overlay_breakpoint_px"])' "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens/surface/panels.toml")"
if (( WIN_W < PANEL_OVERLAY_BREAKPOINT )); then
	k "ctrl+backslash"
	pause 0.5
fi

k "ctrl+a"
k "BackSpace"
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.5
shot navigation-model-filtered
k "Return"
pause 0.5
shot navigation-model-selected
# The composer is the last row of the window, so the point inside it is the one
# the prelude already derived from the window's own bottom edge. A y of 408 was
# a leftover of an earlier layout: it lands in the transcript, which takes the
# focus with it, and the prompt typed after it reaches nothing.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
t "Summarize this numbered list about editors in one sentence. Do not call tools."
# Submitted text exceeds the viewport even if the model replies briefly.
for line in $(seq 1 80); do
	k "shift+Return"
	t "Editor $line"
done
pause 0.3
shot long-draft
k "Return"
if ! native_session_ready finished; then
	abandon_take "native-transcript-produced" "the submitted turn did not produce a completed persisted transcript within 90s"
fi
# The take needs a second turn in the transcript, not a second long one: asked
# to acknowledge the note in a sentence, the 1.5B model restated all eighty
# editors and the reply persisted after the 90s the probe waits, which fails a
# take whose subject is navigation. One word ends the turn inside the window.
submit_prompt "Reply with the single word acknowledged. Do not call tools."
if ! native_session_ready finished 4; then
	abandon_take "native-second-turn-produced" "the second submitted turn did not complete within 90s"
fi
pause 0.5
shot transcript-tail

TRANSCRIPT_Y=$(( WIN_Y + (WIN_H > 481 ? 481 / 3 : WIN_H / 3) ))
move_px "$((WIN_X + WIN_W / 2))" "${TRANSCRIPT_Y}"
click
k "Home"
pause 0.5
shot transcript-head
k "Next"
pause 0.5
shot transcript-page
k "ctrl+f"
pause 0.3
# A match is a block that contains the query, not an occurrence inside one, so a
# word the long draft repeats eighty times is one match and Return has nowhere to
# step: the take before this one photographed the same frame under both names.
# Both prompts this scene submits end in the same instruction, so two operator
# turns match whatever the model replied.
t "do not call"
pause 0.4
shot transcript-find
k "Return"
pause 0.3
shot transcript-find-next
k "Escape"
pause 0.3

if (( WIN_W < PANEL_OVERLAY_BREAKPOINT )); then
	k "ctrl+backslash"
	pause 0.5
fi

k "ctrl+backslash"
pause 0.5
shot contextual-panel-closed
k "ctrl+backslash"
pause 0.5
shot contextual-panel-open
k "ctrl+k"
pause 0.3
t "new session"
pause 0.3
shot command-navigation
if ! native_session_ready before; then
	abandon_take "command-session-baseline" "the host returned no session snapshot before command execution"
fi
k "Return"
if ! native_session_ready created; then
	abandon_take "command-session-created" "the selected new-session command produced no host session"
fi
pause 0.5
shot command-created-session

# ─── What These Frames State ─────────────────────────────────────────────────
# Twelve frames named for a filtered picker, a draft past the viewport, a
# transcript walked from tail to head to the next page, a find and its next
# match, a panel closed and open, and a command that made a session. Every one
# of those is a claim, and a key the window never took publishes the frame it
# was already drawing under the name of the state it did not reach: a Home that
# went to a blurred transcript, a find bar the composer swallowed, a second
# primary-backslash that left the panel where it was.
#
# The regions come from the preamble this scene sources, so they follow the
# shed at whatever width the take is recorded at (§5.7).
#
# A surface-sized change reads in per mille and a control-sized one in pixels:
# a find field and its highlighted match are two small runs of text in a
# viewport, and they round to nothing against it.
MOVED_PER_MILLE=40
CONTROL_MIN_PIXELS=150

transcript_region
PICKER_CLOSED="$(shots_differ_per_mille navigation-model-filtered navigation-model-selected)"
if [ "${PICKER_CLOSED}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "the-model-row-was-taken" \
		"the session surface changed ${PICKER_CLOSED}/1000 when the filtered row was entered, so the picker is still on screen"
fi
GREW="$(shots_differ_per_mille navigation-model-selected long-draft)"
if [ "${GREW}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "the-draft-grew-the-card" \
		"the surface above the composer changed ${GREW}/1000 while eighty lines were typed, so the card never grew into it"
fi
WALKED="$(shots_differ_per_mille transcript-tail transcript-head)"
if [ "${WALKED}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "home-reached-the-first-turn" \
		"the transcript changed ${WALKED}/1000 on Home, so the key reached something other than the turns"
fi
PAGED="$(shots_differ_per_mille transcript-head transcript-page)"
if [ "${PAGED}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "a-page-moved-the-transcript" \
		"the transcript changed ${PAGED}/1000 on Next, so the page never turned"
fi
FOUND_PX="$(shots_differ_pixels transcript-page transcript-find)"
if [ "${FOUND_PX}" -lt "${CONTROL_MIN_PIXELS}" ]; then
	abandon_take "a-find-opened-on-the-transcript" \
		"the transcript changed ${FOUND_PX} pixels when a query was typed into find, under the ${CONTROL_MIN_PIXELS} a field and a match ink"
fi
NEXT_PX="$(shots_differ_pixels transcript-find transcript-find-next)"
if [ "${NEXT_PX}" -lt "${CONTROL_MIN_PIXELS}" ]; then
	abandon_take "a-find-steps-to-the-next-match" \
		"the transcript changed ${NEXT_PX} pixels on Return, under the ${CONTROL_MIN_PIXELS} a moved match inks"
fi
PANEL_MOVED="$(shots_differ_per_mille contextual-panel-closed contextual-panel-open)"
if [ "${PANEL_MOVED}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "the-panel-answered-its-chord" \
		"the session surface changed ${PANEL_MOVED}/1000 across the panel's two states, so primary-backslash drew the same surface twice"
fi
PALETTE_OPEN="$(shots_differ_per_mille contextual-panel-open command-navigation)"
if [ "${PALETTE_OPEN}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "the-command-palette-listed-a-row" \
		"the session surface changed ${PALETTE_OPEN}/1000 while a command was typed, so no palette drew over it"
fi
RAN="$(shots_differ_per_mille command-navigation command-created-session)"
if [ "${RAN}" -lt "${MOVED_PER_MILLE}" ]; then
	abandon_take "the-command-row-ran" \
		"the session surface changed ${RAN}/1000 when the row was entered, so the palette is still over the session it made"
fi
echo "scene: picker ${PICKER_CLOSED}/1000, draft ${GREW}/1000, home ${WALKED}/1000," \
	"page ${PAGED}/1000, find ${FOUND_PX}px, next ${NEXT_PX}px," \
	"panel ${PANEL_MOVED}/1000, palette ${PALETTE_OPEN}/1000, ran ${RAN}/1000" >&2
