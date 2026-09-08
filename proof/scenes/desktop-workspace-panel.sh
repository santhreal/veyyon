#!/usr/bin/env bash
# Drive the transcript, the composer and the contextual workspace panel in one
# live session, and photograph what each does to the other two.
#
# Records visual evidence for:
#   1. session-only     (transcript and composer at the window's full width)
#   2. panel-docked     (the panel inline at the trailing edge, transcript narrowed)
#   3. panel-draft      (a draft typed while the panel is docked)
#   4. panel-file       (a file opened from the tree, drawn in the File tab)
#   5. drawer-open      (the terminal drawer over the session's lower edge)
#   6. drawer-closed    (the drawer gone, the state under it unchanged)
#   7. session-restored (the panel closed, the transcript back to full width)
#
# What the frames state, asserted here rather than left to a reader:
#
# - The docked panel is contextual, not modal: it draws at the trailing edge,
#   leaves the rail alone, and the composer under it still takes a keystroke.
# - The drawer overlays: it covers the composer, swallows what is typed into
#   it, and leaves the draft it covered intact when it closes.
# - Neither leaves anything behind: closing the panel returns the transcript to
#   the frame it had before it opened.
#
# The session is a real one on the real host, and the file is whatever the
# host's own tree listed. Nothing here is seeded into a view.
#
# A three-region take is still between keystrokes for most of its length, so it
# declares its own floor the way the other native scenes do:
#
#   SCENE_MOTION_FLOOR=9 proof/docker/record-native.sh proof/scenes/desktop-workspace-panel.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Regions ─────────────────────────────────────────────────────────────
# Every comparison names one region, because the session list prints each row's
# age and the composer blinks a caret: two frames a second apart differ outside
# the region under test whatever that region did.
RAIL_W=$(( WIN_W > 800 ? 256 : 0 ))
PANEL_W=$(( WIN_W >= 1440 ? 540 : 360 ))
COLUMN_X=$(( WIN_X + RAIL_W ))
COLUMN_W=$(( WIN_W - RAIL_W ))
TITLEBAR_H=48
COMPOSER_H=140

rail_region() { use_crop "${WIN_X}" "$(( WIN_Y + TITLEBAR_H ))" "${RAIL_W}" "$(( WIN_H - TITLEBAR_H ))"; }
panel_region() { use_crop "$(( WIN_X + WIN_W - PANEL_W ))" "$(( WIN_Y + TITLEBAR_H ))" "${PANEL_W}" "$(( WIN_H - TITLEBAR_H ))"; }
column_region() { use_crop "${COLUMN_X}" "$(( WIN_Y + TITLEBAR_H ))" "${COLUMN_W}" "$(( WIN_H - TITLEBAR_H ))"; }
composer_region() { use_crop "${COLUMN_X}" "$(( WIN_Y + WIN_H - COMPOSER_H ))" "${COLUMN_W}" "${COMPOSER_H}"; }
transcript_region() { use_crop "${COLUMN_X}" "$(( WIN_Y + TITLEBAR_H ))" "${COLUMN_W}" "$(( WIN_H - TITLEBAR_H - COMPOSER_H ))"; }

# A surface that opened or closed repaints a large share of its region; two
# settled frames of one state measure a couple of pixels per thousand apart on
# this renderer, which is the software rasteriser's own noise.
DREW_PER_MILLE=40
IDENTICAL_PER_MILLE=3
# A typed draft is a few glyphs in a 140px strip, which rounds to nothing per
# mille, so the composer is read in pixels.
TYPED_PIXELS=150

COMPOSER_X=$(( COLUMN_X + 120 ))
COMPOSER_Y=$(( WIN_Y + WIN_H - 98 ))

# ─── 1. The Session Alone ────────────────────────────────────────────────────
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.6
shot session-only

# ─── 2. The Panel Docks ──────────────────────────────────────────────────────
k "ctrl+backslash"
pause 1.2
shot panel-docked

panel_region
PANEL_DREW="$(shots_differ_per_mille session-only panel-docked)"
if [ "${PANEL_DREW}" -lt "${DREW_PER_MILLE}" ]; then
	abandon_take "the-panel-drew-at-the-trailing-edge" \
		"the trailing ${PANEL_W}px changed ${PANEL_DREW}/1000 when the panel opened, under the ${DREW_PER_MILLE} an opened surface changes"
