#!/usr/bin/env bash
# Search the workspace's file contents from the native GPUI palette and
# photograph the lines the host found.
#
# Records visual evidence for:
#   1. content-search-empty   (the mode open, nothing typed, no rows)
#   2. content-search-matches (the same mode with a query, listing what matched)
#   3. content-search-cleared (the query emptied, the matches gone)
#
# Frames 1 and 2 are the differential. Content Search is not a setting, it is a
# lookup: one frame of it proves nothing, because a mode that lists the wrong
# domain looks exactly like one that lists the right one. Frame 1 is the mode
# with nothing to show, frame 2 is the host's answer to a word that is in this
# workspace, and frame 3 is that the rows follow the query rather than outliving
# it.
#
# Nothing here fabricates a match. The rows are whatever the host's own search
# returned for the word typed into the real window.
#
# A lookup take is mostly still: the palette waits for the host's answer, and
# each of the three states is held long enough for two settled frames to be
# measured. That reads as eleven frames a second of change against the twelve
# the recorder requires, so the take declares its own floor:
#
#   SCENE_MOTION_FLOOR=9 proof/docker/record-native.sh proof/scenes/desktop-content-search.sh
#
# That is not a waiver. The floor exists to stop a stuttering capture being
# published as a clip, and this window is still between keystrokes rather than
# a compositor dropping frames: the number is measured and printed either way,
# and all three marks assert their own pixel deltas, which a stuttered capture
# could not produce.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   SCENE_MOTION_FLOOR=9 proof/docker/record-native.sh proof/scenes/desktop-content-search.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# The session list prints each session's age, so two frames a second apart
# differ in the sidebar whatever the palette does. Every comparison crops the
# sidebar off first.
CROP_X=$(( WIN_X + (WIN_W > 800 ? 256 : 0) ))
CROP_Y=$(( WIN_Y + 48 ))
CROP_W=$(( WIN_W - (WIN_W > 800 ? 256 : 0) ))
CROP_H=$(( WIN_H - 48 ))

# A row of the palette is two lines of text in a 36px band, and this scene
# expects several of them: far above the noise two settled frames of one state
# show on this renderer.
ROWS_MIN_PIXELS=800

# The comparison excludes the field itself. A placeholder of twenty characters
# giving way to a typed query inks more than a row does, so a whole-window
# comparison passes on a lookup that answered with nothing: the earlier take of
# this scene did exactly that. The palette centres in the height under the
# titlebar and grows in both directions as rows arrive, so everything from just
# below the untyped palette's own field downwards is a region only rows reach.
FIELD_BOTTOM=$(( WIN_Y + 48 + (WIN_H - 48) / 2 - 14 ))
ROWS_CROP="${CROP_W}x$(( WIN_Y + WIN_H - FIELD_BOTTOM ))+${CROP_X}+${FIELD_BOTTOM}"

differing_pixels() { # <shot-a> <shot-b> [<crop>]
	local scratch="${SCENE_RUNTIME_DIR}/frame-compare"
	mkdir -p "${scratch}"
	local crop="${3:-${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}}" differing
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" -crop "${crop}" +repage "${scratch}/a.png"
	magick "${SCENE_OUT}/${SCENE_NAME}-$2.png" -crop "${crop}" +repage "${scratch}/b.png"
	# `compare` exits non-zero whenever the two images differ at all, which is
	# the ordinary case here, so only the count it prints is read.
	differing="$(compare -metric AE "${scratch}/a.png" "${scratch}/b.png" null: 2>&1 || true)"
	case "${differing}" in
		'' | *[!0-9]*)
			abandon_take "frames-comparable" \
				"comparing $1 with $2 reported '${differing}' instead of a pixel count"
			;;
	esac
	printf '%s' "${differing}"
}

# ─── The Mode Is Opened By Its Command ───────────────────────────────────────
# `/search` is the row that opens the mode; typing the slash command is how an
# operator reaches it, so the scene reaches it that way rather than by a chord
# no surface offers.
COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + WIN_H - 98 ))
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.3
t "/search"
pause 0.8
k "Return"
pause 1.0
shot content-search-empty

# ─── The Host Answers What Was Typed ─────────────────────────────────────────
# `process.env` is read by nine of this workspace's own modules, so the rows are
# the host's real search over real files and not a fixture. It also states that
# the query is taken literally: `.` matches a dot rather than any character, so
# a row's own preview carries the string that was typed.
t "process.env"
pause 2.5
shot content-search-matches

FOUND="$(differing_pixels content-search-empty content-search-matches "${ROWS_CROP}")"
if [ "${FOUND}" -lt "${ROWS_MIN_PIXELS}" ]; then
	abandon_take "matches-listed" \
		"typing a word this workspace carries changed ${FOUND} pixels, under the \
${ROWS_MIN_PIXELS} a list of matched lines inks, so the search reached no rows"
fi

# ─── The Rows Follow The Query ───────────────────────────────────────────────
# An emptied field lists nothing rather than the matches of the query before
# it, which is the state frame 1 already photographed.
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 1.5
shot content-search-cleared

STALE="$(differing_pixels content-search-empty content-search-cleared "${ROWS_CROP}")"
if [ "${STALE}" -ge "${ROWS_MIN_PIXELS}" ]; then
	abandon_take "matches-cleared" \
		"the emptied field differs from the untyped one by ${STALE} pixels, at least the \
${ROWS_MIN_PIXELS} a list of matched lines inks, so the rows outlived the query that fetched them"
fi
