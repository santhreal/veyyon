#!/usr/bin/env bash
# Close one tab of the right panel from its own edge in a native GPUI window,
# and photograph the strip before the pointer reaches it, under the pointer,
# and after the press.
#
# Records visual evidence for:
#   1. panel-tab-rest     (the strip as the panel opens, no pointer on it)
#   2. panel-tab-hovered  (the pointer on the trailing tab, its close revealed)
#   3. panel-tab-closed   (the strip the press left)
#
# WHAT IS MEASURED. `panels.tabs` states the strip's height, the gap between
# tabs and the hit square of a tab's close, and the scene reads all three from
# the token files this checkout ships. Out of each frame it measures the
# column the strip's ink ends in, which is the trailing edge of the last tab,
# and the run of columns the selected tab's pill fills, which is where the
# selection is. Under the pointer it measures two more: how far past its label
# the hovered tab now reaches, which is the square the close was given, and
# what is drawn over the ground of that square, which is the glyph itself.
# Against those it asserts that the close is drawn in its own square only
# under the pointer, that the press takes a tab out of the strip, and that the
# selection does not move when the tab taken is not the selected one.
#
# THE PAIR. The differential is the same three frames from an executable whose
# tabs carry no close: the hovered tab reaches no further than its label, the
# press on the same pixel selects that tab instead of closing it, so the strip
# keeps every tab and the pill moves to the one the operator meant to be rid
# of. That was the only answer the strip had -- a tab was closed by activating
# it and then closing the active one, and a tab the host was still fetching
# said nothing at all.
#
# NOT RECORDED HERE: that closing the active tab selects a neighbour, that the
# close is absent while the panel holds one tab, and that a tab the projection
# marks pending draws its dot, which
# `crates/veyyon-desktop-surface/tests/a-panel-tab-closes-from-its-own-edge.rs`
# drives over every tab the enum states.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized:
#
#   proof/docker/record-native.sh proof/scenes/desktop-panel-tab-close.sh
#
# and its other arm, whose executable is a build of this tree with the close
# and the pending mark taken back out of it:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/panel-tab-close.patch panel-tab-close
#   SANTH_BUILD_GOVERNED=1 cargo build -p veyyon-desktop
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/panel-tab-close/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-panel-tab-close.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

read -r TABS_H TABS_GAP CLOSE_HIT EDGE_PX HANDLE_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

panels = token_px.load("surface/panels.toml")
tabs = panels["tabs"]
print(
    int(token_px.px(tabs["height_px"])),
    int(token_px.px(tabs["gap_px"])),
    int(token_px.px(tabs["close_hit_px"])),
    int(token_px.px(panels["chrome"]["resize_handle_line_px"])),
    int(token_px.px(panels["chrome"]["resize_handle_hit_px"])),
)
PY
)
if [ -z "${CLOSE_HIT:-}" ]; then
	abandon_take "tab-tokens-are-known" "could not read surface/panels.toml's tab measures"
fi