fi
rail_region
RAIL_MOVED="$(shots_differ_per_mille session-only panel-docked)"
if [ "${RAIL_MOVED}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "the-panel-left-the-rail-alone" \
		"the session rail changed ${RAIL_MOVED}/1000 when the panel opened, so the panel moved what it sits beside"
fi

# ─── 3. The Composer Under A Docked Panel ────────────────────────────────────
# The panel is contextual: what is being written is still reachable. This is
# the claim a rendered panel cannot make for itself.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
pause 0.3
t "the panel is docked and this still reaches the draft"
pause 0.8
shot panel-draft

composer_region
DRAFT_PIXELS="$(shots_differ_pixels panel-docked panel-draft)"
if [ "${DRAFT_PIXELS}" -lt "${TYPED_PIXELS}" ]; then
	abandon_take "the-composer-takes-a-keystroke-under-a-docked-panel" \
		"the composer strip changed ${DRAFT_PIXELS} pixels, under the ${TYPED_PIXELS} a typed draft changes"
fi

# ─── 4. A File From The Host's Own Tree ──────────────────────────────────────
# The tab is reached from the panel's own scope, and the row is found by
# clicking rather than by arithmetic: the tree is the host's listing, so a
# row's y depends on what the workspace holds, and which tabs the panel offers
# at all depends on what the host declared. So each tab the walk reaches is
# offered its own rows, and the take stands on the first row that opened a
# file.
PANEL_MID_X=$(( WIN_X + WIN_W - PANEL_W / 2 ))
move_px "${PANEL_MID_X}" "$(( WIN_Y + WIN_H / 2 ))"
click
pause 0.4

FILE_OPENED=0
for tab in $(seq 0 4); do
	if [ "${tab}" -gt 0 ]; then
		move_px "${PANEL_MID_X}" "$(( WIN_Y + WIN_H / 2 ))"
		click
		pause 0.3
		k "ctrl+alt+bracketright"
		pause 0.6
	fi
	for step in $(seq 0 12); do
		move_px "$(( WIN_X + WIN_W - PANEL_W + 60 ))" "$(( WIN_Y + TITLEBAR_H + 60 + step * 24 ))"
		pause 0.2
		click
		pause 0.8
		move_px "${PANEL_MID_X}" "$(( WIN_Y + WIN_H / 2 ))"
		pause 0.3
		panel_region
		if [ "$(screen_differs_from_shot_per_mille panel-draft)" -ge "${DREW_PER_MILLE}" ]; then
			FILE_OPENED=1
			break
		fi
	done
	if [ "${FILE_OPENED}" = 1 ]; then
		break
	fi
done
if [ "${FILE_OPENED}" != 1 ]; then
	abandon_take "a-row-of-the-tree-opened-a-file" \
		"no row in the first twelve of any tab the panel offers changed the panel when clicked, so the tree listed nothing the host could open"
fi
shot panel-file

# ─── 5. The Drawer Overlays ──────────────────────────────────────────────────
k "ctrl+j"
pause 1.5
shot drawer-open

composer_region
DRAWER_DREW="$(shots_differ_per_mille panel-file drawer-open)"
if [ "${DRAWER_DREW}" -lt "${DREW_PER_MILLE}" ]; then
	abandon_take "the-drawer-covered-the-lower-edge" \
		"the composer's band changed ${DRAWER_DREW}/1000 when the drawer opened, so nothing was drawn over it"
fi

# What is typed at the composer's own coordinates while the drawer covers them
# belongs to the drawer, and the draft underneath is untouched by it.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
pause 0.3
t "this belongs to the terminal, not to the draft"
pause 1.0
k "ctrl+j"
pause 1.2
shot drawer-closed

column_region
UNDER_DRAWER="$(shots_differ_per_mille panel-file drawer-closed)"
if [ "${UNDER_DRAWER}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "the-drawer-left-the-draft-it-covered" \
		"the session column differs from its pre-drawer frame by ${UNDER_DRAWER}/1000, so what was typed into the drawer reached the composer under it"
fi

# ─── 6. The Panel Closes Without A Trace ─────────────────────────────────────
k "ctrl+backslash"
pause 1.2
shot session-restored

transcript_region
RESTORED="$(shots_differ_per_mille session-only session-restored)"
if [ "${RESTORED}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "the-transcript-came-back-to-its-full-width" \
		"the transcript differs from its pre-panel frame by ${RESTORED}/1000 after the panel closed"
fi

echo "scene: panel ${PANEL_DREW}/1000 at the trailing edge, rail ${RAIL_MOVED}/1000, draft ${DRAFT_PIXELS}px," \
	"drawer ${DRAWER_DREW}/1000, under it ${UNDER_DRAWER}/1000, transcript restored ${RESTORED}/1000" >&2
