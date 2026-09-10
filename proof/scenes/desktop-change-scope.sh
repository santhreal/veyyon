#!/usr/bin/env bash
# Switch the Changes tab from the working tree to the index and read back which
# changes the pane draws.
#
# Records visual evidence for:
#   1. working-tree (the pane on the scope the panel opens with)
#   2. staged (the pane after the other scope is clicked)
#
# THE CLAIM. Clicking `Staged` shows what is staged. The window wrote the scope
# beside the action as `working_tree` and `staged`; the host accepts only
# `WorkingTree` and `Staged` and answered `INVALID_ARGUMENTS`, and the surface
# reducer for the switch only reveals the tab, so the pane kept drawing the
# scope it was already on. Every shipped session had a dead scope toggle. The
# take drives the shipped window against the shipped host, so the pane it
# photographs is the pane an operator gets.
#
# THE ARMS. One repository, two changed files that share no line: `worktree.rs`
# is modified and unstaged, `staged.rs` is modified and staged, so the two
# scopes list different files and a switch that lands repaints the text of the
# pane. After, the pane differs across the click by more than a fifth of its
# own ink. Before, it differs by under a fiftieth of it -- the same list,
# unmoved. The ink of the first frame is the scale both readings are judged
# against, so neither arm rests on a bare pixel count.
#
# The click is proved live in both arms before it is made: the take hover-scans
# the diff chrome row, requires two hoverable controls, and clicks the second. A
# before arm that changes nothing changes nothing at a control that lights.
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build with the change removed. The take is a still one --
# it hovers a row of controls a column at a time and photographs two panes --
# so it carries its own motion floor, which the gate otherwise reads as a
# stuttering pipeline:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh proof/scenes/desktop-change-scope.sh
#   SCENE_MOTION_FLOOR=5 SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-change-scope.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── Two Scopes That Share No Line ───────────────────────────────────────────
# The unstaged file and the staged file are committed together, then modified
# apart, so `git status` reports one path in each column and the two scopes
# list different files. The ignore file admits both by name, or the sandbox
# home's own files are changes too and each scope draws more than it seeded.
REPO_DIR="${SCENE_CWD:-/sandbox/home/demo}"
WORKTREE_FILE="worktree.rs"
STAGED_FILE="staged.rs"

seed_two_scopes() {
	printf 'fn totals() {\nlet alpha = 1;\nlet bravo = 2;\nlet carol = 3;\nlet delta = 4;\n}\n' \
		>"${REPO_DIR}/${WORKTREE_FILE}"
	printf 'fn ledger() {\nlet motif = 1;\nlet quiet = 2;\nlet raven = 3;\nlet solar = 4;\nlet tempo = 5;\n}\n' \
		>"${REPO_DIR}/${STAGED_FILE}"
	printf '*\n!%s\n!%s\n' "${WORKTREE_FILE}" "${STAGED_FILE}" >"${REPO_DIR}/.gitignore"
	if [ ! -d "${REPO_DIR}/.git" ]; then
		git -C "${REPO_DIR}" init -q
	fi
	git -C "${REPO_DIR}" add -- "${WORKTREE_FILE}" "${STAGED_FILE}" .gitignore
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the lines before the change" -- "${WORKTREE_FILE}" "${STAGED_FILE}" .gitignore
	printf 'fn totals() {\nlet alpha = 11;\nlet bravo = 22;\nlet carol = 33;\nlet delta = 44;\n}\n' \
		>"${REPO_DIR}/${WORKTREE_FILE}"
	printf 'fn ledger() {\nlet motif = 91;\nlet quiet = 92;\nlet raven = 93;\nlet solar = 94;\nlet tempo = 95;\n}\n' \
		>"${REPO_DIR}/${STAGED_FILE}"
	git -C "${REPO_DIR}" add -- "${STAGED_FILE}"
}

seed_two_scopes

STATUS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | sort | tr '\n' '|')"
if [ "${STATUS}" != " M ${WORKTREE_FILE}|M  ${STAGED_FILE}|" ]; then
	abandon_take "the-two-scopes-are-disjoint" \
		"the repository reports '${STATUS}' instead of one staged and one unstaged path"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; ${STAGED_FILE} is staged and ${WORKTREE_FILE} is not" >&2

