#!/usr/bin/env bash
# Twenty-four turns, then a tall answer that settles to a two-row tail.
#
# The driver (scripts/demos/blank-band-repro.ts) is started by SCENE_COMMAND, so
# this scene only waits for the turn to end short and then walks the terminal's
# own scrollback. shift+PageUp is xterm's key, handled by the terminal rather
# than the application, so it reads what is really in the buffer.
#
# The settled frame runs from the top of the window to the composer on the bottom
# row, and every turn is still in the scrollback the walk reads. This is a
# single-arm recording on purpose: the driver's header records the measurement
# showing that turning the fix off changes nothing reachable from this script, so
# a second arm here would be a comparison of two identical screens.

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
