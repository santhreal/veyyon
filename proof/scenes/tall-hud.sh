#!/usr/bin/env bash
# A long session under chrome taller than the viewport, then walk the scrollback.
#
# The driver (scripts/demos/drive-tall-hud.ts) is started by SCENE_COMMAND: forty
# turns, a twenty-two row todo HUD that collapses and returns while an answer
# streams, and a pinned footer. Once the chrome outgrows the viewport the engine
# used to commit HUD rows into native scrollback, find them changed on the next
# frame, and repair that by erasing the scrollback and replaying the transcript —
# every frame of the turn. On screen that is the strobe; in the buffer it is the
# missing history this walk looks for.
#
# shift+PageUp is the terminal's own scrollback key, handled by the terminal and
# not by the program, so what it shows is what is really in the buffer.

# Forty turns, then forty streamed frames at 60ms, plus the first settle.
settle 7
shot stream-mid
sleep 2
shot stream-end

# Up through the scrollback a screenful at a time: forty turns are up there.
for step in 1 2 3 4 5; do
	k shift+Prior
	sleep 0.9
	shot "scrollback-${step}"
done

sleep 1
key_repeat shift+Next 5 0.5
shot back-to-live
sleep 1
