#!/usr/bin/env bash
# Open the right panel on a repository the host cannot read, and read back
# whether the panel states why.
#
# Records visual evidence for:
#   1. panel-failure (the panel's tab strip and the band under it)
#
# THE CLAIM. A workspace request the host refuses is stated in the panel it was
# sent from, in the host's own words, with the answer the host offered about
# it. The panel used to read the error on its own controls as a boolean, set a
# status enum from it and drop the sentence, so a refused working tree gave the
# operator nothing to act on -- and where the panel had already been answered
# once, the status stayed `Loaded` and the refusal was drawn nowhere at all.
# That is the state this take photographs: the panel is answered while the
# repository is readable, and the refusal arrives afterwards.
#
# THE ARMS. The reading is the same in both arms: the runs of pixel rows under
# the tab strip whose own ground is not the pane's. Before, there is one -- the
# pane's `Working tree / Staged / Unified` toolbar, over the empty working tree
# the host was answered with, with the refusal reaching no drawn element at
# all. After, there are two: the host's sentence and its Dismiss, one row of
# chrome tall, above that same toolbar. Neither reading names a colour.
#
# The refusal is the shipped host's own: `git status` on a repository whose
# index is unreadable exits 128, the changes handler turns that into a `Change`
# scope failure with git's message, and the window lands it on the control the
# request went out on. The seeding corrupts nothing outside the take's own
# sandbox repository, and both arms assert git refuses before the panel opens,
# so neither arm can pass on a repository that was readable after all.
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build with the change removed:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh \
#     proof/scenes/desktop-panel-failure.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-panel-failure.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── A Repository The Host Can Read, Then Cannot ─────────────────────────────
# One committed file and a clean tree, so the answer the host gives while the
# repository is readable puts no diff rows in the band this take reads. The
# ignore file is committed with it, or the sandbox home's own files are changes
# and the pane draws rows over the band.
REPO_DIR="${SCENE_CWD:-/sandbox/home/demo}"
FILE_NAME="ledger.rs"

seed_clean_repository() {
	printf 'fn totals() {\n\tlet alpha = 1;\n\tlet bravo = 2;\n}\n' >"${REPO_DIR}/${FILE_NAME}"
	printf '*\n!%s\n' "${FILE_NAME}" >"${REPO_DIR}/.gitignore"
	if [ ! -d "${REPO_DIR}/.git" ]; then
		git -C "${REPO_DIR}" init -q
	fi
	git -C "${REPO_DIR}" add -- "${FILE_NAME}" .gitignore
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the tree the host was answered with" -- "${FILE_NAME}" .gitignore
}

seed_clean_repository

CHANGED_PATHS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | wc -l)"
if [ "${CHANGED_PATHS}" != "0" ]; then
	abandon_take "the-tree-is-clean" \
		"the repository holds ${CHANGED_PATHS} changed paths, which would draw rows over the band"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; ${REPO_DIR} is a clean repository" >&2

# ─── Where The Strip And The Band Draw ───────────────────────────────────────
# Both rectangles come from the token files and the panel geometry the composer
# preamble resolved, so the crops follow the shed at whatever width the take is
# recorded at.
read -r ROW_H TABS_H CHROME_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

panels = tomllib.loads((Path(sys.argv[1]) / "surface" / "panels.toml").read_text())
print(
    int(panels["diff"]["row_height_px"]),
    int(panels["tabs"]["height_px"]),
    int(panels["chrome"]["row_height_px"]),
)
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
BAND_TOP=$(( PANEL_TOP + TABS_H ))
BAND_H=$(( PANEL_BOTTOM - BAND_TOP ))
# A band no taller than the chrome row cannot hold a sentence and its answer,
# and one this take cannot tell from a diff row is no reading at all.
if [ "${BAND_H}" -lt "$(( 4 * CHROME_H ))" ]; then
	abandon_take "the-panel-holds-a-band" \
		"the panel is ${BAND_H}px tall under its strip, under the $(( 4 * CHROME_H ))px this reads in"
fi

PANEL_GEOM="${PANE_W}x$(( TABS_H + BAND_H ))+${PANEL_LEFT}+${PANEL_TOP}"
echo "scene: the panel reads ${PANEL_GEOM}, its strip ${TABS_H}px and its rows ${BAND_H}px" >&2

