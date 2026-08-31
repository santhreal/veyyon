#!/usr/bin/env bash
# A goal objective that carries a line break, in the report and in the goal menu.
#
# WHAT THIS SCENE IS FOR. The objective is the one free-text field goal mode carries, and
# five single-line surfaces formatted it exactly as it arrived. A line break in it is the
# member of that class an operator reaches with two keys: `ctrl+j` is the composer's
# insert-newline binding, so `/goal set` takes an objective whose second half is a line of
# its own. The report then prints six lines where it has five fields, and the second half
# of the objective sits where a field name belongs. The subject is the shape of the report
# and of the goal menu title, which is a still.
#
# WHY IT NEEDS NO SERVED MODEL. `/goal set` creates the goal and enters goal mode in the
# session itself; it sends context only while a turn is already streaming, so nothing here
# waits on a provider. Escape ends the turn the objective opened -- a goal survives an
# interrupt, only `/goal drop` removes one -- and leaves the panel still.
#
# HOW TO RECORD THE PAIR. Two stills of a panel being read, so the motion gate's frame-rate
# floor rejects a correct recording and is turned off for both arms:
#
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/goal-objective-lines.sh
#   PROOF_BASE_REF=<the commit before the fix> SCENE_MOTION_FLOOR=0 \
#       proof/docker/record-x11-before.sh proof/scenes/goal-objective-lines.sh
#
# The before arm holds the fix's own files at the commit before it, rather than at the
# branch base: the base tree also predates the status field's fix, and a pair that moves
# two things proves neither.
#
# needle-source: Objective: Ship the release and sign every artifact -- the report's field name,
# from goal-mode-controller.ts, followed by the two typed halves joined by the single space the
# sanitizer leaves where the line break was.
set -euo pipefail

# The composer placeholder is the first string that proves the composer takes input; the
# welcome card letter-spaces the product name, so it matches nothing on the glass.
expect_screen "ask anything" 60 launch
settle 4

# --- an objective with a line break in it ----------------------------------
# Typed rather than sent through `slash`, because the newline lands between two typed
# runs: `clear_composer` first, since a submit starts from an empty composer, then the
# command and the first half, `ctrl+j` for the break, then the second half. No Escape
# before Return: the completion popup closes on the first argument character, and by here
# the composer holds two lines of text.
clear_composer
t "/goal set Ship the release"
pause 0.4
k ctrl+j
pause 0.4
t "and sign every artifact"
pause 0.5
k Return

# The objective itself is the deterministic evidence that `/goal set` landed: it enters
# goal mode silently and submits the objective as the session's next turn, so there is no
# status message to wait for.
expect_screen "and sign every artifact" 30 goal-created
k Escape
pause 1.2
shot goal-created

# --- the menu title, which quotes the objective in one line ----------------
# Bare `/goal` on an active goal opens the goal menu, whose title carries the objective.
slash "/goal"
expect_screen "Show details" 30 goal-menu
pause 0.6
shot goal-menu
k Escape
pause 0.6

# --- the report, which is five fields and one line each --------------------
slash "/goal show"
expect_screen "Objective:" 30 goal-objective
# The last field guards the whole block: a frame taken while the report is half written is
# a frame of a defect this scene does not exist to show.
expect_screen "Time spent:" 30 goal-objective
if [ "${SCENE_ARM:-after}" != before ]; then
	# The after arm's claim, and the one string that separates the two arms: the objective
	# is one line, so the break between its halves is a single space on the glass.
	expect_screen "Objective: Ship the release and sign every artifact" 30 goal-objective
fi
pause 0.8
shot goal-objective

# The panel at rest, so the tail of the clip is the settled report rather than a repaint
# cut off by the end of the recording.
settle 4
