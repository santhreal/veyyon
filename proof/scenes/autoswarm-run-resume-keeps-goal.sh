#!/usr/bin/env bash
# `/autoswarm <text>` over a session that already has a goal, and Escape out of
# the console it opens.
#
#   SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/autoswarm-run-resume-keeps-goal.sh
#   SCENE_MOTION_FLOOR=0 proof/record.sh --before proof/scenes/autoswarm-run-resume-keeps-goal.sh
#
# Text typed after `/autoswarm` used to land in the console's goal field
# whether or not a session existed, so a message meant as context for resuming
# yesterday's run -- "keep pushing on the arena allocator" -- sat in the field,
# and Enter wrote it over the goal the session had recorded eight runs against.
# Over a live session the field opens on that session's goal now; the typed
# text reaches the model as context for the resume and the goal is written only
# by `goal <text>` or by a field that leaves the console changed.
#
# Escape then leaves without starting anything. The command is already in the
# transcript as the user's line, and with nothing under it a cancelled console
# read the same as a run that never started, so the product says which it was.
#
# The session comes from proof/docker/seed-autoresearch.ts (`swarm`): eight runs
# on `autoresearch/tokenizer-throughput` with the goal "make the tokenizer
# faster", which is what the field has to show. No model is needed: the console
# opens before any turn, and Escape starts none.
#
# The console holds still between keystrokes and the take measures under 1 fps
# of real change, so both arms turn the motion gate off.

settle 20

# The typed text is resume context, not a goal. The field has to show the goal
# the session already holds.
slash "/autoswarm keep pushing on the arena allocator"
settle 3
expect_screen "Autoswarm setup" 30 "console"
shot open

# Escape leaves without starting a run, and the product says so.
k Escape
settle 3
shot cancelled
