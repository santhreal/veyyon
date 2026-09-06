#!/usr/bin/env bash
# The autoswarm run screen, and the widget it replaced, on the same session.
#
#   proof/docker/record-x11.sh proof/scenes/autoresearch-run-screen.sh
#   proof/docker/record-x11-before.sh proof/scenes/autoresearch-run-screen.sh
#
# A loop used to report itself in a widget above the composer: one collapsed line,
# `ctrl+x` to expand it to eighteen rows of table, `ctrl+shift+x` for the same
# table as an overlay. It now reports itself in one status row, and `ctrl+x` opens
# a run screen: every run on the left, the highlighted one in full on the right.
#
# Every shot is one state, named for the state, so the two arms' frames under one
# name are the pair for it. The keystroke that reaches a state is the one that arm
# answers: a sidebar cursor has no counterpart in a widget with one body, so the
# before arm reads its own surface with the overlay chord and the overlay's scroll
# keys. Where a key means the same thing in both -- `ctrl+x`, Escape, the command
# itself -- both arms get the same one.
#
# The session is seeded before the CLI starts (proof/docker/seed-autoresearch.ts,
# reached from seed-demo.sh by this scene's name): seven logged runs over two
# segments, four arms, one flagged by its reviewer, a playbook, and a metric that
# improved. Running the loop for real needs a harness and an hour of model time,
# which is why the console scene never presses Start.
#
# A still take: the screen holds between keystrokes, so the motion gate has to be
# lowered or it rejects the take as a stutter. Each width takes its own OUT_DIR,
# which is a bind mount and has to be absolute.
#
#   for px in 1600 640 396; do
#     SCENE_WIDTH=$px SCENE_MOTION_FLOOR=1 OUT_DIR="${PWD}/proof/captures/x11/w${px}" \
#       proof/docker/record-x11.sh proof/scenes/autoresearch-run-screen.sh
#     SCENE_WIDTH=$px SCENE_MOTION_FLOOR=1 OUT_DIR="${PWD}/proof/captures/x11/before/w${px}" \
#       proof/docker/record-x11-before.sh proof/scenes/autoresearch-run-screen.sh
#   done

settle 20

# The command resumes the seeded session rather than starting one: the tree is on
# the session's own autoresearch/* branch, so the loop is picked up where it was
# left. What the arms are is already on screen before a key is pressed.
slash "/autoresearch make the tokenizer faster"
settle 6
# Each arm's own word for the same session, which is part of what changed: the
# widget called a four-arm swarm `autoresearch`, because it had one title for both
# shapes of the loop. The row names the shape it is reporting.
expect_screen "$(arm_key autoswarm autoresearch)" 90 "armed"
shot armed

# ctrl+x. The whole differential in one keystroke: a run screen in the after arm,
# eighteen rows of table above the composer in the before arm.
k ctrl+x
settle 3
[ "${SCENE_ARM}" = "after" ] && expect_screen "esc close" 60 "screen"
shot screen

# The playbook. A row of its own on the left in the after arm; part of the body
# the overlay chord opens in the before arm.
k "$(arm_key Down ctrl+shift+x)"
settle 3
[ "${SCENE_ARM}" = "after" ] && expect_screen "Playbook" 45 "playbook"
shot playbook

# The newest arm, then the one before it, then the one its reviewer flagged. Each
# is a different detail pane in the after arm, which is what the widget could not
# do: it had one body and no way to ask it for a run.
k Down
settle 2
shot run-newest

k Down
settle 2
shot run-certified

k "$(arm_key Down pgdn)"
settle 2
shot run-flagged

# The earlier segment. The sidebar groups by segment, so this is where a reader
# sees that the metric moved between rounds.
k pgdn
settle 2
shot segment-earlier

# Escape leaves the reading surface. What is left behind is the always-on part:
# one status row in the after arm, the collapsed widget line in the before arm.
k Escape
settle 3
shot closed

# `off` leaves the mode without closing the session, so the row reports a loop
# that is no longer running rather than disappearing and taking its numbers with
# it.
slash "/autoresearch off"
settle 4
shot mode-off
