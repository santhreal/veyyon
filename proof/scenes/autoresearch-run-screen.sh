#!/usr/bin/env bash
# The autoswarm run screen, and the widget it replaced, on the same session.
#
#   proof/docker/record-x11.sh proof/scenes/autoresearch-run-screen.sh
#   proof/docker/record-x11-before.sh proof/scenes/autoresearch-run-screen.sh
#
# A loop used to report itself in a widget above the composer: one collapsed line,
# `ctrl+x` to expand it to eighteen rows of table, `ctrl+shift+x` for the same
# table as an overlay. It now reports itself in one status row, and `ctrl+x` opens
# a run screen: every run on the left, the highlighted one in full on the right.
#
# Both arms are driven by the same keystrokes wherever a keystroke means the same
# thing in both, so a pair of frames differs by the surface and nothing else. Two
# of them cannot be: the before arm has no row to move a cursor along, so its
# reading keys are the ones its own surface answers -- the overlay chord, then its
# scroll keys. The shot names say which state each frame is of, and the pair for a
# state is the two arms' answers to reaching it.
#
# The session is seeded before the CLI starts (proof/docker/seed-autoresearch.ts,
# reached from seed-demo.sh by this scene's name): seven logged runs over two
# segments, four arms, one flagged by its reviewer, a playbook, and a metric that
# improved. Running the loop for real needs a harness and an hour of model time,
# which is why the setup-console scene stops at the console.

settle 20

# The command resumes the seeded session rather than starting one: the tree is on
# the session's own autoresearch/* branch, so the loop is picked up where it was
# left. What the arms are is already on screen before a key is pressed.
slash "/autoresearch make the tokenizer faster"
settle 6
expect_screen "autoswarm" "armed" 90
shot armed

# ctrl+x. The whole differential in one keystroke: a run screen in the after arm,
# eighteen rows of table above the composer in the before arm.
k ctrl+x
settle 3
if [ "${SCENE_ARM}" = "after" ]; then
	expect_screen "esc close" "screen" 60
fi
shot screen

if [ "${SCENE_ARM}" = "after" ]; then
	# Down the sidebar: the playbook, then the newest arm, then the one its
	# reviewer flagged. Each row is a different detail pane, which is the thing the
	# widget could not do -- it had one body and no way to ask for a run.
	k Down
	settle 2
	expect_screen "Playbook" "playbook" 45
	shot playbook

	k Down
	settle 2
	shot run-newest

	k Down
	settle 2
	shot run-certified

	k Down
	settle 2
	shot run-flagged

	# Page down into the earlier segment. The sidebar groups by segment, so this is
	# where a reader sees that the metric moved between rounds.
	k pgdn
	settle 2
	shot segment-earlier
else
	# The before arm's own reading path: the overlay chord, then the scroll keys the
	# overlay answers. The table is longer than the viewport, so each of these is a
	# different part of the same body.
	k ctrl+shift+x
	settle 3
	shot playbook

	k Down
	settle 2
	shot run-newest

	k Down
	settle 2
	shot run-certified

	k pgdn
	settle 2
	shot run-flagged

	k pgdn
	settle 2
	shot segment-earlier
fi

# Escape leaves the reading surface. What is left behind is the always-on part:
# one status row in the after arm, the collapsed widget line in the before arm.
k Escape
settle 3
shot closed

# `off` leaves the mode without closing the session, so the row reports a loop
# that is no longer running rather than disappearing and taking its numbers with
# it.
slash "/autoresearch off"
settle 4
shot mode-off
