#!/usr/bin/env bash
# The status row of a loop whose branch is not the one checked out.
#
#   SCENE_MOTION_FLOOR=1 proof/docker/record-x11.sh proof/scenes/autoresearch-paused-branch.sh
#   SCENE_MOTION_FLOOR=1 PROOF_BASE_REF=<commit> \
#     proof/docker/record-x11-before.sh proof/scenes/autoresearch-paused-branch.sh
#
# The seed records a swarm session on `autoresearch/tokenizer-throughput` and
# then leaves the tree on the branch it started from, which is the state a user
# reaches by checking out another branch mid-loop. Before the fix the row reset
# to `autoresearch · baseline pending` and the run screen reported no runs, so a
# session with four measured runs read as one that had never started. After it
# the row states `paused · session on autoresearch/tokenizer-throughput` and the
# runs stay where they were.
#
# Both arms drive the same keys, so the only difference between the frames is
# what the row and the screen say. The hold point is the commit before the
# paused state, not `origin/main`.
#
# A still take: nothing animates between keystrokes, so the motion gate has to
# be lowered or the take is rejected as a stutter.

settle 20

# The row as it stands on arrival, with no command typed: the session is loaded
# from storage on session start, which is the path that decides the row.
expect_screen "ctrl+x runs" 60 "row"
shot row-paused

# The run screen still opens on a paused session, and still holds the runs. This
# is the half of the defect a status row cannot show: before the fix the state
# was reset, so the screen had nothing to list.
k ctrl+x
settle 3
expect_screen "esc close" 60 "screen"
shot screen-paused

k Escape
settle 3
