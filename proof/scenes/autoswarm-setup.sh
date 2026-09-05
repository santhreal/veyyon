#!/usr/bin/env bash
# The autoswarm launcher, driven the way a user reaches it.
#
# `/autoswarm` used to open a modal setup form that took the goal as a command
# argument and closed on Enter, with the loop's other controls spread over
# subcommands (`off`, `resume`, `clear --keep-tree`). On a branch with no
# session it now opens a centered launcher card: a form with the goal, the
# preset switch, breadth, the per-arm models, attempts, certification and the
# iteration cap, a Start button and a Save-as row. Nothing is typed after the
# command. Over a session the same command opens the run dashboard instead,
# which autoswarm-run-resume-keeps-goal.sh records.
#
# The scene proves the launcher is reachable with no arguments, that the keys
# move the values on screen, that an arm can be put on its own model and that
# a model nothing matches blocks the start, that a preset rewrites the rows in
# one keystroke, and that Escape leaves without starting a run. It deliberately
# does not press Enter on Start: starting a real swarm needs an
# `autoresearch.sh` harness in the tree and a model that will spend an hour in
# it, and neither belongs in a capture.
#
# The card holds still between keystrokes and the take measures under 1 fps of
# real change, so both arms turn the motion gate off:
#
#   SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/autoswarm-setup.sh
#   SCENE_MOTION_FLOOR=0 proof/record.sh --before proof/scenes/autoswarm-setup.sh
#
# The before arm is main's modal form. Its rows are Goal, Breadth, Models,
# Attempts and Certification with the cursor opening on Goal; the launcher opens
# on Goal too, with Preset between Goal and Breadth. From Breadth down the two
# walks are the same keys, and the frames share a name where the state
# corresponds. `iterations-set`, `preset-wide` and `start-ready` are rows the
# form never had and exist on the after arm only.

settle 20

# Open the console with nothing after the command.
slash "/autoswarm"
settle 3
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "Iterations" 30 "console"
fi
shot open

# Type a goal. The Start pane stops reading "Needs a goal" as soon as the row
# holds text; the form's legend stops reading "enter needs a goal".
t "make the tokenizer faster"
settle 1
shot goal-typed

# Down to Breadth, then raise it. The row shows the value between its arrows,
# and the note under the form restates what the number buys, so the frame
# shows the value and its consequence. The after arm has the Preset row
# between Goal and Breadth.
if [ "${SCENE_ARM:-after}" = "after" ]; then
	key_repeat Down 2 0.15
else
	k Down
fi
settle 1
shot breadth-focused
key_repeat Right 3 0.25
settle 1
shot breadth-raised

# The models row: one spec per arm, in arm order. The pane reads the
# assignment back as arms, so the frame shows which model each arm gets rather
# than a comma list the reader has to count. The two ids are rows the
# recorder's own model file declares, so the console resolves them through the
# resolver `--model` uses rather than accepting any string that was typed.
k Down
settle 1
shot models-focused
t "qwen2.5-1.5b-q8, qwen2.5-1.5b-q4"
settle 1
shot models-assigned

# A model nothing matches must block the start rather than quietly falling
# back to the session model.
t ", nope"
settle 1
shot models-unknown
key_repeat BackSpace 6 0.05
settle 1
shot models-restored

# Attempts, then Certify. Toggling certification changes the pane from a
# review ring to uncertified, which is the differential this row has.
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

if [ "${SCENE_ARM:-after}" = "after" ]; then
	# Iterations: typed digits replace `auto`, and a second digit appends.
	k Down
	settle 1
	t "12"
	settle 1
	shot iterations-set

	# The preset switch, five rows up. The rows match no preset by now, so
	# Right lands on `swarm` and a second Right on `wide`, which rewrites
	# breadth, attempts, certification, the models and the cap in one key and
	# is painted as the shape in force afterwards.
	key_repeat Up 5 0.1
	settle 1
	key_repeat Right 2 0.25
	settle 1
	shot preset-wide

	# Down to the Start button: six rows from Preset, past the notes, which
	# take no focus. The footer states what Enter would do with the rows as
	# they stand; nothing is pressed.
	key_repeat Down 6 0.1
	settle 1
	shot start-ready
fi

# Escape leaves without starting anything, and the composer comes back.
k Escape
settle 3
shot cancelled