# ─── Where The Strip, The Chrome Row And The Pane Draw ───────────────────────
# Every rectangle comes from the token files and the panel geometry the
# composer preamble resolved, so the readings follow the shed at whatever width
# the take is recorded at.
read -r TABS_H CHROME_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

panels = tomllib.loads((Path(sys.argv[1]) / "surface" / "panels.toml").read_text())
print(int(panels["tabs"]["height_px"]), int(panels["chrome"]["row_height_px"]))
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
CHROME_TOP=$(( PANEL_TOP + TABS_H ))
CHROME_MID=$(( CHROME_TOP + CHROME_H / 2 ))
PANE_TOP=$(( CHROME_TOP + CHROME_H ))
PANE_H=$(( PANEL_BOTTOM - PANE_TOP ))
PANE_GEOM="${PANE_W}x${PANE_H}+${PANEL_LEFT}+${PANE_TOP}"
CHROME_GEOM="${PANE_W}x${CHROME_H}+${PANEL_LEFT}+${CHROME_TOP}"
if [ "${PANE_H}" -lt 120 ]; then
	abandon_take "the-pane-holds-a-diff" "the pane is ${PANE_H}px tall, too short to draw either scope"
fi
use_crop "${PANEL_LEFT}" "${PANE_TOP}" "${PANE_W}" "${PANE_H}"

echo "scene: the chrome row reads ${CHROME_GEOM}, the pane ${PANE_GEOM}" >&2

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"
PARK_X=$(( PANEL_LEFT + PANE_W / 2 ))
PARK_Y=$(( PANEL_BOTTOM - 4 ))

# The pane is drawn when two probes a moment apart are the same over it: its
# rows arrive on a host answer rather than on the click that asked for them.
wait_for_pane() { # <what>
	local settled=0
	for _ in $(seq 1 30); do
		probe_frame "${PROBE_DIR}/pane-a.png"
		pause 0.5
		probe_frame "${PROBE_DIR}/pane-b.png"
		if [ "$(frames_differ_pixels_at "${PROBE_DIR}/pane-a.png" "${PROBE_DIR}/pane-b.png" "${PANE_GEOM}")" -lt 40 ]; then
			settled=1
			break
		fi
		pause 0.5
	done
	if [ "${settled}" != "1" ]; then
		abandon_take "$1" "the pane never stopped repainting"
	fi
}

# How much of the pane is ink: pixels whose colour is not the pane's own
# ground. This is the scale both arms are judged against, so a pane that drew
# nothing cannot pass either reading by being empty.
pane_ink() { # <png>
	local dump="${PROBE_DIR}/pane-pixels.txt"
	magick "$1" -crop "${PANE_GEOM}" +repage txt:- >"${dump}"
	python3 - "${dump}" <<'PY'
import collections
import re
import sys

pixel = re.compile(r"^\d+,\d+: \([^)]*\)\s+(#[0-9A-Fa-f]+)")
colours = []
with open(sys.argv[1], encoding="ascii") as dump:
    for line in dump:
        match = pixel.match(line)
        if match:
            colours.append(match.group(1))

if not colours:
    print(0)
    raise SystemExit(0)

ground = collections.Counter(colours).most_common(1)[0][0]
print(sum(1 for colour in colours if colour != ground))
PY
}

# ─── The Panel Opens On The Changes Tab ──────────────────────────────────────
# Opening the panel is what asks the host for the working tree's changes. The
# leftmost tab is clicked rather than trusting the tab the window opens on,
# which is the one it was last left in.
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 1.0
wait_for_pane "the-pane-is-drawn"

shot working-tree
INK="$(pane_ink "${SCENE_OUT}/${SCENE_NAME}-working-tree.png")"
if [ "${INK}" -lt 2000 ]; then
	abandon_take "working-tree" "the pane carried ${INK}px of ink, too little to be a diff"
fi
echo "scene: the pane on the opening scope carries ${INK}px of ink" >&2

# ─── Finding The Other Scope's Control ───────────────────────────────────────
# Each control in the diff chrome row draws a background under the pointer, so
# a column is over a control when the row differs from the row unhovered, and
# two adjacent columns are over the SAME control when the two hovered rows are
# the same as each other. Counting lit columns alone cannot separate two
# controls that sit a few pixels apart; the frame each hover draws can, since
# the highlight jumps from one box to the next. The take parks the pointer off
# the row, records it unhovered, steps across the left half, and keeps every
# frame. Two lit segments are required: the scope it is on, and the scope it
# is switching to.
move_px "${PARK_X}" "${PARK_Y}"
pause 0.4
probe_frame "${PROBE_DIR}/chrome-unhovered.png"

