#!/usr/bin/env bash
# Collapse and reopen a queue section in the native GPUI window and read
# whether the rows under it travelled to their new place or arrived at it.
#
# Records visual evidence for:
#   1. sections-open      (the rail holding an Unsent card above the Live one)
#   2. section-collapsed  (the same rail with Unsent folded away)
#
# THE PAIR IS A SETTINGS DIFFERENTIAL, not two builds. One arm records at the
# shipped default, where `display.transitions` is `on`; the other seeds `off`
# into the profile config before the session starts:
#
#   SCENE_MOTION_FLOOR=4 \
#     proof/docker/record-native.sh proof/scenes/desktop-reduced-motion.sh
#   SCENE_MOTION_FLOOR=4 SCENE_SETTINGS='display.transitions: off' \
#     OUT_DIR="${PWD}/proof/captures/x11/transitions-off" \
#     proof/docker/record-native.sh proof/scenes/desktop-reduced-motion.sh
#
# Both arms carry a lowered motion floor and both arms mean it. The scene
# spends its length waiting for a rail to stop moving so it can photograph
# what stopping looks like, and one arm is a window that was asked to hold
# still: a take here changes fewer frames per second than a scene of streamed
# output, and the recorder's default floor reads that as a stuttering capture.
# The two arms write to different directories, since a settings differential
# records the same scene name twice.
#
# WHAT IS MEASURED. Folding a section away moves every row under it: the queue
# runs a FLIP shift over the rows and a reveal spring over the section's body
# (§7.1, §7.3), and with motion reduced both resolve to their settled value on
# the frame the press lands. A still cannot state that, and neither can one
# probe: the travel is a fraction of a second, and a probe that arrives late
# reads the same pixels either way. So the scene presses the header TOGGLES
# times, grabs the screen the instant after each press, grabs it again once the
# rail is at rest, and counts the presses whose first grab differs from the
# rest that followed it. With motion on, some of those grabs land mid-travel
# and the count is non-zero. With motion off, every grab after a press is
# already the settled rail, and the count is exactly zero.
#
# A zero count means nothing on its own -- a press that never reached the
# header would score zero too -- so the arm that expects zero also reads the
# open rail against the collapsed one and requires the section to have moved.
#
# NOT RECORDED HERE: that the setting reaches the driver at all, which
# `crates/veyyon-desktop/tests/a-window-told-to-stop-moving-carries-that-to-the-drivers.rs`
# drives through the reducer and a live window; and which values reduce, which
# that suite pins on this side and
# `packages/coding-agent/test/gui-host/settings-themes-and-keybindings-are-configured-and-persisted.test.ts`
# pins on the host's.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Which Arm This Take Is ──────────────────────────────────────────────────
# The arm is seeded into the profile config before the window opens, so the
# scene reads the file the product reads rather than trusting the knob that
# was meant to write it. An arm whose seeding never landed is abandoned here
# instead of publishing a frame under the wrong label.
CONFIG_YML="${HOME}/.veyyon/profiles/${VEYYON_PROFILE:-default}/agent/config.yml"
SEEDED_OFF=0
if [ -f "${CONFIG_YML}" ] && grep -qE '^display\.transitions:[[:space:]]*off$' "${CONFIG_YML}"; then
	SEEDED_OFF=1
fi
ASKED_OFF=0
case "${SCENE_SETTINGS:-}" in
	*display.transitions*off*) ASKED_OFF=1 ;;
esac
if [ "${SEEDED_OFF}" != "${ASKED_OFF}" ]; then
	abandon_take "the-arm-is-seeded" \
		"SCENE_SETTINGS asked for reduced=${ASKED_OFF} and ${CONFIG_YML} holds reduced=${SEEDED_OFF}"
fi
echo "scene: recording the ${SEEDED_OFF}-reduced arm against ${CONFIG_YML}" >&2

# ─── Where The Rail And Its Section Headers Are ──────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the aim with the
# surface rather than leaving the scene pressing empty ground.
read -r SECTION_HEADER_PX GAP_ABOVE GAP_BELOW CARD_PX FOOTER_PX CONTENT_INSET NAV_HEADER_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())

