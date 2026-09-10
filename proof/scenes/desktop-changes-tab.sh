#!/usr/bin/env bash
# Open the right panel on a working tree that holds one changed file, and read
# back which tabs the host's capabilities left the panel with.
#
# Records visual evidence for:
#   1. changes-tab (the panel's tab strip and the pane the leftmost tab draws)
#
# THE CLAIM. The panel offers a Changes tab whenever the host answers the
# `Changes` capability, and that tab draws the working tree. The GUI host
# answers `Changes` and reports `PendingEdits` unavailable -- it inspects no
# edit buffer -- and the panel had required both, so the tab was withdrawn from
# every session the product ever opened. The take drives the shipped host, so
# what it photographs is the tab strip an operator gets.
#
# THE ARMS. Before, the panel listed File, Tree and Usage: the leftmost tab is
# the file view and the pane draws no hunk. After, the leftmost tab is Changes
# and the pane draws the two blocks of the one changed file. Both readings are
# measured -- the width of the selected tab's pill, and the number of blocks of
# changed rows in the pane -- so neither arm rests on reading a label.
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build with the change removed:
#
#   proof/docker/record-native.sh proof/scenes/desktop-changes-tab.sh
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-changes-tab.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── The Working Tree The Tab Draws ──────────────────────────────────────────
# One tracked file with four consecutive lines replaced, which is a hunk tall
# enough to be found as two blocks of rows rather than as chrome. The ignore
# file is committed with it, or the sandbox home's own ignore file is a second
# changed file and the pane draws two hunks where this take reads one.
REPO_DIR="${SCENE_CWD:-/sandbox/home/demo}"
FILE_NAME="ledger.rs"
CHANGED_LINES=4

seed_changed_file() {
	local file="${REPO_DIR}/${FILE_NAME}"
	printf 'fn totals() {\nlet alpha = 1;\nlet bravo = 2;\nlet carol = 3;\nlet delta = 4;\n}\n' >"${file}"
	printf '*\n!%s\n' "${FILE_NAME}" >"${REPO_DIR}/.gitignore"
	if [ ! -d "${REPO_DIR}/.git" ]; then
		git -C "${REPO_DIR}" init -q
	fi
	git -C "${REPO_DIR}" add -- "${FILE_NAME}" .gitignore
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the lines before the change" -- "${FILE_NAME}" .gitignore
	printf 'fn totals() {\nlet alpha = 11;\nlet bravo = 22;\nlet carol = 33;\nlet delta = 44;\n}\n' >"${file}"
}

seed_changed_file

CHANGED_PATHS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | wc -l)"
if [ "${CHANGED_PATHS}" != "1" ]; then
	abandon_take "the-tree-holds-one-change" \
		"the repository holds ${CHANGED_PATHS} changed paths instead of ${FILE_NAME} alone"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; ${FILE_NAME} is the one changed file in ${REPO_DIR}" >&2

# ─── Where The Strip And The Pane Draw ───────────────────────────────────────
# Both rectangles come from the token files and the panel geometry the composer
# preamble resolved, so the crops follow the shed at whatever width the take is
# recorded at.
read -r ROW_H TABS_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

panels = tomllib.loads((Path(sys.argv[1]) / "surface" / "panels.toml").read_text())
print(int(panels["diff"]["row_height_px"]), int(panels["tabs"]["height_px"]))
PY
)

PANEL_LEFT=$(( WIN_X + WIN_W - PANEL_W + SHEET_INSET ))
PANEL_RIGHT=$(( WIN_X + WIN_W - SHEET_INSET ))
PANEL_TOP=$(( WIN_Y + TITLEBAR_H + SHEET_INSET ))
PANEL_BOTTOM=$(( WIN_Y + WIN_H - SHEET_INSET ))
if [ "${PANEL_MODE}" = "overlay" ]; then
	PANEL_BOTTOM=$(( WIN_Y + WIN_H - COMPOSER_BAND_H - SHEET_INSET ))
fi
PANE_W=$(( PANEL_RIGHT - PANEL_LEFT ))
ROWS_TOP=$(( PANEL_TOP + TABS_H ))
ROWS_H=$(( PANEL_BOTTOM - ROW_H - ROWS_TOP ))
if [ "${ROWS_H}" -lt "$(( 2 * CHANGED_LINES * ROW_H ))" ]; then
	abandon_take "the-pane-holds-the-hunk" \
		"the pane is ${ROWS_H}px tall, under the $(( 2 * CHANGED_LINES * ROW_H ))px two blocks need"
fi

echo "scene: the strip reads ${PANE_W}x${TABS_H} at +${PANEL_LEFT}+${PANEL_TOP}," \
	"the pane ${PANE_W}x${ROWS_H} at +${PANEL_LEFT}+${ROWS_TOP}" >&2

