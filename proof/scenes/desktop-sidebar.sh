#!/usr/bin/env bash
# scene-terminal: native
# The thread list: the seeded projects and their threads, the list filtered by a
# search, and a new thread started from it.
#
#   proof/record.sh --pair proof/scenes/desktop-sidebar.sh
#
# After arm: SearchThreads focuses the search field, the driver types the query,
# NewThread starts the thread. Before arm: a click on the "Search sessions" field,
# typed keys, then Ctrl+N (NewSession). The older queue lists the launch
# project's sessions only; the rebuilt sidebar groups every project.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
# The pointer rests on a row, so the frame shows the list's hover state.
move_px "$((WIN_X + 120))" "$((WIN_Y + 160))"
pause 0.6
shot sidebar

if desk_driven; then
	desk_action workspace::SearchThreads -
else
	desk_click sidebar-search 95 75
fi
desk_type "panel"
desk_park
desk_idle 20
shot sidebar-search

desk_key Escape
desk_idle 20
desk_action workspace::NewThread ctrl+n
desk_park
desk_idle 20
shot sidebar-new-thread
