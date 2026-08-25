#!/usr/bin/env bash
# The footline's path segment against a named display root.
#
# WHY THIS SCENE. The path segment shortens a working directory three times over: a
# configured display root is stripped off the front, then the home directory folds to `~`,
# then whatever is left is clipped to the budget. Only the first of those is configurable,
# and until now the list it consults was two values compiled into the source. The list is
# `statusLine.segmentOptions.path.displayRoots`, and this scene is the differential that
# shows it reaching behaviour: one arm at the defaults, one arm naming the root the seeded
# project sits in.
#
# THE ARMS. `SCENE_SETTINGS` is appended verbatim to the recording profile's config.yml
# before the session starts (proof/docker/record-x11.sh), which is how an arm is seeded
# here -- not a keybinding, and nothing this script toggles at run time. The off arm passes
# none, so the defaults (`~/Projects` and `/work`) apply and neither contains the seeded
# project; the path keeps its whole depth and the budget clips its head. The on arm names
# `~/platform-services`, so the two directories above the project come off the front and
# what is left fits the same budget whole.
#
#   OUT_DIR="${PWD}/proof/captures/x11/displayroots-off" \
#   SCENE_WIDTH=1920 SCENE_MOTION_GATE=0 \
#   SCENE_CWD=/sandbox/home/platform-services/ingest-pipeline/normalizer \
#     proof/docker/record-x11.sh proof/scenes/statusline-display-root.sh
#
#   OUT_DIR="${PWD}/proof/captures/x11/displayroots-on" \
#   SCENE_WIDTH=1920 SCENE_MOTION_GATE=0 \
#   SCENE_CWD=/sandbox/home/platform-services/ingest-pipeline/normalizer \
#   SCENE_SETTINGS=$'statusLine:\n  segmentOptions:\n    path:\n      displayRoots:\n        - ~/platform-services' \
#     proof/docker/record-x11.sh proof/scenes/statusline-display-root.sh
#
# ONE HUNDRED AND SIXTY COLUMNS, AND THE WIDTH IS PART OF THE PROOF. The location zone
# takes what the right group leaves, and at 118 columns that is about twenty-five cells --
# less than either arm's path, so both arms clip to the same twenty-five characters of tail
# and the pair shows nothing. The frames were taken there first and were byte-comparable.
# At 1920 pixels the zone is wide enough to hold the whole of the shorter arm, which is the
# only width at which the setting is visible at all.
#
# SCENE_MOTION_GATE=0 because each arm is one still of a status line, and the motion floor
# exists to stop a published clip encoding as a slideshow.
#
# WHAT THIS SCENE DOES NOT CATCH. A root that cannot be used -- a relative entry, or one
# spelled with `~` -- is resolved before any of this and is named to the log rather than to
# the screen, so no frame here can show it. The suite covers those directly.
set -euo pipefail

settle 12

# Which arm this is, taken from the settings the arm was seeded with rather than from a
# separate label, so an arm cannot be captured under the wrong name.
case "${SCENE_SETTINGS:-}" in
*displayRoots*) arm=named ;;
*) arm=default ;;
esac

# The seeded project is how the scene knows SCENE_CWD arrived. Without it the session
# opened somewhere else and the frame would photograph a short path under no root at all.
expect_screen "normalizer" 60 "seeded-cwd"

location="$(row_with "Auto")"
echo "scene: footline on the ${arm} arm:${location}" >&2

# EACH ARM GUARDED ON WHAT THAT ARM MUST SHOW, and neither guard is satisfied by the other
# arm's row. The default arm still carries the two directories the named root removes, so
# `services/ingest` is on the line and the path is over budget and clipped. The named arm
# shows the project-relative path with nothing above it: no `services`, no clip.
case "${arm}" in
default)
	case "${location}" in
	*services/ingest-pipeline/normalizer*) ;;
	*) abandon_take "footline" "the default arm is not showing the seeded path under its own root" ;;
	esac
	;;
named)
	case "${location}" in
	*services*)
		abandon_take "footline" "the named root was not stripped off the front of the path"
		;;
	esac
	case "${location}" in
	*ingest-pipeline/normalizer*) ;;
	*) abandon_take "footline" "the named arm lost the project-relative path" ;;
	esac
	;;
esac

shot footline
