#!/usr/bin/env bash
# The same surfaces on a serial loop, where there are no arms to attribute.
#
#   proof/docker/record-x11.sh proof/scenes/autoresearch-serial-screen.sh
#   proof/docker/record-x11-before.sh proof/scenes/autoresearch-serial-screen.sh
#
# `/autoresearch` at breadth 1 and `/autoswarm` above it are one loop with two
# shapes, and the surfaces state which one is running: the title, the arm column
# in the sidebar, the reviewer field in a run's detail, and the `arms` segment of
# the status row all exist only above breadth 1. A pair recorded on a swarm
# session proves none of that, so this records the serial shape of the same
# states.
#
# The seeded session (proof/docker/seed-autoresearch.ts, `serial`) is three logged
# runs in one segment with no arm and no certifier, which is what a serial loop
# writes.
#
# A still take, so both arms lower the motion gate:
#
#   SCENE_MOTION_FLOOR=1 proof/docker/record-x11.sh proof/scenes/autoresearch-serial-screen.sh
#   SCENE_MOTION_FLOOR=1 proof/docker/record-x11-before.sh proof/scenes/autoresearch-serial-screen.sh

settle 20

slash "/autoresearch cut parser wall time without changing its output"
settle 6
expect_screen "autoresearch" 90 "armed"
shot armed

k ctrl+x
settle 3
[ "${SCENE_ARM}" = "after" ] && expect_screen "esc close" 60 "screen"
shot screen

k "$(arm_key Down ctrl+shift+x)"
settle 3
[ "${SCENE_ARM}" = "after" ] && expect_screen "Playbook" 45 "playbook"
shot playbook

# The newest run in full: no arm row and no reviewer, because a serial loop has
# neither. This is the field set the swarm pair should be read against.
k Down
settle 2
shot run-newest

k "$(arm_key Down pgdn)"
settle 2
shot run-reverted

k Escape
settle 3
shot closed
