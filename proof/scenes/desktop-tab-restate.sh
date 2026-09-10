#!/usr/bin/env bash
# Change a working tree while the panel is open on another tab, then move back
# to the Changes tab and read what the pane draws.
#
# Records visual evidence for:
#   1. the-pane-as-the-panel-opened (the diff the panel was sent when it opened)
#   2. the-pane-after-moving-to-the-tab (the same pane, moved back to after the
#      working tree changed)
#
# THE CLAIM. The host answers Changes, the file tree, the open file and the
# usage totals only when a client asks. The panel asked once, as it opened, and
# selecting one of its tabs was shell-local: it moved the strip and drew
# whatever the domain had been sent at the handshake. A working tree changed for
# any reason other than a turn -- a command run in the terminal drawer, a file
# edited by hand, a commit made outside the window -- therefore reached the pane
# through no gesture except closing the panel and opening it again, which is the
# one path that re-asked. Moving to a tab now asks the host to state the domain
# that tab draws. The take drives the shipped window against the shipped host,
# so the pane it photographs is the pane an operator gets.
#
# THE ARMS. One repository holding one file the operator modified by hand, so
# the pane opens on a diff and its ink is the scale both readings are judged
# against. A second tracked file is then rewritten on disk, with no turn running
# and nothing else asking the host for anything, and the take leaves the Changes
# tab and comes back to it. After, the pane differs from the frame it opened on
# by more than half of its own ink: it draws the second file's hunk as well as
# the first. Before, it differs by under a fiftieth of it -- the diff of the one
# file, as the panel was sent it.
#
# The second edit is proved on disk in both arms, and the tab move is proved to
# have landed by the pane repainting when the take leaves the tab, so a before
# arm that draws nothing is a pane that did not re-state and not a gesture that
# missed.
#
# The change is inside the executable, so the before arm holds no source and
# takes a build with the change removed. The take is a still one -- it opens a
# panel, edits a file and photographs two panes -- so it carries its own motion
# floor, which the gate otherwise reads as a stuttering pipeline:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh proof/scenes/desktop-tab-restate.sh
#   SCENE_MOTION_FLOOR=5 SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-tab-restate.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── Two Files, One Changed Before The Window Opens And One After ────────────
# Both committed, so the pane opens on a diff rather than on an empty list: an
# empty pane has no ink to judge either arm against. The ignore file admits the
# two paths by name, or the sandbox home's own files are changes too and the
# pane draws more than the scene seeded.
REPO_DIR="${SCENE_CWD:-/sandbox/home/demo}"
LEDGER="ledger.rs"
MANIFEST="manifest.rs"
# The second file sorts after the first, so its hunk arrives below the one the
# pane is already drawing and the reading is of ink added rather than of a
# column that shifted. It is rewritten line for line, so what it adds to the
# pane is a taller block of rows than the pane opened with.
MANIFEST_LINES=12

seed_two_files() {
	printf 'fn ledger() {\nlet motif = 1;\nlet quiet = 2;\nlet raven = 3;\nlet solar = 4;\nlet tempo = 5;\n}\n' \
		>"${REPO_DIR}/${LEDGER}"
	: >"${REPO_DIR}/${MANIFEST}"
	for line in $(seq 1 "${MANIFEST_LINES}"); do
		printf 'const ENTRY_%02d: u32 = %d;\n' "${line}" "${line}" >>"${REPO_DIR}/${MANIFEST}"
	done
	printf '*\n!%s\n!%s\n' "${LEDGER}" "${MANIFEST}" >"${REPO_DIR}/.gitignore"
	if [ ! -d "${REPO_DIR}/.git" ]; then
		git -C "${REPO_DIR}" init -q
	fi
	git -C "${REPO_DIR}" add -- "${LEDGER}" "${MANIFEST}" .gitignore
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the lines the window opens on" -- "${LEDGER}" "${MANIFEST}" .gitignore
	# The one edit the panel is sent as it opens.
	printf 'fn ledger() {\nlet motif = 11;\nlet quiet = 22;\nlet raven = 33;\nlet solar = 44;\nlet tempo = 55;\n}\n' \
		>"${REPO_DIR}/${LEDGER}"
}

# The edit nothing tells the host about: no turn runs, no tool is called, and
# the panel stays open across it.
edit_by_hand() {
	: >"${REPO_DIR}/${MANIFEST}"
	for line in $(seq 1 "${MANIFEST_LINES}"); do
		printf 'const ENTRY_%02d: u32 = %d;\n' "${line}" $(( line * 100 )) >>"${REPO_DIR}/${MANIFEST}"
	done
}

seed_two_files

STATUS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | sort | tr '\n' '|')"
if [ "${STATUS}" != " M ${LEDGER}|" ]; then
	abandon_take "the-pane-opens-on-one-edit" \
		"the repository reports '${STATUS}' instead of the one unstaged path the scene seeded"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; ${LEDGER} is modified and ${MANIFEST} is not" >&2

