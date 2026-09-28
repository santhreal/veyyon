#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 24 --rate-ms 20 --first-token-delay-ms 200
# The right panel's agents tab over a thread.
#
#   proof/record.sh --pair proof/scenes/desktop-panel-agents.sh
#
# After arm: ShowPanelTab {tab: agents}. The older panel has no agents tab (its
# tabs are Diff, File, Tree and Usage), so the before arm opens the panel with
# Ctrl+\ and the frame shows the panel it had in that place.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_turn "Summarize the working tree changes" 1
desk_panel_tab agents
shot panel-agents
