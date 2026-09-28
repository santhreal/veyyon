#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 200 --rate-ms 20 --first-token-delay-ms 1000
# A reply streaming into a new thread, word by word at the scripted model's fixed
# pace (one word every 20 ms after a one-second first-token delay), faster than
# the capture interval, so every captured frame can show new text.
#
#   proof/record.sh --pair proof/scenes/desktop-streaming.sh
#
# Publishes desktop-streaming-stream.webp (submit to the last word) and a still
# taken when the model has sent 80 words. Both arms submit through the new
# thread's composer, as in desktop-thread.sh.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_new_thread
desk_draft "Explain how the queue reducer orders revisions" 0.3
desk_clip_begin stream
desk_submit
desk_model_wait token 80 30
shot streaming
desk_model_wait reply 1 60
pause 1.5
desk_clip_end
