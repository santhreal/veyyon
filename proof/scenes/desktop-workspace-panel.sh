#!/usr/bin/env bash
# Drive the transcript, the composer and the contextual workspace panel in one
# live session, and photograph what each does to the other two.
#
# Records visual evidence for:
#   1. session-only     (transcript and composer at the window's full width)
#   2. panel-docked     (the panel inline at the trailing edge, transcript narrowed)
#   3. panel-draft      (a draft typed while the panel is docked)
#   4. panel-file       (a file opened from the tree, drawn in the File tab)
#   5. panel-after-chord (the panel's tab chord, taken after a press in it)
#   6. composer-edge-draft (a keystroke after a press in the composer's padding)
#   7. drawer-open      (the terminal drawer over the session's lower edge)
#   8. drawer-closed    (the drawer gone, the state under it unchanged)
#   9. session-restored (the panel closed, the transcript back to full width)
#
# What the frames state, asserted here rather than left to a reader:
#
# - The docked panel is contextual, not modal: it draws at the trailing edge,
#   leaves the rail alone, and the composer under it still takes a keystroke.
# - The drawer overlays: it covers the composer, swallows what is typed into
#   it, and leaves the draft it covered intact when it closes.
# - A press in the panel puts its own chords on the focus path, so the tab
#   chord moves the mark in the tab strip, and a press in the composer's
#   padding leaves the next keystroke in the draft.
# - Neither leaves anything behind: closing the panel returns the transcript to
#   the frame it had before it opened.
#
# The session is a real one on the real host, and the file is whatever the
# host's own tree listed. Nothing here is seeded into a view.
#
# A three-region take is still between keystrokes for most of its length, and
# the tree probe below waits on the host for every row it tries, so it declares
# its own floor the way the other native scenes do. Both arms are recorded from
# one scene, the before arm against a build of the base ref, since a source hold
# cannot rebuild a compiled executable:
#
#   SCENE_MOTION_FLOOR=6 proof/docker/record-native.sh proof/scenes/desktop-workspace-panel.sh
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=6 \
#     PROOF_NATIVE_BEFORE_BINARY=<base-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-workspace-panel.sh
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
# The 24px strip the active tab is marked in (`panels.toml` `[tabs] height_px`).
# A tab that opens on an empty document redraws little of the panel's body, so
# the whole-panel rectangle reads a tab walk as noise; the strip does not.
panel_tabs_region() { use_crop "$(( WIN_X + WIN_W - PANEL_W ))" "$(( WIN_Y + TITLEBAR_H ))" "${PANEL_W}" 24; }
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
# The row is found by clicking rather than by arithmetic: the tree is the
# host's listing, so a row's y depends on what the workspace holds, and which
# tabs the panel offers at all depends on what the host declared. So each tab
# the walk reaches is offered its own rows, and the take stands on the first
# row that opened a file.
#
# The walk presses the tab strip instead of sending the tab chord, so this
# section reads the same in both arms: the chord is what section 4b measures,
# and a section that depended on it would abandon the before arm on the very
# behavior the pair is recorded to show missing.
PANEL_LEFT=$(( WIN_X + WIN_W - PANEL_W ))
PANEL_MID_X=$(( WIN_X + WIN_W - PANEL_W / 2 ))
TABS_Y=$(( WIN_Y + TITLEBAR_H + 12 ))
move_px "${PANEL_MID_X}" "$(( WIN_Y + WIN_H / 2 ))"
click
pause 0.4

FILE_OPENED=0
for tab in $(seq 0 4); do
	if [ "${tab}" -gt 0 ]; then
		move_px "$(( PANEL_LEFT + 16 + tab * 44 ))" "${TABS_Y}"
		pause 0.2
		click
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

# ─── 4b. The Panel Takes The Keyboard, The Composer Keeps It ─────────────────
# The two claims this pair is recorded for, each guarded in the direction its
# arm is true in (§5.14):
#
# - The press that opened the file above put the panel's own chords on the focus
#   path, so the tab chord moves the mark in the tab strip. Before, the
#   container carried no key context and tracked no focus handle, so all three
#   panel chords resolved to nothing.
# - A press in the composer's box that misses the editor's text area still
#   leaves the keyboard in the draft. Before, the window root took the focus
#   during the bubble phase and the next keystroke went nowhere.
#
# The frame the file opened in is the frame the chord is measured against: a
# press on an already focused panel draws nothing of its own, so a second
# baseline of it would be the same bytes.
k "ctrl+alt+bracketright"
pause 1.0
shot panel-after-chord

panel_tabs_region
WALKED="$(shots_differ_per_mille panel-file panel-after-chord)"
if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${WALKED}" -gt "${IDENTICAL_PER_MILLE}" ]; then
		abandon_take "the-tab-chord-reached-nothing" \
			"the tab strip changed ${WALKED}/1000 on the tab chord, so this arm is not the state the chord was dead in"
	fi
else
	if [ "${WALKED}" -lt "${DREW_PER_MILLE}" ]; then
		abandon_take "the-tab-chord-moved-the-panel" \
			"the tab strip changed ${WALKED}/1000 on the tab chord, under the ${DREW_PER_MILLE} a moved tab mark draws"
	fi
fi

# The press lands in the composer's own box, to the side of the centred card
# the editor draws in: the band the defect lived in. The draft is measured
# against the frame before the press, because a press that only moves a caret
# draws too little to stand a frame of its own.
COMPOSER_PAD_X=$(( COLUMN_X + 24 ))
move_px "${COMPOSER_PAD_X}" "${COMPOSER_Y}"
click
pause 0.4
t " plus this"
pause 0.8
shot composer-edge-draft

composer_region
EDGE_DRAFT="$(shots_differ_pixels panel-after-chord composer-edge-draft)"
if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${EDGE_DRAFT}" -ge "${TYPED_PIXELS}" ]; then
		abandon_take "a-press-beside-the-editor-kept-the-keyboard" \
			"the composer strip changed ${EDGE_DRAFT} pixels, so this arm is not the state the press blurred the draft in"
	fi
else
	if [ "${EDGE_DRAFT}" -lt "${TYPED_PIXELS}" ]; then
		abandon_take "a-press-beside-the-editor-keeps-the-keyboard" \
			"the composer strip changed ${EDGE_DRAFT} pixels, under the ${TYPED_PIXELS} a typed draft changes"
	fi
fi

# ─── 5. The Drawer Overlays ──────────────────────────────────────────────────
k "ctrl+j"
pause 1.5
shot drawer-open

composer_region
DRAWER_DREW="$(shots_differ_per_mille composer-edge-draft drawer-open)"
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
UNDER_DRAWER="$(shots_differ_per_mille composer-edge-draft drawer-closed)"
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