# ─── Reading The Strip And The Pane ──────────────────────────────────────────
# The selected tab draws a filled pill and the others draw their label on the
# strip's own ground, so the pill is the run of columns whose colour down the
# strip is not that ground: a wide one is a tab with a name and two counts, a
# narrow one is a four-letter label. A block of changed rows is a run of pixel
# rows whose own ground is one colour that is not the pane's, as tall as the
# hunk. Neither reading names a colour.
#
# Sets PILL_PX and BLOCKS.
read_panel() { # <png>
	local dump="${SCENE_RUNTIME_DIR}/frame-compare/panel-pixels.txt"
	mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
	magick "$1" -crop "${PANE_W}x$(( TABS_H + ROWS_H ))+${PANEL_LEFT}+${PANEL_TOP}" +repage txt:- >"${dump}"
	read -r PILL_PX BLOCKS < <(
		python3 - "${ROW_H}" "${TABS_H}" "${CHANGED_LINES}" "${dump}" <<'PY'
import collections
import re
import sys

row_h, tabs_h, changed = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
pixel = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+(#[0-9A-Fa-f]+)")
grid = {}
with open(sys.argv[4], encoding="ascii") as dump:
    for line in dump:
        match = pixel.match(line)
        if not match:
            continue
        grid[(int(match.group(1)), int(match.group(2)))] = match.group(3)

if not grid:
    print("-1 -1")
    raise SystemExit(0)

width = max(x for x, _ in grid) + 1
height = max(y for _, y in grid) + 1


def modal(pixels):
    counter = collections.Counter(pixels)
    return counter.most_common(1)[0][0] if counter else None


# The pill: columns of the strip whose colour is not the strip's ground.
strip = [(x, y) for (x, y) in grid if y < tabs_h]
strip_ground = modal(grid[key] for key in strip)
pill = sum(
    1
    for x in range(width)
    if modal(grid.get((x, y)) for y in range(tabs_h)) not in (None, strip_ground)
)

# The blocks: runs of pixel rows below the strip whose own ground is one colour
# that is not the pane's, each as tall as the hunk.
pane_ground = modal(grid[key] for key in grid if key[1] >= tabs_h)
rows = {
    y: modal(grid.get((x, y)) for x in range(width)) for y in range(tabs_h, height)
}
blocks, start = 0, None
for y in range(tabs_h, height + 1):
    colour = rows.get(y)
    if start is None:
        if colour is not None and colour != pane_ground:
            start = (y, colour)
        continue
    if colour != start[1]:
        if y - start[0] >= (changed - 1) * row_h:
            blocks += 1
        start = (y, colour) if colour is not None and colour != pane_ground else None

print(pill, blocks)
PY
	)
}

# ─── The Panel Opens On The Tab The Host Left It ─────────────────────────────
# Opening the panel is what asks the host for the working tree's changes. The
# take clicks the leftmost tab rather than trusting the one the window opens
# on, since that is what the window was last left in, and reads whichever tab
# that turned out to be.
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 1.0

# The panel is drawn when two probes a moment apart are the same over it: the
# rows arrive on a host answer rather than on the key press.
PANEL_GEOM="${PANE_W}x$(( TABS_H + ROWS_H ))+${PANEL_LEFT}+${PANEL_TOP}"
PANEL_A="${SCENE_RUNTIME_DIR}/frame-compare/panel-a.png"
PANEL_B="${SCENE_RUNTIME_DIR}/frame-compare/panel-b.png"
mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
SETTLED=0
for _ in $(seq 1 30); do
	probe_frame "${PANEL_A}"
	pause 0.5
	probe_frame "${PANEL_B}"
	if [ "$(frames_differ_pixels_at "${PANEL_A}" "${PANEL_B}" "${PANEL_GEOM}")" -lt 40 ]; then
		SETTLED=1
		break
	fi
	pause 0.5
done
if [ "${SETTLED}" != "1" ]; then
	abandon_take "the-panel-is-drawn" "the panel never stopped repainting"
fi

shot changes-tab
read_panel "${SCENE_OUT}/${SCENE_NAME}-changes-tab.png"
if [ "${PILL_PX}" -lt 0 ]; then
	abandon_take "changes-tab" "the frame carried no panel to read"
fi

ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	# A tab strip whose leftmost tab is `File`, and a pane with no hunk in it.
	if [ "${PILL_PX}" -gt 50 ]; then
		abandon_take "changes-tab" \
			"the selected tab is ${PILL_PX}px wide, so this build is not the one that withdrew the Changes tab"
	fi
	if [ "${BLOCKS}" != "0" ]; then
		abandon_take "changes-tab" \
			"the pane drew ${BLOCKS} blocks of changed rows on a build that offers no Changes tab"
	fi
else
	if [ "${PILL_PX}" -lt 60 ]; then
		abandon_take "changes-tab" \
			"the selected tab is ${PILL_PX}px wide, too narrow for a Changes tab with its two counts"
	fi
	if [ "${BLOCKS}" != "2" ]; then
		abandon_take "changes-tab" \
			"the pane drew ${BLOCKS} blocks of changed rows instead of the 2 the hunk holds"
	fi
fi

echo "scene: ${ARM} arm -- the selected tab's pill is ${PILL_PX}px wide and the pane holds" \
	"${BLOCKS} blocks of changed rows" >&2
