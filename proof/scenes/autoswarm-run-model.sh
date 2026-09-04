#!/usr/bin/env bash
# The model a run was measured on, in the run's detail.
#
#   SCENE_MOTION_FLOOR=1 proof/docker/record-x11.sh proof/scenes/autoswarm-run-model.sh
#   SCENE_MOTION_FLOOR=1 PROOF_BASE_REF=<commit> \
#     proof/docker/record-x11-before.sh proof/scenes/autoswarm-run-model.sh
#
# A round that assigns a model per arm records `provider/id` on each run, and the
# detail shows it under the arm as `Built on`. Both arms of this pair run the run
# screen, so every key means the same thing in both and no `arm_key` appears: the
# hold point is the commit before the field, not `origin/main`, and the only
# difference between the two frames is the row itself.
#
# The seeded session (proof/docker/seed-autoresearch.ts, `swarm`) assigns four
# arms across three models, so consecutive runs name different ones rather than
# repeating one value down the segment.
#
# A still take: the screen holds between keystrokes, so the motion gate has to be
# lowered or the take is rejected as a stutter.

settle 20

slash "/autoresearch make the tokenizer faster"
settle 6
expect_screen "autoswarm" 90 "armed"

# The run screen. Every run on the left, the highlighted one in full on the right.
k ctrl+x
settle 3
expect_screen "esc close" 60 "screen"

# Past the two overview rows to the newest run, which is an arm of the current
# segment: `Arm c of 4`, and the model that measured it.
k Down
settle 1
k Down
settle 2
[ "${SCENE_ARM}" = "after" ] && expect_screen "Built on" 45 "run-newest"
shot run-newest

# The next run down is a different arm on a different model, which is what makes
# the field worth reading: one round, two models.
k Down
settle 2
shot run-previous

k Escape
settle 3
