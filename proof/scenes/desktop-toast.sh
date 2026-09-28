#!/usr/bin/env bash
# scene-terminal: native
# desktop-config: tools.approval: {bash: prompt}
# An announcement card: an approval decision arriving on a thread that is not the
# open one. The prompt is submitted in one thread and a second thread is opened
# before the scripted model's shell tool call reaches the host.
#
#   proof/record.sh --pair proof/scenes/desktop-toast.sh
#
# Both arms submit, wait for the model's tool call, then open a new thread:
# either window drops a turn whose thread is left before the model request goes
# out. The scripted model sends its tool call at once, so the decision reaches the
# window while its thread is still open.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_new_thread
desk_draft "BENCHTOOL list the files in this project" 0.3
desk_submit
desk_model_wait tool 1 30
desk_action workspace::NewThread ctrl+n
desk_model_wait tool 1 30
desk_park
desk_idle 20
pause 1
shot toast
