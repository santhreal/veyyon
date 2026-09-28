#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 48 --rate-ms 25 --first-token-delay-ms 300
# The session tree of a thread with two finished turns, opened in the thread
# column.
#
#   proof/record.sh --pair proof/scenes/desktop-tree.sh
#
# Both arms run the same two turns in a new thread. The after arm then opens the
# session tree through ToggleSessionTree. The older window has no session tree
# and binds no chord for it, so its arm shows the thread the tree opens over.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_turn "BENCHTOOL list the files in this project" 1
desk_draft "Summarize what the listing shows." 0.3
desk_submit
desk_model_wait reply 2 60
desk_idle 30
desk_action thread::ToggleSessionTree -
if desk_driven; then
	desk_expect_target tree.close 15
fi
desk_park
desk_settle 10 3
desk_idle 20
shot tree
