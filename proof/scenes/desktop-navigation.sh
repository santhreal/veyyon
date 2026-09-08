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
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
# The take needs a second turn in the transcript, not a second long one: asked
# to acknowledge the note in a sentence, the 1.5B model restated all eighty
# editors and the reply persisted after the 90s the probe waits, which fails a
# take whose subject is navigation. One word ends the turn inside the window.
t "Reply with the single word acknowledged. Do not call tools."
k "Return"
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
t "editors"
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
