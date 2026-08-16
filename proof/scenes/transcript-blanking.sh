#!/usr/bin/env bash
# Fourteen turns into a short viewport, then walk the terminal's own scrollback.
#
# The driver (scripts/demos/transcript-blanking-repro.ts) is started by
# SCENE_COMMAND, so this scene only has to wait for the conversation and then
# scroll. shift+PageUp is xterm's own scrollback key: it is handled by the
# terminal, not by the application, so it reads what is actually in the
# scrollback buffer rather than what the program would like to draw.
#
# With the fix, every turn is up there. Without it, the engine erased the
# buffer (ED3) each time the transcript compacted, and the walk finds a few
# rows where fourteen turns should be.

# Fourteen turns at 450ms, plus the settle before the first one.
settle 9
shot conversation-end

# Up through the scrollback a screenful at a time.
for step in 1 2 3 4 5; do
	k shift+Prior
	sleep 0.9
	shot "scrollback-${step}"
done

sleep 1
# Back down to the live view, so the recording ends where it started.
key_repeat shift+Next 5 0.5
shot back-to-live
sleep 1
