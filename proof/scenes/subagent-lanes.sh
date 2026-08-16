#!/usr/bin/env bash
# The Subagents category of the settings card, opened with a real click.
#
# This is not a motion scene: it is the settings surface the lane-tree commit
# rebuilt, recorded in both arms so the page can show what the category held
# before and what it holds now. The click is the same gesture the pointer
# section proves -- a click on a category opens it exactly as Enter does -- so
# the two arms reach the pane the same way.
#
# Sidebar rows MEASURED off a recording, not counted: the scene grid calls a
# cell 26px tall but xterm lays these lines out at ~28.7px, so a counted row
# drifts a full line by the bottom of the list. Clicking the eleventh entry at
# its counted row 19 opened Tasks. In the coordinates `point`/`click_at` use,
# Subagents is row 20 and column 25 is inside the category strip.
#
# No stills: the page cuts them out of this recording, the same as every other
# scene here.
settle 18
submit "/settings"
settle 4

click_at 20 25
settle 3

# Walk the pane so the recording carries more of the tree than one screen, and
# so the band tracks a pointer that is moving inside it.
glide 10 60 20 60 10 0.12
sleep 2

# Then go down the tree, which is the whole point of the commit. `Subagent
# Roster` is measured at row 12 of the pane; everything under it is driven from
# the keyboard, because a sub-screen's rows are not measured yet and a guessed
# row is how three earlier takes were wasted.
click_at 12 60
sleep 1
k Return
settle 3

# The roster's first two rows are the blanket Model and Effort every subagent
# inherits; the agent lanes start on the third. Two Downs is `deep`, and its own
# page carries Enabled, Model, Effort, and Subagents -- the door to the level
# below.
key_repeat Down 2 0.5
sleep 1
k Return
settle 3
key_repeat Down 3 0.6
sleep 2

# Through the door: the same four rows again, one level down.
k Return
settle 3
key_repeat Down 2 0.6
sleep 2.5

# Back out one level at a time, so the recording shows the chain in reverse.
k Escape
sleep 1.2
k Escape
sleep 1.2
k Escape
sleep 1.2
k Escape
sleep 2
