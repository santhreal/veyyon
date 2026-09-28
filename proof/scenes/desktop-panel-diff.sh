#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 24 --rate-ms 20 --first-token-delay-ms 200
# The right panel's diff tab over a thread, with two working-tree changes in the
# launch project (an edited README and a new staged file).
#
#   proof/record.sh --pair proof/scenes/desktop-panel-diff.sh
#
# After arm: ShowPanelTab {tab: diff}. Before arm: Ctrl+\ opens the panel on
# its Diff tab.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_dirty_tree
desk_ready
desk_turn "Summarize the working tree changes" 1
desk_panel_tab diff
shot panel-diff
