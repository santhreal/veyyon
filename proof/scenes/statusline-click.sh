#!/usr/bin/env bash
# The footline's location zone widening and re-collapsing under a real pointer, clicked once
# on the directory and once on the branch.
#
# WHY A CLIP AND NOT A PAIR OF STILLS. The trade this records is a MOVEMENT: the location
# grows while the model chip retracts on one progress value, over `MOTION.expand`, so a still
# can only show an end state and both end states are already pinned by the width arms. What a
# still cannot show is that the row travels between them rather than switching, that it
# travels back on the second click, and that the click lands on either half of the zone -- the
# directory or the branch -- rather than on one blessed segment.
#
# Two clicks per target, so the reversal is in the take: expanded, collapsed, expanded,
# collapsed. Between them the pointer glides, which is also what makes the clip legible --
# a cut that teleports the pointer reads as an edit rather than as a hand on a mouse.
#
# THE CLICK NEEDS THE MOUSE, and the engine only holds it when the operator has asked for
# scroll isolation, so this arm records with `tui.scrollIsolation: true`. That is the same
# opt-in the context gauge has always needed.
#
# SHOT BEFORE ANY DIALOG, and that position is a finding rather than a preference: once a
# confirmation dialog has opened and closed in a session the footline answers no click at all.
# Nothing here opens one.
#
# Run the pair at one width -- the clip is about the travel, not about the widths, which the
# statusline-widths.sh arms cover. SCENE_MOTION_FLOOR=1 is not a waiver: the floor exists to
# stop a published clip encoding as a slideshow, and thirty-six seconds of a status line IS
# two frames a second of change however smooth the four transitions in it are. The gate's own
# escape, and it is measured in the log either way.
#
#   SCENE_WIDTH=1440 SCENE_MOTION_FLOOR=1 SCENE_GIF_FPS=15 SCENE_GIF_WIDTH=1100 \
#   SCENE_SETTINGS='tui.scrollIsolation: true' \
#   SCENE_CWD=/sandbox/home/platform-services/ingest-pipeline/normalizer \
#   OUT_DIR="${PWD}/proof/captures/x11/click" \
#     proof/docker/record-x11.sh proof/scenes/statusline-click.sh
#
#   ... same knobs, OUT_DIR="${PWD}/proof/captures/x11/before/click" \
#     proof/docker/record-x11-before.sh proof/scenes/statusline-click.sh
#
# WHAT THIS TAKE DOES NOT CATCH. It photographs one width and one theme, and it cannot say
# which frame the curve was on: `display.transitions: off` lands on the click frame and the
# suite owns that byte. The before arm shows the same two clicks answering with nothing,
# which is the differential; it is not evidence about the pointer, since main routes the
# report and simply has no expansion to give.
set -euo pipefail

settle 12

# The seeded wide project, from proof/docker/seed-demo.sh. Its absence means SCENE_CWD never
# arrived and the take would film a short location under no pressure at all.
screen_has "normalizer" || abandon_take "fixture" "the session did not open in the wide project"

# THE TWO HALVES OF THE ZONE, BY THE END EACH ARM KEEPS, and that difference is the change
# itself rather than scene fussiness. This arm clips the branch from its front, so its tail
# survives and `long-path` finds it; main clips the same name from its END
# (`feature/statusline-model-retention…`), where the tail is the one thing gone and the head
# is what is left. A single needle cannot address both, and the wrong one abandons the take on
# the very behavior the pair exists to show. `normalizer` is the directory in either arm: both
# keep the tail of the path.
FOOTLINE="Auto"
DIRECTORY="normalizer"
if [ "${SCENE_ARM:-after}" = "before" ]; then
	BRANCH="feature/statusline"
else
	BRANCH="long-path"
fi

row_with "${FOOTLINE}" | grep -qF "${DIRECTORY}" ||
	abandon_take "footline" "the footline row does not carry the directory: $(row_with "${FOOTLINE}")"
