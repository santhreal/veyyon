#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 24 --rate-ms 20 --first-token-delay-ms 200
# The right panel's files tab over a thread: the launch project's tree.
#
#   proof/record.sh --pair proof/scenes/desktop-panel-files.sh
#
# After arm: ShowPanelTab {tab: files}. Before arm: Ctrl+\ opens the panel, then
# a click on its Tree tab, the older panel's file tree.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_dirty_tree
desk_ready
desk_turn "Summarize the working tree changes" 1
desk_panel_tab files 970 63
shot panel-files
