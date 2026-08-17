#!/usr/bin/env bash
# Twenty-four turns, then a tall answer that settles to a two-row tail.
#
# The driver (scripts/demos/blank-band-repro.ts) is started by SCENE_COMMAND, so
# this scene only waits for the turn to end short and then walks the terminal's
# own scrollback. shift+PageUp is xterm's key, handled by the terminal rather
# than the application, so it reads what is really in the buffer.
#
# With the fix the settled frame runs from the top of the window to the composer
# on the bottom row. Without it the rows above the tail are blank -- a
# screen-sized void with a stray fence and rule floating over the HUD.

# 24 turns at 160ms, 30 streamed rows at 70ms, then the settle: ~7s of driver
# plus startup.
settle 12
shot band-settled

# Up through the scrollback: every turn must be there.
for step in 1 2 3; do
	k shift+Prior
	sleep 0.9
	shot "scrollback-${step}"
done

sleep 1
key_repeat shift+Next 3 0.5
shot back-to-live
sleep 1