# ─── Where The Strip Is ──────────────────────────────────────────────────────
# The panel's box follows the shed the composer preamble resolved, so the crop
# is the same one at every width the take is recorded at.
PANEL_LEFT=$(( WIN_X + WIN_W - PANEL_W + SHEET_INSET ))
PANEL_RIGHT=$(( WIN_X + WIN_W - SHEET_INSET ))
PANEL_TOP=$(( WIN_Y + TITLEBAR_H + SHEET_INSET ))
PANE_W=$(( PANEL_RIGHT - PANEL_LEFT ))
STRIP_MID_Y=$(( PANEL_TOP + TABS_H / 2 ))
# The strip's own lower border runs the width of the panel, so a crop that
# reached it would report every column as inked and the trailing tab's edge
# as the panel's. The rows read stop short of it.
STRIP_ROWS=$(( TABS_H - 2 * EDGE_PX ))
# The panel is placed past the handle its own chrome states, and that square
# carries the hairline between the two regions, so a crop that opened on the
# panel's column would report the hairline as a tab under every state and the
# selection as never having moved. The crop opens on the strip itself.
STRIP_LEFT=$(( PANEL_LEFT + HANDLE_PX ))
STRIP_CROP="$(( PANE_W - HANDLE_PX - EDGE_PX ))x${STRIP_ROWS}+${STRIP_LEFT}+${PANEL_TOP}"

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# ─── Reading The Strip ───────────────────────────────────────────────────────
# Two numbers, neither of which names a colour. The strip's ground is the
# colour most of it is, the tabs are what is drawn over that ground, and the
# selected tab is the one whose ground is its own: so a column carrying any
# pixel that is not the strip's ground belongs to a tab, and a column whose
# OWN modal colour is not the strip's ground is inside the selected tab's
# pill. The last of the first kind is the trailing edge of the last tab; the
# run of the second kind is where the selection sits.
#
# Sets STRIP_END, PILL_START and PILL_END, each a column of the crop.
read_strip() { # <png>
	local dump="${PROBE_DIR}/tab-strip.txt"
	magick "$1" -crop "${STRIP_CROP}" +repage txt:- >"${dump}"
	read -r STRIP_END PILL_START PILL_END < <(
		python3 - "${STRIP_ROWS}" "${dump}" <<'PY'
import collections
import re
import sys

strip_rows, path = int(sys.argv[1]), sys.argv[2]
pixel = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+(#[0-9A-Fa-f]+)")
grid = {}
with open(path, encoding="ascii") as dump:
    for line in dump:
        found = pixel.match(line)
        if found:
            grid[(int(found.group(1)), int(found.group(2)))] = found.group(3)

if not grid:
    print("-1 -1 -1")
    raise SystemExit(0)

width = max(x for x, _ in grid) + 1
ground = collections.Counter(grid.values()).most_common(1)[0][0]


def column(x):
    return [grid[(x, y)] for y in range(strip_rows) if (x, y) in grid]


inked, pill = [], []
for x in range(width):
    colours = column(x)
    if not colours:
        continue
    if any(colour != ground for colour in colours):
        inked.append(x)
    if collections.Counter(colours).most_common(1)[0][0] != ground:
        pill.append(x)

print(
    inked[-1] if inked else -1,
    pill[0] if pill else -1,
    pill[-1] if pill else -1,
)
PY
	)
}

# What is drawn over a square's own ground, in pixels. The square the close
# lands in is inside the tab, so its ground is whatever the tab is painted
# with -- the strip's at rest, the hover's under the pointer -- and a glyph is
# what differs from it. Counting that rather than what changed between two
# frames keeps the reveal apart from the repaint the hover itself is.
#
# Prints one number.
square_ink() { # <png> <left-column> <width>
	local dump="${PROBE_DIR}/tab-square.txt"
	magick "$1" -crop "$3x${STRIP_ROWS}+$(( STRIP_LEFT + $2 ))+${PANEL_TOP}" +repage txt:- >"${dump}"
	python3 - "${dump}" <<'PY'
import collections
import re
import sys

pixel = re.compile(r"^\d+,\d+: \([^)]*\)\s+(#[0-9A-Fa-f]+)")
colours = []
with open(sys.argv[1], encoding="ascii") as dump:
    for line in dump:
        found = pixel.match(line)
        if found:
            colours.append(found.group(1))

if not colours:
    print(0)
    raise SystemExit(0)

ground = collections.Counter(colours).most_common(1)[0][0]
print(sum(1 for colour in colours if colour != ground))
PY
}

# ─── 1. Open The Panel And Photograph The Strip It Opens With ────────────────
# The pointer stays on the composer editor the preamble left it on, so the
# resting frame carries no tab under a hover ground.
k "ctrl+backslash"
pause 1.2
# The leftmost tab rather than the one the window was last left on: the take
# closes a tab that is NOT the selected one, so it has to know which is which.
move_px "$(( STRIP_LEFT + TABS_GAP + CLOSE_HIT ))" "${STRIP_MID_Y}"
pause 0.3
click
pause 1.0
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.8

# The strip is drawn when two probes a moment apart agree over it: a tab's
# content arrives on a host answer rather than on the key press.
SETTLED_A="${PROBE_DIR}/strip-a.png"
SETTLED=0
for _ in $(seq 1 30); do
	probe_frame "${SETTLED_A}"
	pause 0.4
	if [ "$(screen_differs_from_frame_pixels_at "${SETTLED_A}" "${STRIP_CROP}")" -le 8 ]; then
		SETTLED=1
		break
	fi
done
if [ "${SETTLED}" != "1" ]; then
	abandon_take "the-strip-is-drawn" "the panel's tab strip never stopped repainting"
fi

REST="${PROBE_DIR}/panel-tab-rest.png"
probe_frame "${REST}"
shot panel-tab-rest
read_strip "${SCENE_OUT}/${SCENE_NAME}-panel-tab-rest.png"
REST_END="${STRIP_END}"
REST_PILL_START="${PILL_START}"
REST_PILL_END="${PILL_END}"
if [ "${REST_END}" -lt 0 ] || [ "${REST_PILL_START}" -lt 0 ]; then
	abandon_take "the-strip-is-read" "the frame carried no tab strip to measure"
fi
# A strip holding one tab has nothing to close, and the pill would be the whole
# of its ink. The tabs the host offers decide this, so it is stated rather than
# assumed: the close is drawn only where there is a tab to fall back to.
if [ "${REST_END}" -le $(( REST_PILL_END + CLOSE_HIT )) ]; then
	abandon_take "the-strip-holds-more-than-one-tab" \
		"the strip's ink ends at ${REST_END} and the selected pill at ${REST_PILL_END}, so no second tab is drawn"
fi
echo "scene: the strip's ink ends in column ${REST_END}, the selected pill runs" \
	"${REST_PILL_START}..${REST_PILL_END}" >&2

# ─── 2. Point At The Trailing Tab And Read What It Revealed ──────────────────
# At rest a tab draws its label and nothing more, so the strip's ink ends at
# the last label. Pointing inside the trailing tab paints that tab's ground
# and draws its close, which sits past the label at the tab's own trailing
# edge. Two numbers come out of the hovered frame: how far past the resting
# ink the tab now reaches, which is the box the close was given, and what is
# drawn over the ground of the square at that edge, which is the glyph. The
# same square is read out of the resting frame, where the close is not drawn,
# and the selected pill out of the hovered one, to show the reveal is the
# tab's own and not a repaint of the strip.
HOVER_X=$(( STRIP_LEFT + REST_END - CLOSE_HIT / 4 ))
PILL_CROP="$(( REST_PILL_END - REST_PILL_START + 1 ))x${STRIP_ROWS}+$(( STRIP_LEFT + REST_PILL_START ))+${PANEL_TOP}"
move_px "${HOVER_X}" "${STRIP_MID_Y}"
pause 0.8
PILL_MOVED="$(screen_differs_from_frame_pixels_at "${REST}" "${PILL_CROP}")"
shot panel-tab-hovered
HOVERED="${SCENE_OUT}/${SCENE_NAME}-panel-tab-hovered.png"
read_strip "${HOVERED}"
HOVER_END="${STRIP_END}"
if [ "${HOVER_END}" -lt "${REST_END}" ]; then
	HOVER_END="${REST_END}"
fi
GREW=$(( HOVER_END - REST_END ))
SQUARE_LEFT=$(( HOVER_END - CLOSE_HIT + 1 ))
REVEALED="$(square_ink "${HOVERED}" "${SQUARE_LEFT}" "${CLOSE_HIT}")"
RESTING="$(square_ink "${SCENE_OUT}/${SCENE_NAME}-panel-tab-rest.png" "${SQUARE_LEFT}" "${CLOSE_HIT}")"
echo "scene: pointed at column $(( HOVER_X - STRIP_LEFT )), the tab reached ${GREW}px past" \
	"its label and the square at ${SQUARE_LEFT} carries ${REVEALED}px over its ground," \
	"${RESTING}px at rest" >&2

# A glyph inside the close's own square, not a stray pixel of antialiasing.
REVEAL_MIN=20
# What a square carrying nothing but its own ground reads, antialiasing and
# the frame's own noise included.
STILL_MAX=8

# ─── 3. Press It And Read The Strip It Left ──────────────────────────────────
# The press lands on the square the reveal drew in, which is the tab's
# trailing edge and never its label: a press on the label selects the tab.
CLOSE_X=$(( STRIP_LEFT + HOVER_END - CLOSE_HIT / 2 ))
move_px "${CLOSE_X}" "${STRIP_MID_Y}"
pause 0.4
click
pause 1.2
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.8
shot panel-tab-closed
read_strip "${SCENE_OUT}/${SCENE_NAME}-panel-tab-closed.png"
CLOSED_END="${STRIP_END}"
CLOSED_PILL_START="${PILL_START}"
if [ "${CLOSED_END}" -lt 0 ]; then
	abandon_take "the-closed-strip-is-read" "the frame after the press carried no tab strip"
fi

# ─── What Each Arm Claims ────────────────────────────────────────────────────
if [ "${SCENE_ARM:-after}" = "before" ]; then
	# A tab with no close is its label and its counts, so the hovered tab
	# reaches no further past that label than its own padding.
	if [ "${GREW}" -ge "${CLOSE_HIT}" ]; then
		abandon_take "before-arm-gives-no-close-a-box" \
			"the before executable's hovered tab reached ${GREW}px past its label, a close's own square"
	fi
	# The press reached the tab, not a close on it: the strip keeps every tab
	# and the selection moves to the one the operator pointed at.
	if [ "${CLOSED_END}" -lt $(( REST_END - CLOSE_HIT )) ]; then
		abandon_take "before-arm-keeps-every-tab" \
			"the before executable's strip ended at ${CLOSED_END} where it had ended at ${REST_END}"
	fi
	if [ "${CLOSED_PILL_START}" -le "${REST_PILL_START}" ]; then
		abandon_take "before-arm-selects-instead" \
			"the press left the pill at ${CLOSED_PILL_START}, so it neither closed the tab nor selected it"
	fi
	echo "scene: the before arm's hovered tab reached ${GREW}px past its label, kept its ink to" \
		"column ${CLOSED_END} and moved the selection to column ${CLOSED_PILL_START}" >&2
	return 0 2>/dev/null || exit 0
fi

if [ "${GREW}" -lt "${CLOSE_HIT}" ]; then
	abandon_take "the-close-is-given-its-square" \
		"the hovered tab reached ${GREW}px past its label, under the ${CLOSE_HIT}px its close is drawn in"
fi
if [ "${REVEALED}" -lt "${REVEAL_MIN}" ]; then
	abandon_take "the-close-is-revealed" \
		"the square at the tab's edge carries ${REVEALED}px over its ground, under the ${REVEAL_MIN}px a glyph draws"
fi
if [ "${RESTING}" -gt "${STILL_MAX}" ]; then
	abandon_take "the-close-is-the-pointers-own" \
		"the same square carried ${RESTING}px with no pointer on the tab, so the close is drawn at rest"
fi
if [ "${PILL_MOVED}" -gt "${STILL_MAX}" ]; then
	abandon_take "the-reveal-is-the-tabs-own" \
		"pointing at the trailing tab repainted ${PILL_MOVED}px of the selected tab"
fi
if [ "${CLOSED_END}" -gt $(( REST_END - CLOSE_HIT )) ]; then
	abandon_take "the-press-takes-a-tab" \
		"the strip's ink ends at ${CLOSED_END} where it ended at ${REST_END}, so no tab left the strip"
fi
if [ "${CLOSED_PILL_START}" != "${REST_PILL_START}" ]; then
	abandon_take "the-selection-stays" \
		"closing a tab that was not selected moved the pill from ${REST_PILL_START} to ${CLOSED_PILL_START}"
fi

echo "scene: the close drew ${REVEALED}px in the square at the tab's edge and ${RESTING}px at" \
	"rest, the press took the strip's ink from column ${REST_END} to ${CLOSED_END}, and the" \
	"selection stayed at ${REST_PILL_START}" >&2
