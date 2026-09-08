#!/usr/bin/env bash
# Switch between two sessions in the native GPUI window, leaving an unsubmitted
# draft in the first session, and photograph the rail when the draft is in the
# active session and after switching to the second session.
#
# Records visual evidence for:
#   1. unsent-draft-in-the-session-on-screen        (the active session holds an unsubmitted draft)
#   2. unsent-draft-left-behind-in-another-session (the draft is left in an inactive session)
#
# The two frames are the differential. `QueuePartition` holds four placements
# (`Pinned`, `Live`, `Deferred`, `Parked`), and `Unsent` is derived from the
# drafts: a session is lifted into `Unsent` only when it is not the active
# session on screen, its placement is `Pinned` or `Live`, and its composer draft
# is non-whitespace. In frame 1, session A is active on screen, so no row is
# lifted in either arm and both sessions stay in `Live`. In frame 2, switching
# to session B leaves session A with a draft in the background: the after arm
# lifts session A into a new `Unsent` section above `Live`, while the before arm
# keeps session A in `Live`.
#
# WHAT IS MEASURED. Both arms redraw the rail when the session on screen
# changes, so a plain frame difference cannot separate the new section header
# from the cards changing selection. Each frame is reduced to the bottom edge
# of the inked bounding box inside the rail list crop. Both frames hold the same
# two cards, so adding an `Unsent` section shifts the bottom edge down by exactly
# one section header stack (header height plus gaps above and below).
#
# NOT RECORDED HERE: the full partition sweep and membership transitions, which
# are asserted at the unit level by
# `crates/veyyon-desktop/tests/a-draft-left-in-a-session-is-stated-in-the-rail.rs`
# (sweeping every section, both membership directions, and the deferred and
# parked cases that keep drafts where they were set aside).
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-unsent-rail.sh
#
# and its other arm, whose executable is a build of this tree with the derivation
# taken back out of it:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/unsent-rail.patch unsent-rail
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/unsent-rail/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-unsent-rail.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Queue Rail And Its Sections Are ───────────────────────────────
# Read from the tokens this checkout ships rather than restated as literals, so
# a retheme cannot make the scene silently stop finding the section header.
read -r SECTION_HEADER_PX GAP_ABOVE GAP_BELOW HEADER_STACK CARD_PX FOOTER_PX CONTENT_INSET NAV_HEADER_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())

section_header_px = queue["row_heights"]["section_header_px"]
gap_above = scale["spacing"][queue["section_layout"]["gap_above"]]
gap_below = scale["spacing"][queue["section_layout"]["gap_below"]]
header_stack = section_header_px + gap_above + gap_below

card_px = queue["row_heights"]["card_px"]
footer_px = queue["footer"]["height_px"]
content_inset = scale["spacing"][queue["insets"]["content_inset"]]
nav_header_px = content_inset + 32 + gap_below

print(
    int(section_header_px),
    int(gap_above),
    int(gap_below),
    int(header_stack),
    int(card_px),
    int(footer_px),
    int(content_inset),
    int(nav_header_px),
)
PY
)
if [ -z "${HEADER_STACK:-}" ]; then
	abandon_take "tokens-resolved" "could not read queue layout tokens"
fi

