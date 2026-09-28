#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tool-call-delay-ms 3000
# desktop-config: tools.approval: {bash: prompt}
# An announcement card: an approval decision raised on a thread that is not the
# open one. The prompt is submitted in one thread and a second thread is opened
# at once; the scripted model holds its shell tool call for three seconds, so the
# call reaches a turn running in the background.
#
#   proof/record.sh --pair proof/scenes/desktop-toast.sh
#
# Both arms submit and open a new thread. The after arm then waits until the
# model has sent the tool call. The before arm's host ends the turn of the thread
# it leaves before the turn's request reaches the model, so no tool call follows;
# that arm waits out the model's hold instead. No driver target covers the toast
# stack, so both arms then wait for the window's pixels to hold still.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_new_thread
desk_draft "BENCHTOOL list the files in this project" 0.3
desk_submit
desk_new_thread
if [ "${SCENE_ARM:-after}" = "after" ]; then
	desk_model_wait tool 1 30
else
	pause 5
fi
desk_park
desk_settle 20
desk_idle 20
pause 1
shot toast
