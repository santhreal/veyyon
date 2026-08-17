#!/usr/bin/env bash
# A scene that touches nothing.
#
# The subject of the recording is SCENE_COMMAND itself -- a test run, a
# renderer, a probe -- so there is no pointer to move and no key to send. The
# scene's only job is to stay alive until the command has finished and its last
# screen has been readable for a few seconds, because xsession.sh stops the
# camera the moment this script returns.
#
# The command touches /tmp/scene-done when it finishes, so a run that takes four
# seconds produces a nine-second video rather than a two-minute one with a still
# frame on the end. SCENE_HOLD is the ceiling, reached only when the command
# never finishes.

# The scene is SOURCED by xsession.sh, so `exit` here would take the whole
# recorder down with it -- the camera stops, the mp4 survives because the trap
# runs, and the gif pass after the scene never happens. `break` leaves the loop
# and hands control back, which is what a scene owes its host.
deadline=$((SECONDS + ${SCENE_HOLD:-120}))
while ((SECONDS < deadline)); do
	if [[ -f /tmp/scene-done ]]; then
		sleep 5
		break
	fi
	sleep 0.5
done