# ─── Reading The Bands ───────────────────────────────────────────────────────
# Every element the panel draws under its strip carries a ground of its own:
# the pane's toolbar, a diff row, the host's sentence. The pane's own ground is
# the colour most of the crop below the strip is, so each band is a run of
# pixel rows whose modal colour is not that. A column that never changes down
# the crop is the panel's gap rather than its content, so it is skipped. The
# reading names no colour, and it counts the runs rather than measuring one,
# because the toolbar is a band in both arms and the refusal is a second one
# above it.
#
# Sets RUNS, BAND_PX, BAND_OFFSET and NEXT_PX.
read_band() { # <png>
	local dump="${SCENE_RUNTIME_DIR}/frame-compare/panel-pixels.txt"
	mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
	magick "$1" -crop "${PANEL_GEOM}" +repage txt:- >"${dump}"
	read -r RUNS BAND_PX BAND_OFFSET NEXT_PX < <(
		python3 - "${TABS_H}" "${dump}" <<'PY'
import collections
import re
import sys

tabs_h = int(sys.argv[1])
pixel = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+(#[0-9A-Fa-f]+)")
grid = {}
with open(sys.argv[2], encoding="ascii") as dump:
    for line in dump:
        match = pixel.match(line)
        if not match:
            continue
        grid[(int(match.group(1)), int(match.group(2)))] = match.group(3)

if not grid:
    print("-1 0 0 0")
    raise SystemExit(0)

width = max(x for x, _ in grid) + 1
height = max(y for _, y in grid) + 1
rows_below = range(tabs_h, height)


def modal(pixels):
    counter = collections.Counter(p for p in pixels if p is not None)
    return counter.most_common(1)[0][0] if counter else None


# A column that holds one colour all the way down is the panel's gap or its
# border, not one of its rows.
columns = [
    x
    for x in range(width)
    if len({grid.get((x, y)) for y in rows_below}) > 1
]
if not columns:
    print("0 0 0 0")
    raise SystemExit(0)

pane_ground = modal(grid.get((x, y)) for y in rows_below for x in columns)
rows = {y: modal(grid.get((x, y)) for x in columns) for y in rows_below}

runs = []
start = None
for y in rows_below:
    if rows[y] == pane_ground:
        if start is not None:
            runs.append((start, y - start))
            start = None
        continue
    if start is None:
        start = y
if start is not None:
    runs.append((start, height - start))

first = runs[0] if runs else (tabs_h, 0)
print(len(runs), first[1], first[0] - tabs_h, runs[1][1] if len(runs) > 1 else 0)
PY
	)
}

# ─── The Refusal ─────────────────────────────────────────────────────────────
# The index is made unreadable after the host has already answered for the
# working tree, so the panel holds a state a refusal has to be drawn over.
printf 'this is not a git index' >"${REPO_DIR}/.git/index"
if git -C "${REPO_DIR}" status --porcelain >/dev/null 2>&1; then
	abandon_take "git-refuses-the-tree" \
		"git still reads ${REPO_DIR}, so no arm of this take can photograph a refusal"
fi

echo "scene: git refuses ${REPO_DIR}; opening the panel asks the host for it" >&2

# ─── The Panel Opens On The Request That Is Refused ──────────────────────────
# Opening the panel asks the host for the working tree, and pressing the
# leftmost tab asks again, so the refusal is the answer to a request this take
# sent rather than to one the handshake left behind.
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 1.0

# The panel is drawn when two probes a moment apart agree over it: the answer
# arrives from the host rather than on the key press.
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

shot panel-failure
read_band "${SCENE_OUT}/${SCENE_NAME}-panel-failure.png"
if [ "${RUNS}" -lt 1 ]; then
	abandon_take "panel-failure" "the frame carried no panel to read"
fi

ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	# The toolbar and nothing above it: the refusal reached no drawn element.
	if [ "${RUNS}" != "1" ]; then
		abandon_take "panel-failure" \
			"the panel drew ${RUNS} bands under its strip, so this build is not the one that drew the refusal nowhere"
	fi
	if [ "${BAND_PX}" -gt "$(( CHROME_H + 2 ))" ] || [ "${BAND_OFFSET}" -gt 2 ]; then
		abandon_take "panel-failure" \
			"the one band is ${BAND_PX}px at +${BAND_OFFSET}, which is not the pane's own ${CHROME_H}px toolbar"
	fi
else
	if [ "${RUNS}" != "2" ]; then
		abandon_take "panel-failure" \
			"the panel drew ${RUNS} bands under its strip instead of the refusal and the toolbar"
	fi
	# One row of chrome, so a sentence carried onto a second line or a band as
	# tall as a pane of rows is a failed take rather than a taller notice.
	if [ "${BAND_PX}" -lt "${CHROME_H}" ] || [ "${BAND_PX}" -gt "$(( 2 * CHROME_H ))" ]; then
		abandon_take "panel-failure" \
			"the refusal's band is ${BAND_PX}px, outside the ${CHROME_H}px to $(( 2 * CHROME_H ))px one row of chrome takes"
	fi
	# Drawn under the strip and above the pane, which is what a reader of a
	# refused pane reaches without scrolling.
	if [ "${BAND_OFFSET}" -gt "${ROW_H}" ]; then
		abandon_take "panel-failure" \
			"the refusal's band starts ${BAND_OFFSET}px under the strip, past the ${ROW_H}px a row of chrome sits in"
	fi
	# The toolbar is still drawn, one band lower: the refusal took a row from
	# the pane rather than replacing what the pane had been answered with.
	if [ "${NEXT_PX}" -lt "$(( CHROME_H - 2 ))" ] || [ "${NEXT_PX}" -gt "$(( CHROME_H + 2 ))" ]; then
		abandon_take "panel-failure" \
			"the band under the refusal is ${NEXT_PX}px, not the pane's own ${CHROME_H}px toolbar"
	fi
fi

echo "scene: ${ARM} arm -- the panel holds ${RUNS} bands under its strip; the first is" \
	"${BAND_PX}px at +${BAND_OFFSET} and the one under it ${NEXT_PX}px" >&2