# ─── Where The Tab Strip, The Chrome Row And The Pane Draw ───────────────────
# Every rectangle comes from the token files and the panel geometry the composer
# preamble resolved, so the readings follow the shed at whatever width the take
# is recorded at.
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
PANE_TOP=$(( PANEL_TOP + TABS_H + CHROME_H ))
PANE_H=$(( PANEL_BOTTOM - PANE_TOP ))
PANE_GEOM="${PANE_W}x${PANE_H}+${PANEL_LEFT}+${PANE_TOP}"
if [ "${PANE_H}" -lt 120 ]; then
	abandon_take "the-pane-holds-a-diff" "the pane is ${PANE_H}px tall, too short to draw a diff"
fi
use_crop "${PANEL_LEFT}" "${PANE_TOP}" "${PANE_W}" "${PANE_H}"

echo "scene: the pane reads ${PANE_GEOM}" >&2

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The pane is drawn when two probes a moment apart are the same over it: its
# rows arrive on a host answer rather than on the gesture that asked for them.
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

# How much of the pane is ink: pixels whose colour is not the pane's own ground.
# This is the scale both arms are judged against, so a pane that drew nothing
# cannot pass either reading by being empty.
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
# Opening the panel is what asks the host for the working tree's changes, and
# before this change it was the only thing that ever asked. The leftmost tab is
# clicked rather than trusting the tab the window opens on, which is the one it
# was last left in, and the click also hands the keyboard to the panel, whose
# scope owns the chord that moves off the tab.
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 1.0
wait_for_pane "the-pane-is-drawn"

shot the-pane-as-the-panel-opened
OPENED="${SCENE_OUT}/${SCENE_NAME}-the-pane-as-the-panel-opened.png"
INK="$(pane_ink "${OPENED}")"
if [ "${INK}" -lt 2000 ]; then
	abandon_take "the-pane-as-the-panel-opened" \
		"the pane carried ${INK}px of ink, too little to be a diff"
fi
echo "scene: the pane the panel opened on carries ${INK}px of ink" >&2

# ─── A File Rewritten With Nothing To Tell The Host ──────────────────────────
edit_by_hand
STATUS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | sort | tr '\n' '|')"
if [ "${STATUS}" != " M ${LEDGER}| M ${MANIFEST}|" ]; then
	abandon_take "the-second-file-changed" \
		"the repository reports '${STATUS}' instead of the two unstaged paths the scene wrote"
fi
CHANGED="$(git -C "${REPO_DIR}" diff --numstat -- "${MANIFEST}" | cut -f1)"
if [ "${CHANGED}" != "${MANIFEST_LINES}" ]; then
	abandon_take "the-second-file-changed" \
		"${MANIFEST} reports ${CHANGED} changed lines instead of ${MANIFEST_LINES}"
fi
echo "scene: ${MANIFEST} now differs by ${CHANGED} lines; nothing has told the host" >&2

# ─── Off The Tab And Back To It ──────────────────────────────────────────────
# The panel's own chord moves to the next tab, and the pane repainting is the
# proof the chord landed: both arms move, so a before arm that reads no change
# in the diff is a pane that did not re-state rather than a gesture that missed.
k "ctrl+alt+bracketright"
pause 1.2
probe_frame "${PROBE_DIR}/off-the-tab.png"
LEFT_PX="$(frames_differ_pixels_at "${OPENED}" "${PROBE_DIR}/off-the-tab.png" "${PANE_GEOM}")"
if [ "${LEFT_PX}" -lt "$(( INK / 5 ))" ]; then
	abandon_take "off-the-tab" \
		"moving to the next tab repainted ${LEFT_PX}px of ${INK}px of ink, so the chord did not land"
fi
echo "scene: the next tab repainted ${LEFT_PX}px of ${INK}px of ink" >&2

# Back to the leftmost tab, which is the gesture under test: the operator moves
# to the Changes tab and the pane states the working tree as it is now.
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 1.0
wait_for_pane "the-pane-settles-on-the-tab"
shot the-pane-after-moving-to-the-tab
MOVED="$(shots_differ_pixels the-pane-as-the-panel-opened the-pane-after-moving-to-the-tab)"
echo "scene: moving back to the tab moved ${MOVED}px of ${INK}px of ink" >&2

# The pane keeps its chrome, its gutters and its row tints across the gesture,
# so a re-statement adds the second file's block to the first file's diff: half
# of the ink is far above anything a settling repaint moves, and a fiftieth is
# far below the reading a pane that re-stated produces.
ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	if [ "${MOVED}" -gt "$(( INK / 20 ))" ]; then
		abandon_take "the-pane-after-moving-to-the-tab" \
			"the before arm's pane moved ${MOVED}px of ${INK}px of ink, so it re-stated the working tree"
	fi
	echo "scene: before arm -- the pane came back to ${MOVED}px of ${INK}px of ink," \
		"holding the diff it was sent when the panel opened" >&2
else
	if [ "${MOVED}" -lt "$(( INK / 2 ))" ]; then
		abandon_take "the-pane-after-moving-to-the-tab" \
			"the after arm's pane moved ${MOVED}px of ${INK}px of ink, too little to be the second file's hunk"
	fi
	echo "scene: after arm -- the pane moved ${MOVED}px of ${INK}px of ink," \
		"drawing the file that changed while it was on another tab" >&2
fi
