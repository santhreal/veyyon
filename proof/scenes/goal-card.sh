#!/usr/bin/env bash
# The goal tool's own card, carrying a multi-line completion report.
#
# WHAT THIS SCENE IS FOR. The card the goal tool asks its host to draw is a framed block
# whose Report section is one line per line of the completion report, each carrying the
# section's tone. The string form it replaced opened the colour once, so every line after
# the first drew bare. The subject is therefore the colour of the second and later report
# rows, which is a still.
#
# WHY IT NEEDS A SERVED MODEL. Only a model reaches this card: the goal tool is hidden,
# goal mode activates it, and the Report section exists only for `op: "complete"` with
# model goal budgets on. Nothing an operator types calls it -- `/goal show` prints the
# session's own status text through a different path, which `goal-detail.sh` photographs.
#
# HOW TO RECORD THE PAIR.
#
#   SCENE_MOTION_FLOOR=0 \
#     SCENE_SETTINGS=$'goal.modelBudgetsEnabled: true\ntools.discoveryMode: all\nskills.enabled: false' \
#     proof/docker/record-x11.sh proof/scenes/goal-card.sh
#
# The two knobs beside the budget one shrink the request: discovery hides the non-essential
# built-ins behind a search tool and skills stay out of the prompt, which is the difference
# between a request the served model answers and one the session compacts first. Measured
# against a Qwen2.5 1.5B q4 on this harness: the request fits at about 17k tokens, and the
# model still never issues `goal(op: "complete")` -- the take abandons at the Report guard
# after its 600 s ceiling. The scene needs a served model that follows a one-call
# instruction; on a host that has none, the equivalence suite
# `a-goal-card-draws-the-same-panel-its-renderer-drew.test.ts` is what covers these rows.
#
# One slot, not two: llama.cpp divides `-c` by `-np`, so `-np 2 -c 32768` serves 16k a slot
# and refuses a 17k request outright.
set -euo pipefail

expect_screen "ask anything" 60 launch
settle 4

# --- goal mode, and a goal to complete -------------------------------------
slash "/goal set Ship the release with signed artifacts and a verified changelog"
expect_screen "signed artifacts and a verified changelog" 30 goal-created
# The objective's own turn belongs to the model and this scene needs a specific call, so
# the turn is interrupted and the instruction is submitted on its own. Interrupting pauses
# the goal; the resume below is what puts it back under the tool's control.
k Escape
pause 1.0
slash "/goal resume"
pause 1.0
shot goal-created

# --- the card the change is about ------------------------------------------
submit "Call the goal tool once with op complete. Reply with nothing else."
# The Report label is drawn only for a completion that carries a budget report, so it is
# the one needle that proves the frame holds the section whose rows changed.
expect_model_screen "Report" 600 goal-card
pause 1.0
shot goal-card

settle 4
