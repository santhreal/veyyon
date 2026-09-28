#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 48 --rate-ms 25 --first-token-delay-ms 300
# A finished turn in a new thread: the prompt, the shell tool call the scripted
# model makes (`ls`), its output, and the reply that follows.
#
#   proof/record.sh --pair proof/scenes/desktop-thread.sh
#
# Both arms type the same prompt into a new thread's composer and submit it; the
# after arm through NewThread, InsertText and Submit, the before arm by clicking
# the composer under "Create a session to begin", typing and pressing Return.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_turn "BENCHTOOL list the files in this project" 1
desk_park
shot thread
