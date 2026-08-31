#!/usr/bin/env bash
# The autoswarm setup console, driven the way a user reaches it.
#
# `/autoswarm` used to take its configuration as command arguments, so a run was
# started by typing `/autoswarm breadth 4` and hoping the number landed. It now
# opens a console: four fields, arrow keys, Enter to start, Escape to leave.
#
# The scene proves the console is reachable, that the keys move the values on
# screen, and that Escape leaves without starting a run. It deliberately does
# not press Enter at the end: starting a real swarm needs an `autoresearch.sh`
# harness in the tree and a model that will spend an hour in it, and neither
# belongs in a capture.
#
# The goal field is prefilled from the text typed after the command, so the
# first frame already carries a goal and the empty-goal warning is reached by
# deleting it rather than by opening a second session.

settle 20

# Open the console with a goal typed after the command.
slash "/autoswarm make the tokenizer faster"
settle 3
shot open

# Down to Breadth, then raise it. The summary line under the fields restates
# what the number buys, so the frame shows the value and its consequence.
k Down
settle 1
shot breadth-focused
key_repeat Right 3 0.25
settle 1
shot breadth-raised

# Down past Attempts to Certification, and toggle it off. The summary changes
# from a review ring to uncertified, which is the differential this field has.
k Down
settle 1
key_repeat Right 2 0.25
settle 1
shot attempts-raised
k Down
settle 1
k space
settle 1
shot certification-off
k space
settle 1
shot certification-on

# Back to the goal and empty it. Enter must not start a run with nothing to
# optimize, so the warning appears and the console stays open.
k Up
k Up
k Up
settle 1
key_repeat BackSpace 26 0.05
settle 1
shot goal-empty

# Enter here must do nothing. A frame of the refusal is byte-identical to the
# one above -- which is the point, and which the recorder rejects as a failed
# take -- so the proof is the frame after it: the console is still open, still
# holding the values set above, and the warning clears as soon as a goal exists.
k Return
settle 2
t "make the tokenizer faster"
settle 1
shot goal-restored

# Escape leaves without starting anything, and the composer comes back.
k Escape
settle 3
shot cancelled
