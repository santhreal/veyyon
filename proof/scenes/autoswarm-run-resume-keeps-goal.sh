#!/usr/bin/env bash
# `/autoswarm <text>` over a session that already has a goal, and Escape out of
# the dashboard it opens.
#
#   SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/autoswarm-run-resume-keeps-goal.sh
#   SCENE_MOTION_FLOOR=0 proof/record.sh --before proof/scenes/autoswarm-run-resume-keeps-goal.sh
#
# Text typed after `/autoswarm` used to land in the setup form's goal field
# whether or not a session existed, so a message meant as context for resuming
# yesterday's run -- "keep pushing on the arena allocator" -- sat in the field,
# and Enter wrote it over the goal the session had recorded eight runs against.
# `/autoswarm` takes no arguments now: the text is refused with a warning, the
# run dashboard opens on the session's ledger with `s resume` on its footer,
# and the detail pane states the goal the session already holds. The goal is
# written only by `/autoresearch goal <text>` or by typing on the Goal row of
# the setup form behind `e`.
#
# Escape then leaves without starting anything: the loop is exactly as it was.
#
# The session comes from proof/docker/seed-autoresearch.ts (`swarm`): eight runs
# on `autoresearch/tokenizer-throughput` with the goal "make the tokenizer
# faster", which is what the row has to show. No model is needed: the console
# opens before any turn, and Escape starts none.
#
# The before arm is main, where `/autoswarm <text>` opened the modal form with
# the text in its goal field; the same line is typed in both arms, so the pair
# is the surface and the warning, not the command line.
#
# The console holds still between keystrokes and the take measures under 1 fps
# of real change, so both arms turn the motion gate off.

settle 20

# The typed text is not a goal over a session. The detail pane has to show the
# goal the session already holds.
slash "/autoswarm keep pushing on the arena allocator"
settle 3
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "OVERVIEW" 30 "dashboard"
else
	# needle-source: Autoswarm setup -- the title of main's modal form, which the dashboard replaced
	expect_screen "Autoswarm setup" 30 "console"
fi
shot open

# Escape leaves without starting a run.
k Escape
settle 3
shot cancelled