gap_above = scale["spacing"][queue["section_layout"]["gap_above"]]
gap_below = scale["spacing"][queue["section_layout"]["gap_below"]]
content_inset = scale["spacing"][queue["insets"]["content_inset"]]

print(
    int(queue["row_heights"]["section_header_px"]),
    int(gap_above),
    int(gap_below),
    int(queue["row_heights"]["card_px"]),
    int(queue["footer"]["height_px"]),
    int(content_inset),
    int(content_inset + 32 + gap_below),
)
PY
)
if [ -z "${NAV_HEADER_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read the queue layout tokens"
fi
if [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "a ${WIN_W}px window docks no queue rail, so no section header is reachable"
fi

# The rail's list, from under its search-and-new header to above its footer.
# Every reading below is taken through this rectangle: the transcript beside it
# and the composer under it move for reasons that are not this setting.
CROP_X="${WIN_X}"
CROP_Y=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
CROP_W=$(( RAIL_W - 2 ))
CROP_H=$(( WIN_H - TITLEBAR_H - NAV_HEADER_PX - FOOTER_PX ))
RAIL_CROP="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The two cards while both sessions sit in Live, and the first section header
# once one of them is lifted into Unsent. A header is pressed at its middle,
# past the chevron, which is inside the row whatever the label reads.
LIVE_CARDS_TOP=$(( CROP_Y + GAP_ABOVE + SECTION_HEADER_PX + GAP_BELOW ))
CARD_1_X=$(( WIN_X + RAIL_W / 2 ))
CARD_1_Y=$(( LIVE_CARDS_TOP + CARD_PX / 2 ))
CARD_2_X="${CARD_1_X}"
CARD_2_Y=$(( LIVE_CARDS_TOP + CARD_PX + CARD_PX / 2 ))
HEADER_X=$(( WIN_X + RAIL_W / 2 ))
HEADER_Y=$(( CROP_Y + GAP_ABOVE + SECTION_HEADER_PX / 2 ))

# How many presses the reading is taken over, and how much of the rail must
# differ for a grab to count as taken mid-travel. A row travels most of a card
# height, which repaints thousands of pixels; a session row's own age text
# ticking over between two grabs repaints a few dozen.
TOGGLES=10
# How long the rail is given to reach rest before the second grab. The reveal
# spring settles inside a third of a second and the FLIP inside a fifth, so
# this is several times the longest travel either arm can be running.
REST_SECONDS=1
IN_FLIGHT_MIN_PIXELS=800
# What folding the section away does to the rail at rest. Read on both arms:
# it is the guard that separates a rail that never moved from one that moved
# without travelling.
COLLAPSE_MIN_PIXELS=1500
SWITCH_MIN_PIXELS=100
TYPED_MIN_PIXELS=500

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# ─── 1. Two Sessions, One Of Them Holding A Draft ────────────────────────────
# Two sections is what makes the travel visible: folding the upper one away
# moves the lower header and its card up the rail. Session A is the prelude's;
# it takes the draft and then goes into the background, which is what lifts it
# out of Live and into Unsent (§5.2).
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
	abandon_take "native-session-b-created" "the second session was not created within 10s"
fi
pause 1.0

SESSION_B_FRAME="${PROBE_DIR}/reduced-session-b.png"
probe_frame "${SESSION_B_FRAME}"
move_px "${CARD_2_X}" "${CARD_2_Y}"
pause 0.3
click
pause 0.8
SWITCHED="$(screen_differs_from_frame_pixels_at "${SESSION_B_FRAME}" "${WINDOW_CROP}")"
if [ "${SWITCHED}" -lt "${SWITCH_MIN_PIXELS}" ]; then
	abandon_take "switch-to-session-a" \
		"pressing the second card changed ${SWITCHED} pixels, so the rail row did not switch the session"
fi

move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.3
click
pause 0.3
k "End"
for _ in $(seq 1 80); do
	k "BackSpace"
done
pause 0.3
EMPTY_COMPOSER="${PROBE_DIR}/reduced-empty-composer.png"
probe_frame "${EMPTY_COMPOSER}"
t "Fold the queue sections while the rail is being read"
pause 0.8
TYPED="$(screen_differs_from_frame_pixels_at "${EMPTY_COMPOSER}" "${WINDOW_CROP}")"
if [ "${TYPED}" -lt "${TYPED_MIN_PIXELS}" ]; then
	abandon_take "draft-typed-in-composer" \
		"typing the draft changed ${TYPED} pixels, so the keystrokes went somewhere other than the composer"
fi

# Back to the second session, which leaves the draft behind and lifts its
# session into a section of its own above Live.
move_px "${CARD_1_X}" "${CARD_1_Y}"
pause 0.3
click
settle 2

# ─── 2. The Rail At Rest, With Both Sections Open ────────────────────────────
# The pointer rests on the header it is about to press, so every frame from
# here carries the same hover ground and none of the readings below is a
# pointer arriving.
move_px "${HEADER_X}" "${HEADER_Y}"
settle 2
shot sections-open
OPEN_FRAME="${SCENE_OUT}/${SCENE_NAME}-sections-open.png"

# ─── 3. Press The Header, Grab The Screen, Grab It Again At Rest ─────────────
# The first grab is issued with no pause after the press: the travel is the
# span between the press and the rail settling, and the grab either lands
# inside it or it does not. The second grab is the same rail once it has
# stopped, and the difference between the two is what the press was worth.
IN_FLIGHT=0
for press in $(seq 1 "${TOGGLES}"); do
	click
	PRESSED="${PROBE_DIR}/reduced-pressed-${press}.png"
	probe_frame "${PRESSED}"
	settle "${REST_SECONDS}"
	RESTED="${PROBE_DIR}/reduced-rested-${press}.png"
	probe_frame "${RESTED}"
	MOVED="$(frames_differ_pixels_at "${PRESSED}" "${RESTED}" "${RAIL_CROP}")"
	if [ "${MOVED}" -ge "${IN_FLIGHT_MIN_PIXELS}" ]; then
		IN_FLIGHT=$(( IN_FLIGHT + 1 ))
		echo "scene: press ${press} was caught in travel (${MOVED}px still to move)" >&2
	fi
done

# ─── 4. The Section Folded Away ──────────────────────────────────────────────
# An even number of presses leaves the rail where it started, so the frame the
# gallery carries is taken after one more.
click
settle 2
shot section-collapsed
COLLAPSED_FRAME="${SCENE_OUT}/${SCENE_NAME}-section-collapsed.png"

FOLDED="$(frames_differ_pixels_at "${OPEN_FRAME}" "${COLLAPSED_FRAME}" "${RAIL_CROP}")"
if [ "${FOLDED}" -lt "${COLLAPSE_MIN_PIXELS}" ]; then
	abandon_take "the-section-folded" \
		"the rail differs by ${FOLDED}px between open and collapsed, under the ${COLLAPSE_MIN_PIXELS}px folding a card away draws"
fi

# ─── 5. What The Presses Came To ─────────────────────────────────────────────
if [ "${SEEDED_OFF}" = "1" ]; then
	if [ "${IN_FLIGHT}" -ne 0 ]; then
		abandon_take "the-rows-did-not-travel" \
			"${IN_FLIGHT} of ${TOGGLES} presses were caught mid-travel with transitions off"
	fi
	echo "scene: transitions off -- ${TOGGLES} presses, none caught in travel, ${FOLDED}px between the open rail and the folded one" >&2
else
	if [ "${IN_FLIGHT}" -lt 2 ]; then
		abandon_take "the-rows-travelled" \
			"${IN_FLIGHT} of ${TOGGLES} presses were caught mid-travel with transitions on, under the 2 a travelling rail owes"
	fi
	echo "scene: transitions on -- ${IN_FLIGHT} of ${TOGGLES} presses caught in travel, ${FOLDED}px between the open rail and the folded one" >&2
fi
