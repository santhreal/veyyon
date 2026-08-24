#!/usr/bin/env bash
# The composer footline under location pressure, in every state it can hold without a
# model turn.
#
# WHY THIS SCENE. `location` (the working directory and the git branch) and the right
# group (model identity, approval rung, subagent count, context gauge) share one line.
# When location is wide the right group is shed from its end, and which member goes first
# is a ranking, not a width. Every other fixture under proof/docker/seed-demo.sh sits
# directly in the demo project on `main` -- eleven columns of location, which never reaches
# the width where the ranking decides anything. This scene runs in the seeded
# platform-services project, whose path and branch name together are about ninety columns,
# so the shed order is visible rather than theoretical.
#
# The states differ only in what the right group contains, so they do not shed at the same
# width: a terminal that fits `Auto` does not fit `! YOLO · Plan`, and the same terminal
# proves a different thing in each state. That is why the frames are taken per state and
# the scene is run once per width rather than resizing mid-take.
#
# NO MODEL TURN. Every state is reached by a slash command, so the scene records at the
# same speed on any host and needs no weights. The context gauge reads its idle value
# throughout, which is the point: nothing here is waiting on a server.
#
# Run one arm per width, and pair it with proof/docker/record-x11-before.sh at the same
# width. 12 pixels per column in proof/docker/xsession.sh, and OUT_DIR is a docker bind
# mount, so it has to be absolute:
#
#   for px in 960 1200 1440; do            # about 80, 100 and 120 columns
#     SCENE_WIDTH=${px} SCENE_MOTION_GATE=0 \
#     SCENE_CWD=/sandbox/home/platform-services/ingest-pipeline/normalizer \
#     OUT_DIR="${PWD}/proof/captures/x11/w${px}" \
#       proof/docker/record-x11.sh proof/scenes/statusline-widths.sh
#   done
#
# SCENE_MOTION_GATE=0 because the take is five stills of a status line. The motion floor
# is there to stop a published clip from encoding as a slideshow; this scene IS a
# slideshow, and the frames are the artifact.
set -euo pipefail

settle 12

# Part of the seeded project path, from proof/docker/seed-demo.sh. Its presence is how the
# scene knows SCENE_CWD arrived: without it the session opened somewhere else and every
# frame below would photograph a short location under no pressure at all.
#
# The needle is a FRAGMENT of the first path segment, because it has to match in both arms
# of the pair. At eighty columns the location is clipped at both ends, and it is clipped
# HARDER once the model chip keeps its columns -- `ingest-pipeline` is on screen in the arm
# that drops the model and gone in the arm that keeps it. A needle that only one arm can
# satisfy would fail the take for the very difference it is recording.
screen_has "orm-services" || MISSED="${MISSED:-} idle"
shot idle

# AUTO, the shipped approval rung. The widest right group that still carries every member.
slash "/yolo"
pause 0.5
# The confirmation dialog owns Return; the second one answers "Yes".
k Return
settle 3
if screen_has "YOLO" || screen_has "bypass"; then
	echo "scene: bypass mode confirmed" >&2
else
	MISSED="${MISSED:-} yolo"
fi
shot yolo

# PLAN ON TOP OF BYPASS, which is the widest rung this line ever carries: two labels in
# `mode` where every other state has one.
slash "/plan"
settle 3
screen_has "Plan" || MISSED="${MISSED:-} plan"
shot plan-and-yolo

# A DRAFT IN THE COMPOSER puts the token readout into `location_right`, the zone that is
# pushed last and shed first without a rank. Typed, not submitted: the readout is a
# property of the draft, and submitting it would need a model.
clear_composer
t "rewrite the ingest normalizer so a malformed record fails closed instead of coercing"
settle 2
shot draft

# BACK TO A SINGLE RUNG, so the pair at this width also shows the line recovering rather
# than only degrading.
slash "/plan"
settle 3
shot plan-off

if [ -n "${MISSED:-}" ]; then
	echo "scene: these proofs did not land:${MISSED}" >&2
	echo "scene: nothing may be published from this take" >&2
	exit 1
fi