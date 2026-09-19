#!/usr/bin/env bash
# Type into the native window's session search and photograph the rail it was
# opened from.
#
# Records visual evidence for:
#   1. rail-search-every-session (the rail at rest, listing every session)
#   2. rail-search-narrowed      (a query typed, the rail listing the one match)
#   3. rail-search-no-match      (a query nothing matches, the rail stating the step)
#   4. rail-search-filter-kept   (the search closed, the rail still narrowed)
#
# Frames 1 and 2 are the differential. The rail's search reads the rows the
# window already holds, so narrowing is the whole point of typing into it: the
# header states the query it was given and offers a control that clears it, and
# both of those name a filter the rail applies. In the before arm nothing set
# that filter -- the palette ranked its own copy of the rows and the rail kept
# listing every session whatever was typed -- so the same keystrokes leave the
# rail as frame 1 photographed it.
#
# WHAT IS MEASURED. Each frame is reduced to the inked bounding box inside the
# rail list crop, whose height is how much of the list is drawn. Five sessions
# are listed at rest and one title carries the typed word, so the after arm
# sheds at least two rows of ink and the before arm sheds less than half of
# one. A row is measured as the compact line rather than the card, because
# which section the host places a session it did not open in is the host's
# decision and a card is taller: the floor holds for either shape. A plain
# frame difference cannot separate the narrowing from the palette's own shadow
# falling on the rail, and the rail is the subject here, so it is never
# cropped off.
#
# THE ROWS ARE NOT INVENTED. Four sessions are seeded into this workspace's
# session store by proof/docker/seed-demo.sh and read back by the host the way a
# resumed session is; the fifth is the one the window opened with. A title is
# written by the titling model from a session's first prompt, which no take can
# ask for twice and get the same words back, so the four carry committed titles.
# One of them carries "limiter" and no other does, and no title or workspace
# path carries "zzz".
#
# NOT RECORDED HERE: clearing the filter from the header's own control, and
# creating a session while a filter is set, which clears it. Both are asserted
# against the shell state by
# crates/veyyon-desktop-surface/tests/typing-in-the-rail-search-narrows-the-rail-it-was-opened-from.rs,
# which also sweeps the palette modes that must leave the rail alone.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The window is still between keystrokes, so
# the take declares its own motion floor. Record the after arm with:
#
#   SCENE_MOTION_FLOOR=4 \
#     proof/docker/record-native.sh proof/scenes/desktop-rail-search.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and names a build whose session search narrows nothing:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/rail-search.patch rail-search
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/rail-search/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-rail-search.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Rail, Its Header And Its Rows Are ─────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crop and the
# click with the surface instead of leaving the scene aiming at a row that has
# moved.
read -r CONTENT_INSET ROW_INSET GAP_BELOW LINE_PX FOOTER_PX HEADER_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

