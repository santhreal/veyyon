#!/usr/bin/env bash
# A scrolled viewport travelling through the rows between.
#
# The surface is the plan review overlay, one of the two viewports in the
# product that outlive a single render (the other is the fullscreen agent
# transcript viewer, which only opens for an advisor or a collab guest and so
# cannot be reached from a local scene at all).
#
# Nothing here waits for a model. The recorder is launched with `--continue`
# against a session seeded into proof/docker/home-seed:
#
#   sessions/-demo/<stamp>_<id>.jsonl          header + a `mode_change` to plan
#   sessions/-demo/<stamp>_<id>/local/…-plan.md  the plan this scene scrolls
#
# so the CLI comes up already in plan mode with a plan on disk, and
# `/plan-review` opens the overlay on it. Every row the recording scrolls is
# numbered in that file, which is what makes a frame taken mid-travel legible:
# the strip either holds the rows between two readings or it does not.
#
#   SCENE_COMMAND="bun /repo/packages/coding-agent/src/cli.ts --continue \
#     --model local/qwen2.5-1.5b" proof/docker/record-x11.sh proof/scenes/plan-scroll.sh
#
# No stills — `import` costs about fifteen seconds a frame on this display and
# would stall the middle of a travel. The page's frames are cut out of the
# recording afterwards.

settle 20

# --- open the review -------------------------------------------------------
# Escape closes the command popup and leaves the draft alone, so Return submits
# `/plan-review` rather than accepting whatever row the popup had selected.
t "/plan-review"
pause 1.2
k Escape
pause 0.6
k Return
settle 6

# --- one page down, alone --------------------------------------------------
# The pointer is parked off the body first: a hover band under it would move
# with the rows and muddy what the strip is measuring.
point 2 120
pause 1.5
k Next
sleep 4

# --- a second page, so the strip has a repeat -------------------------------
k Next
sleep 4

# --- the wheel, with a real pointer on the body -----------------------------
point 18 60
pause 1.0
wheel_down 4
sleep 4

# --- back up ----------------------------------------------------------------
k Prior
sleep 4
k Prior
sleep 4

# --- home, which lands ------------------------------------------------------
# Both ends land by design: a viewport that follows its own tail must never lag
# behind it, and the same rule takes `g` straight to row one.
t "g"
sleep 3

# --- out --------------------------------------------------------------------
k Escape
settle 4