row_with "${FOOTLINE}" | grep -qF "${BRANCH}" ||
	abandon_take "footline" "the footline row does not carry the branch: $(row_with "${FOOTLINE}")"

FOOT_ROW="$(row_of "${FOOTLINE}")"
collapsed="$(row_with "${FOOTLINE}")"
echo "scene: footline collapsed:${collapsed}" >&2

# The pointer starts up in the transcript, so the clip opens on a hand travelling to the row
# rather than on a cursor already parked in it.
point 8 40
pause 0.6
glide 8 40 "${FOOT_ROW}" 20 22 0.035
pause 0.4

# ---------------------------------------------------------------------------
# CLICK ONE, ON THE DIRECTORY. The zone widens and the model chip retracts on the same value.
# ---------------------------------------------------------------------------
click_text_in_row "${FOOTLINE}" "${DIRECTORY}"
settle 3
expanded="$(row_with "${FOOTLINE}")"
echo "scene: footline after the directory click:${expanded}" >&2
pause 1.2

# CLICK TWO, THE SAME PLACE. The row travels back: this is the half a still cannot show.
click_text_in_row "${FOOTLINE}" "${DIRECTORY}"
settle 3
recollapsed="$(row_with "${FOOTLINE}")"
echo "scene: footline after the second directory click:${recollapsed}" >&2
pause 1.0

# ---------------------------------------------------------------------------
# CLICK THREE, ON THE BRANCH. The whole zone is the target, not the directory alone: a reader
# who wants a longer path clicks whichever half of the location their eye is on.
# ---------------------------------------------------------------------------
glide "${FOOT_ROW}" 20 "${FOOT_ROW}" 60 14 0.035
pause 0.4
click_text_in_row "${FOOTLINE}" "${BRANCH}"
settle 3
branch_expanded="$(row_with "${FOOTLINE}")"
echo "scene: footline after the branch click:${branch_expanded}" >&2
pause 1.2

click_text_in_row "${FOOTLINE}" "${BRANCH}"
settle 3
branch_collapsed="$(row_with "${FOOTLINE}")"
echo "scene: footline after the second branch click:${branch_collapsed}" >&2
pause 1.0

# EACH ARM HELD TO WHAT THAT ARM MUST DO WITH THE CLICK, which is the only property both can
# be judged on. The after arm must answer every click and answer the reversal too; the before
# arm must answer none of them, because main has no handler for the report at all.
if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${collapsed}" != "${expanded}" ] || [ "${collapsed}" != "${branch_expanded}" ]; then
		abandon_take "before arm" "the click changed the footline on main: ${collapsed} -> ${expanded}"
	fi
	echo "scene: before arm -- four clicks, footline unchanged, which is the differential" >&2
else
	if [ "${collapsed}" = "${expanded}" ]; then
		abandon_take "directory click" "the footline did not widen: ${collapsed}"
	fi
	if [ "${expanded}" = "${recollapsed}" ]; then
		abandon_take "directory click" "the second click did not collapse the footline: ${expanded}"
	fi
	if [ "${recollapsed}" = "${branch_expanded}" ]; then
		abandon_take "branch click" "a click on the branch did not widen the footline: ${recollapsed}"
	fi
	if [ "${branch_expanded}" = "${branch_collapsed}" ]; then
		abandon_take "branch click" "the second branch click did not collapse the footline: ${branch_expanded}"
	fi
	# The reversal is exact: a row that comes back to a different width has spent something on
	# the trip, and the clip would be showing a drift rather than a toggle.
	if [ "${collapsed}" != "${recollapsed}" ] || [ "${collapsed}" != "${branch_collapsed}" ]; then
		abandon_take "reversal" "the collapsed row differs from where it started: ${collapsed} vs ${branch_collapsed}"
	fi
fi

# The pointer leaves the row, so the clip does not end on a hover state that is not part of
# what it is showing.
glide "${FOOT_ROW}" 60 8 40 18 0.03
pause 0.8