print(
    token_px.value_of("surface/queue.toml", "geometry.insets.content_inset"),
    token_px.value_of("surface/queue.toml", "geometry.insets.row_inset"),
    token_px.value_of("surface/queue.toml", "geometry.section_layout.gap_below"),
    token_px.value_of("surface/queue.toml", "geometry.row_heights.line_px"),
    token_px.value_of("surface/queue.toml", "geometry.footer.height_px"),
    token_px.px("s11"),
)
PY
)
if [ -z "${HEADER_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read the queue layout tokens"
fi

if [ "${QUEUE_MODE}" != "inline" ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px draws no inline queue rail"
fi

# The header band is the rail's top inset, the header row itself, and the gap
# under it. The list starts below that and ends above the fixed footer.
NAV_HEADER_PX=$(( CONTENT_INSET + HEADER_PX + GAP_BELOW ))
CROP_X="${WIN_X}"
CROP_Y=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
CROP_W=$(( RAIL_W - 2 ))
CROP_H=$(( WIN_H - TITLEBAR_H - NAV_HEADER_PX - FOOTER_PX ))
RAIL_CROP="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The header's search control fills the row left of the new-session button, so
# its own middle is left of the rail's middle by half that button.
SEARCH_X=$(( WIN_X + ROW_INSET + (RAIL_W - 2 * ROW_INSET - HEADER_PX) / 2 ))
SEARCH_Y=$(( WIN_Y + TITLEBAR_H + CONTENT_INSET + HEADER_PX / 2 ))

OVERLAY_MIN_PIXELS=4000
RAIL_DIFF_MIN=200
# The overlay blurs what it draws over and dithers that blur per frame, so two
# frames of the same blurred rail differ by thousands of pixels compared
# exactly and by about a dozen compared at 5%. Every mark inside the rail is
# read at that fuzz, or a list photographed twice reads as a list redrawn.
RAIL_FUZZ="5%"
ARM="${SCENE_ARM:-after}"

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

rail_ink_height() { # <shot> -> height of the inked bounding box in the rail list
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local box
	box="$(magick "${png}" -crop "${RAIL_CROP}" +repage \
		-fuzz 5% -trim -format '%@' info: 2>/dev/null || true)"
	if [ -z "${box}" ]; then
		abandon_take "rail-list-trimmed" "no inked pixels in the rail list crop of $1"
	fi
	local w h x y
	IFS='x+' read -r w h x y <<<"${box}"
	if [ -z "${h:-}" ] || [ "${h}" -le 0 ]; then
		abandon_take "rail-list-trimmed" "empty bounding box for $1 (got '${box}')"
	fi
	echo "${h}"
}

rail_differs() { # <shot-a> <shot-b> -> differing pixels inside the rail list
	local scratch="${PROBE_DIR}/rail-diff" differing
	mkdir -p "${scratch}"
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		-crop "${RAIL_CROP}" +repage "${scratch}/a.png"
	magick "${SCENE_OUT}/${SCENE_NAME}-$2.png" \
		-crop "${RAIL_CROP}" +repage "${scratch}/b.png"
	differing="$(compare -metric AE -fuzz "${RAIL_FUZZ}" \
		"${scratch}/a.png" "${scratch}/b.png" null: 2>&1 || true)"
	case "${differing}" in
		'' | *[!0-9]*)
			abandon_take "rail-comparable" \
				"comparing $1 with $2 over the rail list reported '${differing}' instead of a pixel count"
			;;
	esac
	echo "${differing}"
}

# ─── 1. The Rail At Rest ─────────────────────────────────────────────────────
# The pointer is parked off the rail for every frame, so no row carries hover
# styling in one frame and not in another.
if ! native_session_ready before; then
	abandon_take "native-host-ready" "the native host returned no session snapshot within 10s"
fi
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.8
shot rail-search-every-session

AT_REST="$(rail_ink_height rail-search-every-session)"
if [ "${AT_REST}" -lt $(( LINE_PX * 3 )) ]; then
	abandon_take "sessions-listed" \
		"the rail drew ${AT_REST}px of rows, fewer than the three rows the seeded store holds"
fi

# ─── 2. The Search Is Opened From The Rail's Own Header ──────────────────────
# Clicking the header's search control is how an operator reaches it; `/` in the
# rail's scope opens the same surface and needs the rail focused first, which a
# click on a row would do by opening that session.
RAIL_AT_REST="${PROBE_DIR}/rail-at-rest.png"
probe_frame "${RAIL_AT_REST}"
move_px "${SEARCH_X}" "${SEARCH_Y}"
pause 0.3
click
pause 0.8
OPENED="$(screen_differs_from_frame_pixels_at "${RAIL_AT_REST}" "${WINDOW_CROP}")"
if [ "${OPENED}" -lt "${OVERLAY_MIN_PIXELS}" ]; then
	abandon_take "search-opened" \
		"clicking the rail's search control drew nothing (${OPENED} pixels differed)"
fi
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"

# ─── 3. A Query One Session Matches ──────────────────────────────────────────
t "limiter"
pause 1.2
shot rail-search-narrowed

NARROWED="$(rail_ink_height rail-search-narrowed)"
SHED=$(( AT_REST - NARROWED ))
printf 'scene: the rail drew %spx of rows at rest and %spx under the query, shedding %spx\n' \
	"${AT_REST}" "${NARROWED}" "${SHED}"

# ─── 4. A Query No Session Matches ───────────────────────────────────────────
# The rail states the condition it is in and the step out of it, which is the
# empty state a filter reaches rather than the one an empty store reaches.
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.3
t "zzz"
pause 1.2
shot rail-search-no-match

EMPTIED="$(rail_differs rail-search-narrowed rail-search-no-match)"

# ─── 5. The Filter Outlives The Search It Was Typed Into ─────────────────────
# Escape closes the overlay. The query stays on the rail, because the header
# states it and offers the control that clears it: a filter that left with the
# palette would leave that control naming nothing.
#
# An unanchored overlay draws a scrim over the whole window, the rail included,
# so every rail pixel differs between a frame with the search open and one
# without it. Two marks read around that. The rail's inked height against the
# frame taken under the query, which a uniform dimming moves by a few pixels,
# is the rail listing the same nothing it listed with the search open; the same
# height against the unfiltered rail, both frames taken with no overlay drawn,
# is the filter still set once the surface it was typed into is gone.
NO_MATCH_FRAME="${PROBE_DIR}/rail-no-match.png"
probe_frame "${NO_MATCH_FRAME}"
k "Escape"
pause 1.0
CLOSED="$(screen_differs_from_frame_pixels_at "${NO_MATCH_FRAME}" "${WINDOW_CROP}")"
if [ "${CLOSED}" -lt "${OVERLAY_MIN_PIXELS}" ]; then
	abandon_take "search-closed" \
		"Escape left the search drawn (${CLOSED} pixels differed)"
fi
shot rail-search-filter-kept

NO_MATCH_H="$(rail_ink_height rail-search-no-match)"
KEPT_H="$(rail_ink_height rail-search-filter-kept)"
KEPT_SHED=$(( AT_REST > KEPT_H ? AT_REST - KEPT_H : 0 ))
KEPT_DELTA=$(( KEPT_H > NO_MATCH_H ? KEPT_H - NO_MATCH_H : NO_MATCH_H - KEPT_H ))

# ─── 6. What The Arms Are Judged On ──────────────────────────────────────────
if [ "${ARM}" = "before" ]; then
	if [ "${SHED}" -ge $(( LINE_PX / 2 )) ]; then
		abandon_take "before-rail-unchanged" \
			"the before arm shed ${SHED}px of rows, so this build narrows the rail"
	fi
	if [ "${EMPTIED}" -ge "${RAIL_DIFF_MIN}" ]; then
		abandon_take "before-rail-unchanged" \
			"the before arm redrew ${EMPTIED} pixels of the rail for a query nothing matches"
	fi
	BEFORE_KEPT_DELTA=$(( AT_REST > KEPT_H ? AT_REST - KEPT_H : KEPT_H - AT_REST ))
	if [ "${BEFORE_KEPT_DELTA}" -ge "${LINE_PX}" ]; then
		abandon_take "before-rail-unchanged" \
			"the before arm drew ${KEPT_H}px of rows against ${AT_REST}px at rest, so something narrowed it"
	fi
	printf 'scene: before arm -- %spx of rows through both queries and after the search closed, %s pixels of rail moved\n' \
		"${AT_REST}" "${EMPTIED}"
else
	if [ "${SHED}" -lt $(( LINE_PX * 2 )) ]; then
		abandon_take "rail-narrowed" \
			"the query shed ${SHED}px of rows, less than the two rows one match must shed"
	fi
	if [ "${EMPTIED}" -lt "${RAIL_DIFF_MIN}" ]; then
		abandon_take "rail-states-the-step" \
			"a query nothing matches redrew ${EMPTIED} pixels of the rail, so no empty state replaced the row"
	fi
	if [ "${KEPT_SHED}" -lt $(( LINE_PX * 2 )) ]; then
		abandon_take "filter-kept" \
			"the rail drew ${KEPT_H}px of rows once the search closed, within two rows of the ${AT_REST}px it drew unfiltered, so the filter left with the surface it was typed into"
	fi
	if [ "${KEPT_DELTA}" -ge "${LINE_PX}" ]; then
		abandon_take "filter-kept" \
			"closing the search moved the rail's rows by ${KEPT_DELTA}px, so it stopped listing the nothing the query left it on"
	fi
	printf 'scene: after arm -- %spx of rows -> %spx under `limiter` -> the step for `zzz` at %spx, %spx of it after the search closed\n' \
		"${AT_REST}" "${NARROWED}" "${NO_MATCH_H}" "${KEPT_H}"
fi
