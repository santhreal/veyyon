#!/usr/bin/env bash
# scene-terminal: native
# desktop-config: tools.approval: {bash: prompt}
# An approval decision pending over the composer: the scripted model calls the
# shell tool, and `tools.approval` holds that call for the operator's answer.
#
#   proof/record.sh --pair proof/scenes/desktop-dock.sh
#
# Both arms submit the prompt through the new thread's composer and wait until
# the model has sent the tool call; the after arm then waits for the dock target.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_new_thread
desk_draft "BENCHTOOL list the files in this project" 0.3
desk_submit
desk_model_wait tool 1 30
desk_expect_target dock 30
desk_park
shot dock
