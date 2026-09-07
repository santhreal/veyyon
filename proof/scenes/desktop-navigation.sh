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
COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + (WIN_H > 481 ? 408 : WIN_H - 98) ))
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
t "Editors: acknowledge this second note in one sentence. Do not call tools."
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
