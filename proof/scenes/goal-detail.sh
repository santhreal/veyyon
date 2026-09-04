#!/usr/bin/env bash
# The goal card and the multi-line goal report, reached without a model turn.
#
# WHAT THIS SCENE IS FOR. `/goal show` prints five lines through ONE status call --
# objective, status, tokens, turns, time spent -- and the renderer that draws it changed:
# every line of a multi-line report carries its section's tone now, where the
# pre-coloured string form opened the colour on the first line and left the
# continuation lines bare. The subject is therefore the colour of rows two through
# five, which is a still, not motion.
#
# WHY IT NEEDS NO SERVED MODEL. `/goal set <objective>` creates the goal and enables
# goal mode in the session itself: it sends context only when a turn is already
# streaming, so nothing here waits on a provider. The scene that reaches a goal card
# through the model (`demo-hd.sh`) needs one capable of a whole autonomous build and
# runs for the better part of an hour; this one photographs the same surface in
# twenty seconds and can be recorded on any host. Both guards are `expect_screen`
# for that reason -- every string below is printed by the product for what the scene
# already did, so a miss is a defect in the build rather than a model that chose
# differently.
#
# HOW TO RECORD THE PAIR. Two stills, and a take whose rate of change is legitimately
# near zero: the surface is a panel being read, so the motion gate's 12 fps floor
# rejects a correct recording of it.
#
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/goal-detail.sh
#
# The before arm records from a checkout of the base ref with OUT_DIR pointing at
# proof/captures/x11/before, because this branch moves workspace members and the
# in-place hold in record-x11-before.sh cannot synthesize the install layout the base
# source needs. That script says so and refuses rather than recording a mixed arm.
#
set -euo pipefail

# The composer placeholder, not the product name: the welcome card letter-spaces its
# title, so `veyyon` matches nothing on the glass. The placeholder is the first string
# that proves the composer is accepting input, which is what the scene needs next.
expect_screen "ask anything" 60 launch
settle 4

# --- the goal exists -------------------------------------------------------
# `slash` dismisses the completion popup before Return: `/goal` carries five
# subcommand rows, and Return with the popup open accepts a row into the composer
# instead of running the line.
#
# `/goal set` enters goal mode silently and submits the objective as the session's
# next turn, so the deterministic evidence that it landed is the objective itself in
# the transcript, not a status message: there is none.
slash "/goal set Ship the release with signed artifacts and a verified changelog"
expect_screen "signed artifacts and a verified changelog" 30 goal-created
# The turn the objective started belongs to the model, and this scene photographs a
# panel rather than a reply. Interrupting leaves the goal in place -- only /goal drop
# removes one -- and stops the transcript scrolling under the report.
k Escape
pause 1.2
shot goal-created

# --- the report the tone change is about -----------------------------------
slash "/goal show"
expect_screen "Objective:" 30 goal-detail
# The last row of the report is the guard for the whole block: a frame taken while
# the panel is half-written is a frame of the defect this scene exists to disprove.
expect_screen "Time spent:" 30 goal-detail
pause 0.8
shot goal-detail

# The panel at rest, so the tail of the clip is the settled report rather than a
# repaint cut off by the end of the recording.
settle 4
