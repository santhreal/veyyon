#!/usr/bin/env bash
# scene-terminal: native
# desktop-config: tools.approval: {bash: prompt}
# An announcement card: an approval decision arriving on a thread that is not the
# open one. The prompt is submitted in one thread and a second thread is opened
# before the scripted model's shell tool call reaches the host.
#
#   proof/record.sh --pair proof/scenes/desktop-toast.sh
#
# After arm: Submit then NewThread through the driver; before arm: Return then
# Ctrl+N (NewSession).
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_new_thread
desk_draft "BENCHTOOL list the files in this project" 0.3
desk_submit
desk_action workspace::NewThread ctrl+n
desk_model_wait tool 1 30
desk_park
desk_idle 20
pause 1
shot toast