if [ "${WIN_W}" -le 800 ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px has no queue rail"
fi

CROP_X="${WIN_X}"
CROP_Y=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
CROP_W=$(( RAIL_W - 2 ))
CROP_H=$(( WIN_H - TITLEBAR_H - NAV_HEADER_PX - FOOTER_PX ))

# Card centers when two cards are placed in Live.
# Card 1 is the newest session (B); Card 2 is the initial session (A).
LIVE_HEADER_TOP=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
LIVE_CARDS_TOP=$(( LIVE_HEADER_TOP + GAP_ABOVE + SECTION_HEADER_PX + GAP_BELOW ))
CARD_1_X=$(( WIN_X + RAIL_W / 2 ))
CARD_1_Y=$(( LIVE_CARDS_TOP + CARD_PX / 2 ))
CARD_2_X=$(( WIN_X + RAIL_W / 2 ))
CARD_2_Y=$(( LIVE_CARDS_TOP + CARD_PX + CARD_PX / 2 ))

WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
SWITCH_MIN_PIXELS=100
TYPED_MIN_PIXELS=500
RAIL_DIFF_MIN=200

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

rail_list_bottom_edge() { # <shot> -> bottom edge of inked bounding box in rail list crop
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local box
	box="$(magick "${png}" -crop "${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}" +repage \
		-fuzz 5% -trim -format '%@' info: 2>/dev/null || true)"
	if [ -z "${box}" ]; then
		abandon_take "rail-list-trimmed" "no inked pixels found in rail list crop for $1"
	fi
	local w h x y
	IFS='x+' read -r w h x y <<<"${box}"
	if [ -z "${h:-}" ] || [ -z "${y:-}" ] || [ "${h}" -le 0 ]; then
		abandon_take "rail-list-trimmed" "empty bounding box for $1 (got '${box}')"
	fi
	echo "$(( y + h ))"
}

# ─── 1. Create Session B ─────────────────────────────────────────────────────
# Session A was created by the shared prelude.
# Clear any leftover text from the shared prelude so Session A has an empty composer.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.3
click
pause 0.3
k "End"
for _ in $(seq 1 80); do
	k "BackSpace"
done
pause 0.3
k "ctrl+n"
if ! native_session_ready created; then
	abandon_take "native-session-b-created" "session B creation interaction produced no session within 10s"
fi
pause 1.0

# ─── 2. Switch Back To Session A ─────────────────────────────────────────────
# Click A's row (the second card in Live) and prove the switch landed.
SESSION_B_FRAME="${PROBE_DIR}/unsent-session-b.png"
probe_frame "${SESSION_B_FRAME}"
move_px "${CARD_2_X}" "${CARD_2_Y}"
pause 0.3
click
pause 0.8
SWITCH_TO_A="$(screen_differs_from_frame_pixels_at "${SESSION_B_FRAME}" "${WINDOW_CROP}")"
if [ "${SWITCH_TO_A}" -lt "${SWITCH_MIN_PIXELS}" ]; then
	abandon_take "switch-to-session-a" "clicking session A row did not switch the active session (${SWITCH_TO_A} pixels differed)"
fi

# ─── 3. Type An Unsubmitted Draft In Session A ───────────────────────────────
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.3
click
pause 0.3
k "End"
for _ in $(seq 1 80); do
	k "BackSpace"
done
pause 0.3

EMPTY_COMPOSER="${PROBE_DIR}/unsent-empty-composer.png"
probe_frame "${EMPTY_COMPOSER}"
t "Refactor queue partition layout to support derived unsent section"
pause 0.8
TYPED="$(screen_differs_from_frame_pixels_at "${EMPTY_COMPOSER}" "${WINDOW_CROP}")"
if [ "${TYPED}" -lt "${TYPED_MIN_PIXELS}" ]; then
	abandon_take "draft-typed-in-composer" "typing draft in session A produced no inked pixels in composer (${TYPED} pixels differed)"
fi

# ─── 4. Frame 1: Draft In The Active Session On Screen ───────────────────────
# Park pointer on the composer for both frames to avoid row hover styling.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
shot unsent-draft-in-the-session-on-screen

# ─── 5. Switch To Session B ──────────────────────────────────────────────────
# Click B's row (the first card in Live) and prove the switch landed.
SESSION_A_DRAFT_FRAME="${PROBE_DIR}/unsent-session-a-draft.png"
probe_frame "${SESSION_A_DRAFT_FRAME}"
move_px "${CARD_1_X}" "${CARD_1_Y}"
pause 0.3
click
pause 0.8
SWITCH_TO_B="$(screen_differs_from_frame_pixels_at "${SESSION_A_DRAFT_FRAME}" "${WINDOW_CROP}")"
if [ "${SWITCH_TO_B}" -lt "${SWITCH_MIN_PIXELS}" ]; then
	abandon_take "switch-to-session-b" "clicking session B row did not switch the active session (${SWITCH_TO_B} pixels differed)"
fi

# ─── 6. Frame 2: Draft Left Behind In Another Session ────────────────────────
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
shot unsent-draft-left-behind-in-another-session

# ─── 7. Evaluate Differential Measurement ────────────────────────────────────
EDGE_1="$(rail_list_bottom_edge unsent-draft-in-the-session-on-screen)"
EDGE_2="$(rail_list_bottom_edge unsent-draft-left-behind-in-another-session)"
DELTA=$(( EDGE_2 - EDGE_1 ))

RAIL_CROP="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}"
RAIL_DIFF="$(frames_differ_pixels_at \
	"${SCENE_OUT}/${SCENE_NAME}-unsent-draft-in-the-session-on-screen.png" \
	"${SCENE_OUT}/${SCENE_NAME}-unsent-draft-left-behind-in-another-session.png" \
	"${RAIL_CROP}")"

if [ "${RAIL_DIFF}" -lt "${RAIL_DIFF_MIN}" ]; then
	abandon_take "rail-switch-recorded" \
		"rail crop did not change between frame 1 and frame 2 (${RAIL_DIFF} pixels differed, under ${RAIL_DIFF_MIN})"
fi

AFTER_MIN_DELTA=$(( HEADER_STACK * 3 / 4 ))
AFTER_MAX_DELTA=$(( HEADER_STACK * 2 ))
BEFORE_MAX_DELTA=$(( HEADER_STACK / 3 ))

if [ "${SCENE_ARM:-after}" = "before" ]; then
	DELTA_ABS="${DELTA#-}"
	if [ "${DELTA_ABS}" -ge "${BEFORE_MAX_DELTA}" ]; then
		abandon_take "unsent-rail-before" \
			"baseline rail bottom edge shifted by ${DELTA}px (expected < ${BEFORE_MAX_DELTA}px, stack is ${HEADER_STACK}px)"
	fi
	echo "scene: before arm -- rail bottom edge ${EDGE_1} -> ${EDGE_2} (delta ${DELTA}px, expected < ${BEFORE_MAX_DELTA}px), rail diff ${RAIL_DIFF}px" >&2
else
	if [ "${DELTA}" -lt "${AFTER_MIN_DELTA}" ] || [ "${DELTA}" -gt "${AFTER_MAX_DELTA}" ]; then
		abandon_take "unsent-rail-after" \
			"after arm rail bottom edge shifted by ${DELTA}px (expected between ${AFTER_MIN_DELTA}px and ${AFTER_MAX_DELTA}px, stack is ${HEADER_STACK}px)"
	fi
	echo "scene: after arm -- rail bottom edge ${EDGE_1} -> ${EDGE_2} (delta +${DELTA}px, expected ${AFTER_MIN_DELTA}..${AFTER_MAX_DELTA}px), rail diff ${RAIL_DIFF}px" >&2
fi