SCAN_STEP=6
READINGS=""
SCAN_X="$(( PANEL_LEFT + 2 ))"
SCAN_END="$(( PANEL_LEFT + PANE_W / 2 ))"
PREVIOUS=""
while [ "${SCAN_X}" -lt "${SCAN_END}" ]; do
	move_px "${SCAN_X}" "${CHROME_MID}"
	pause 0.18
	CURRENT="${PROBE_DIR}/chrome-hover-${SCAN_X}.png"
	probe_frame "${CURRENT}"
	LIT_PX="$(frames_differ_pixels_at "${PROBE_DIR}/chrome-unhovered.png" "${CURRENT}" "${CHROME_GEOM}")"
	STEP_PX=0
	if [ -n "${PREVIOUS}" ]; then
		STEP_PX="$(frames_differ_pixels_at "${PREVIOUS}" "${CURRENT}" "${CHROME_GEOM}")"
	fi
	READINGS="${READINGS} ${SCAN_X}:${LIT_PX}:${STEP_PX}"
	PREVIOUS="${CURRENT}"
	SCAN_X=$(( SCAN_X + SCAN_STEP ))
done
echo "scene: the chrome row reads x:lit:step ${READINGS}" >&2

read -r SEGMENTS CLICK_X < <(
	python3 - "${READINGS}" <<'PY'
import sys

# A column is over a control when hovering it changed the row at all; a
# boundary is a column whose hovered row differs from the one beside it by
# more than a glyph's worth of antialiasing, which is where the highlight
# moved to another box.
LIT_FLOOR = 30
BOUNDARY = 200

columns = []
for reading in sys.argv[1].split():
    x, lit, step = (int(part) for part in reading.split(":"))
    columns.append((x, lit >= LIT_FLOOR, step))

segments, current = [], []
for index, (x, is_lit, step) in enumerate(columns):
    starts = index == 0 or step >= BOUNDARY or is_lit != columns[index - 1][1]
    if starts and current:
        segments.append(current)
        current = []
    current.append((x, is_lit))
if current:
    segments.append(current)

controls = [
    [x for x, is_lit in segment if is_lit]
    for segment in segments
    if all(is_lit for _, is_lit in segment)
]
if len(controls) < 2:
    print(len(controls), -1)
else:
    second = controls[1]
    print(len(controls), (second[0] + second[-1]) // 2)
PY
)

if [ "${SEGMENTS}" != "2" ]; then
	abandon_take "the-row-offers-two-scopes" \
		"the chrome row lit ${SEGMENTS} hoverable controls in its left half instead of two"
fi
echo "scene: the second scope control lights around x=${CLICK_X}" >&2

# ─── Switching Scope ─────────────────────────────────────────────────────────
move_px "${CLICK_X}" "${CHROME_MID}"
pause 0.3
click
pause 1.0
wait_for_pane "the-pane-answers-the-switch"

shot staged
MOVED="$(shots_differ_pixels working-tree staged)"
echo "scene: the switch moved ${MOVED}px of ${INK}px of ink" >&2

# The two scopes draw the same chrome, the same gutters and the same row
# tints, so a switch repaints the text of the pane rather than all of its
# ink: a fifth of the ink is far above anything a settling repaint moves, and
# a fiftieth is far below the reading a switch that lands produces.
ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	CEILING=$(( INK / 50 ))
	if [ "${MOVED}" -gt "${CEILING}" ]; then
		abandon_take "staged" \
			"the before arm moved ${MOVED}px of ${INK}px, over the ${CEILING}px a refused switch may move"
	fi
	echo "scene: BEFORE -- the switch moved ${MOVED}px of ${INK}px, at or under the ${CEILING}px ceiling" >&2
else
	FLOOR=$(( INK / 5 ))
	if [ "${MOVED}" -lt "${FLOOR}" ]; then
		abandon_take "staged" \
			"the after arm moved ${MOVED}px of ${INK}px, under the ${FLOOR}px a scope switch must move"
	fi
	echo "scene: AFTER -- the switch moved ${MOVED}px of ${INK}px, over the ${FLOOR}px floor" >&2
fi
