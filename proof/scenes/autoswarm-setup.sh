#!/usr/bin/env bash
# The autoswarm setup console, driven the way a user reaches it.
#
# `/autoswarm` used to take its configuration as command arguments, so a run was
# started by typing `/autoswarm breadth 4` and hoping the number landed. It now
# opens a console: the goal, the breadth, one model per arm, the attempts and
# the certification toggle, with arrow keys, Enter to start and Escape to leave.
#
# The scene proves the console is reachable, that the keys move the values on
# screen, that an arm can be put on its own model and that a model nothing
# matches refuses to start, and that Escape leaves without starting a run. It
# deliberately does not press Enter at the end: starting a real swarm needs an
# `autoresearch.sh` harness in the tree and a model that will spend an hour in
# it, and neither belongs in a capture.
#
# The goal field is prefilled from the text typed after the command, so the
# first frame already carries a goal and the empty-goal warning is reached by
# deleting it rather than by opening a second session.
#
# The console holds still between keystrokes and the take measures under 1 fps of
# real change, so both arms turn the motion gate off:
#
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/autoswarm-setup.sh
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11-before.sh proof/scenes/autoswarm-setup.sh
#
# `certification-off` is the frame that carries the layout contract: `off` is the
# widest value the toggle reaches, so a value column measured from the values a
# field currently holds lands on the correct column in that one state and a column
# short in every other.
#
# `models-unknown` carries the other one: the refusal is printed beside `enter`
# on the legend and named on the assignment line, so a console that accepts a
# model nobody has is visible in the frame rather than only in the run it starts.

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

# The models row: one spec per arm, in arm order. The line under the fields
# reads the assignment back as arms, so the frame shows which model each arm
# gets rather than a comma list the reader has to count.
#
# The two ids are rows the recorder's own model file declares, so the console
# resolves them through the resolver `--model` uses rather than accepting any
# string that was typed.
#
# The row exists on the branch and nowhere else: main's console has four fields
# and no per-arm model, so the assignment and the refusal have no state on that
# side to photograph and are shot on the after arm alone. The pair that carries
# this change is `breadth-raised`, where the row is present on one side and
# absent on the other. Skipping the block whole is also what keeps the field
# cursor aligned: the `k Down` after it lands on Attempts in both arms, and a
# scene that instead typed a model spec into main's Attempts field would drift
# every frame below this point into a state neither side of the change has.
if [ "${SCENE_ARM:-after}" = "after" ]; then
	k Down
	settle 1
	shot models-focused
	t "qwen2.5-1.5b-q8, qwen2.5-1.5b-q4"
	settle 1
	shot models-assigned

	# A model nothing matches must refuse the run rather than quietly falling
	# back to the session model.
	t ", nope"
	settle 1
	shot models-unknown
	key_repeat BackSpace 6 0.05
	settle 1
	shot models-restored
fi

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
