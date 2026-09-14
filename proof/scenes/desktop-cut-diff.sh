#!/usr/bin/env bash
# Open the Changes pane on a working tree whose diff and file list are both
# past what the view carries, and read back what the pane drew.
#
# Records visual evidence for:
#   1. cut-diff (the panel's Changes pane on a working tree past both budgets)
#
# THE CLAIM. The GUI host built its Changes view from whatever `git diff`
# handed it and from the whole status list. Neither is unbounded and neither
# was stated: the git wrapper caps a captured subprocess at 8 MiB and appends
# a notice line of its own, so a large working tree's diff reached the window
# already cut, in the middle of a hunk whose header claims counts the rows
# beneath it no longer meet -- and the window numbers every row from those
# counts. The view is now budgeted where it is built: 4 MiB of diff cut on the
# last file header that fits, else the last hunk header, else the last line,
# and 2,000 files with the remainder counted rather than dropped. Both cuts
# cross the wire as facts, and the pane states each of them on its own row
# above the first file, which is where a reader of a cut diff is looking.
#
# THE ARMS. One repository seeded past both budgets: twenty tracked files
# rewritten line for line, a 39,878,300-byte diff, and 2,100 untracked files,
# which is past the 2,000 the list carries. Both arms draw the diff and both
# keep their host. Before, the first thing under the pane's toolbar is the
# first file's own header -- one chrome row, nothing above it, so nothing says
# the text was cut. After, two rows stand between the toolbar and that header,
# one per cut. Every reading is measured: the rows as the grounds the pane
# draws them on, the notices as the height they take above the first file, the
# banner as the band under the titlebar against the same column's ground
# lower down, so neither arm rests on reading a label.
#
# The fix is in the host and in the window, so the before arm holds the host
# source at the commit before it and takes a build of the window from the same
# tree:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh proof/scenes/desktop-cut-diff.sh
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/cut-diff.patch cut-diff
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py --after
#   SCENE_ARM=before SCENE_MOTION_FLOOR=3 PROOF_BASE_REF=f3f367f0b2^ \
#     PROOF_NATIVE_BEFORE_BINARY="${PWD}/.internal/captures/cut-diff/veyyon-desktop" \
#     proof/docker/record-native.sh proof/scenes/desktop-cut-diff.sh
#
# Both arms carry a lowered motion floor and both mean it: the take spends a
# stretch of its length waiting on a host reading a 40 MiB diff, which repaints
# nothing, and the recorder's default floor reads that as a stuttering capture.
#
# NOT RECORDED HERE: the refusal itself, which is a frame that was never sent
# and cannot be photographed --
# `packages/coding-agent/test/gui-host/no-view-the-host-builds-outgrows-the-frame-it-crosses-in.test.ts`
# drives it over a real socket -- and the notices' wording, which
# `crates/veyyon-desktop/tests/a-cut-the-host-made-is-stated-in-the-pane-that-draws-it.rs`
# states and `crates/veyyon-desktop-surface/tests/a-cut-the-host-made-is-drawn-above-the-diff-it-cut.rs`
# places.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── A Working Tree Past Both Budgets ────────────────────────────────────────
# Twenty tracked files of a megabyte each, committed and then rewritten line
# for line, so `git diff` carries both sides of every line: forty megabytes of
# text, of which the git wrapper hands the host the first 8 MiB and the host's
# own budget carries 4. Then 2,100 untracked files, which is past the 2,000 the
# file list carries, so the host holds 120 of them back and the pane has two
# cuts to state rather than one.
#
# The ignore file admits the seeded paths by name and nothing else, or the
# sandbox home's own files are changes too and the counts below are not the
# scene's.
REPO_DIR="${SCENE_CWD:-/sandbox/home/demo}"
TRACKED_FILES=20
TRACKED_LINES=14000
FLOOD_FILES=2100
FILE_CAP=2000

seed_hostile_tree() {
	mkdir -p "${REPO_DIR}/flood"
	printf '*\n!.gitignore\n!tracked-*.rs\n!flood/\n!flood/*.txt\n' >"${REPO_DIR}/.gitignore"
	python3 - "${REPO_DIR}" "${TRACKED_FILES}" "${TRACKED_LINES}" "${FLOOD_FILES}" <<'PY'
from pathlib import Path
import sys

root, tracked, lines, flood = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
for index in range(tracked):
    body = "".join(
        f"pub const OLD_{index}_{line}: u64 = {line:010d}; // the line before the change\n"
        for line in range(lines)
    )
    (root / f"tracked-{index}.rs").write_text(body, encoding="ascii")
for index in range(flood):
    (root / "flood" / f"untracked-{index}.txt").write_text("one line\n", encoding="ascii")
PY
	if [ ! -d "${REPO_DIR}/.git" ]; then
		git -C "${REPO_DIR}" init -q
	fi
	git -C "${REPO_DIR}" add -- .gitignore "tracked-*.rs"
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the lines before the change"
	python3 - "${REPO_DIR}" "${TRACKED_FILES}" "${TRACKED_LINES}" <<'PY'
from pathlib import Path
import sys

root, tracked, lines = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
for index in range(tracked):
    body = "".join(
        f"pub const NEW_{index}_{line}: u64 = {line:010d}; // the line after the change\n"
        for line in range(lines)
    )
    (root / f"tracked-{index}.rs").write_text(body, encoding="ascii")
PY
}

seed_hostile_tree

DIFF_BYTES="$(git -C "${REPO_DIR}" diff | wc -c)"
CHANGED_PATHS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | wc -l)"
if [ "${DIFF_BYTES}" -lt $(( 33 * 1024 * 1024 )) ]; then
	abandon_take "the-tree-is-past-the-cap" \
		"the diff is ${DIFF_BYTES} bytes, under the 32 MiB one frame cannot carry"
fi
if [ "${CHANGED_PATHS}" -le "${FILE_CAP}" ]; then
	abandon_take "the-tree-is-past-the-cap" \
		"the repository reports ${CHANGED_PATHS} changed paths, not past the ${FILE_CAP} the list carries"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; the tree holds a ${DIFF_BYTES}-byte diff" \
	"over ${CHANGED_PATHS} changed paths in ${REPO_DIR}" >&2

# ─── Where The Strip, The Strip's Band And The Pane Draw ─────────────────────
# Every rectangle comes from the token files and the panel geometry the composer
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
# The rows begin under the tab strip and under the pane's own toolbar.
ROWS_TOP=$(( PANEL_TOP + TABS_H + CHROME_H ))
ROWS_H=$(( PANEL_BOTTOM - ROW_H - ROWS_TOP ))
# The band a lost host draws its banner in, and the band the same column draws
# its own ground in lower down: a banner is a ground of its own, so the
# reading is whether those two grounds are the same colour, whatever the
# colours are.
STRIP_GEOM="${SESSION_REGION_W}x$(( 2 * ROW_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"
GROUND_GEOM="${SESSION_REGION_W}x$(( 2 * ROW_H ))+${SESSION_REGION_X}+$(( WIN_Y + WIN_H - COMPOSER_BAND_H - 3 * ROW_H ))"

if [ "${ROWS_H}" -lt $(( 6 * ROW_H )) ]; then
	abandon_take "the-pane-holds-the-diff" \
		"the pane is ${ROWS_H}px tall, under the $(( 6 * ROW_H ))px two notices and a hunk need"
fi

echo "scene: the pane reads ${PANE_W}x${ROWS_H} at +${PANEL_LEFT}+${ROWS_TOP}," \
	"the banner band ${STRIP_GEOM}" >&2

# ─── Reading The Pane ────────────────────────────────────────────────────────
# Every row the diff draws carries a ground of its own: an added row, a removed
# row, a file header, a hunk header. The chrome the host's cuts are stated in
# carries none, so it sits on the run of pixel rows the pane's own ground
# reaches down to before the first of those rows begins. The reading is the
# height of that first run and how much of the pane below it is rows, and it
# names no colour: the pane's own ground is whatever the top of the rows
# region is drawn on, and a column that never changes down the whole crop is
# the panel's gap rather than its content.
#
# Sets RUNS, NOTICE_PX and DIFF_PX. A height reads the top of the pane only,
# which is what a poll needs: the notices and the first file are in the first
# hundred pixel rows, and dumping the whole pane every second costs more than
# the wait it is watching.
read_pane() { # <png> [height]
	local height="${2:-${ROWS_H}}"
	local dump="${TMPDIR}/frame-compare/pane-pixels.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${PANE_W}x${height}+${PANEL_LEFT}+${ROWS_TOP}" +repage txt:- >"${dump}"
	read -r RUNS NOTICE_PX DIFF_PX < <(
		python3 - "${dump}" <<'PY'
import collections
import re
import sys

pixel = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+(#[0-9A-Fa-f]+)")
grid = {}
with open(sys.argv[1], encoding="ascii") as dump:
    for line in dump:
        match = pixel.match(line)
        if not match:
            continue
        grid[(int(match.group(1)), int(match.group(2)))] = match.group(3)

if not grid:
    print("-1 -1 -1")
    raise SystemExit(0)

width = max(x for x, _ in grid) + 1
height = max(y for _, y in grid) + 1

content = [
    x
    for x in range(width)
    if len({grid.get((x, y)) for y in range(height)}) > 1
]
left = content[0] if content else 0


def modal(pixels):
    counter = collections.Counter(pixels)
    return counter.most_common(1)[0][0] if counter else None


grounds = [modal(grid.get((x, y)) for x in range(left, width)) for y in range(height)]

runs = []
for ground in grounds:
    if runs and runs[-1][1] == ground:
        runs[-1][0] += 1
    else:
        runs.append([1, ground])

notice_px = runs[0][0]
print(len(runs), notice_px, sum(1 for g in grounds[notice_px:] if g != runs[0][1]))
PY
	)
}

# ─── Reading Whether The Window Still Has Its Host ───────────────────────────
# A window that lost its host draws a banner under the titlebar (§8.12), which
# is a ground of its own across the session column. Read inside one frame
# rather than against an earlier probe of the same band: opening the panel
# takes width from that column, so a probe taken before the panel opened is a
# reading of a different layout and not of the same band.
#
# Sets BANNER, 1 when the band under the titlebar is not the ground the column
# draws lower down.
read_banner() { # <png>
	local band="${TMPDIR}/frame-compare/band.txt"
	local ground="${TMPDIR}/frame-compare/ground.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${STRIP_GEOM}" +repage txt:- >"${band}"
	magick "$1" -crop "${GROUND_GEOM}" +repage txt:- >"${ground}"
	BANNER="$(
		python3 - "${band}" "${ground}" <<'PY'
import collections
import re
import sys

pixel = re.compile(r"^\d+,\d+: \([^)]*\)\s+(#[0-9A-Fa-f]+)")


def modal(path):
    counter = collections.Counter()
    with open(path, encoding="ascii") as dump:
        for line in dump:
            match = pixel.match(line)
            if match:
                counter[match.group(1)] += 1
    return counter.most_common(1)[0][0] if counter else None


band, ground = modal(sys.argv[1]), modal(sys.argv[2])
print(0 if band is None or band == ground else 1, band, ground)
PY
	)"
}

# ─── Opening The Panel Is What Asks For The Working Tree ─────────────────────
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click

# The host reads the whole diff before it answers, and the window draws nothing
# until it does. A pane that has not answered yet is still, so two frames
# agreeing over it is not the answer arriving -- it is the wait being
# photographed. The pane is polled for rows against a deadline instead, and
# only once rows are there is it held to two frames agreeing, which is what
# keeps a half-painted diff out of the frame.
PANE_PROBE_H=120
PANE_DEADLINE_S=90
PANE_GEOM="${PANE_W}x${ROWS_H}+${PANEL_LEFT}+${ROWS_TOP}"
PANE_A="${TMPDIR}/frame-compare/pane-a.png"
PANE_B="${TMPDIR}/frame-compare/pane-b.png"
mkdir -p "${TMPDIR}/frame-compare"
RESOLVED=0
WAITED=0
for _ in $(seq 1 "${PANE_DEADLINE_S}"); do
	pause 1
	WAITED=$(( WAITED + 1 ))
	probe_frame "${PANE_A}"
	read_pane "${PANE_A}" "${PANE_PROBE_H}"
	if [ "${DIFF_PX}" -gt 0 ]; then
		RESOLVED=1
		break
	fi
done
if [ "${RESOLVED}" != "1" ]; then
	abandon_take "cut-diff" \
		"the pane drew no row of the working tree in ${WAITED}s, so nothing was photographed of the answer"
fi

SETTLED=0
for _ in $(seq 1 20); do
	probe_frame "${PANE_A}"
	pause 0.5
	probe_frame "${PANE_B}"
	if [ "$(frames_differ_pixels_at "${PANE_A}" "${PANE_B}" "${PANE_GEOM}")" -lt 40 ] &&
		[ "$(frames_differ_pixels_at "${PANE_A}" "${PANE_B}" "${STRIP_GEOM}")" -lt 40 ]; then
		SETTLED=1
		break
	fi
	pause 0.5
done
if [ "${SETTLED}" != "1" ]; then
	abandon_take "the-pane-is-drawn" "the window never stopped repainting"
fi

shot cut-diff
FRAME="${SCENE_OUT}/${SCENE_NAME}-cut-diff.png"
read_pane "${FRAME}"
if [ "${RUNS}" -lt 0 ]; then
	abandon_take "cut-diff" "the frame carried no pane to read"
fi
read_banner "${FRAME}"
read -r HAS_BANNER BAND_COLOUR GROUND_COLOUR <<<"${BANNER}"

ARM="${SCENE_ARM:-after}"
# Both arms keep their host: what the frame cap protects is a view with no
# budget of its own, which a suite drives over a real socket. If either arm
# lost its connection the pair would be a photograph of that instead.
if [ "${HAS_BANNER}" != "0" ]; then
	abandon_take "cut-diff" \
		"the band under the titlebar is ${BAND_COLOUR} against the column's ${GROUND_COLOUR}, so this window lost its host"
fi
if [ "${DIFF_PX}" -lt $(( 20 * ROW_H )) ]; then
	abandon_take "cut-diff" \
		"the pane drew ${DIFF_PX}px of changed rows, under the $(( 20 * ROW_H ))px a diff of this tree fills"
fi
if [ "${ARM}" = "before" ]; then
	# A pane whose diff was cut with nothing saying so: the first thing under
	# the toolbar is the first file's own header, and a file header is one
	# chrome row.
	if [ "${NOTICE_PX}" -gt $(( CHROME_H + 2 )) ]; then
		abandon_take "cut-diff" \
			"the pane held ${NOTICE_PX}px above the first file's rows, past the ${CHROME_H}px its header takes on its own"
	fi
else
	if [ "${NOTICE_PX}" -lt $(( 2 * ROW_H - 2 )) ] || [ "${NOTICE_PX}" -gt $(( 2 * ROW_H + 2 )) ]; then
		abandon_take "cut-diff" \
			"the rows begin ${NOTICE_PX}px down the pane, not the $(( 2 * ROW_H ))px the two cuts state themselves in"
	fi
fi

echo "scene: ${ARM} arm -- the band under the titlebar is ${BAND_COLOUR} against the column's" \
	"${GROUND_COLOUR}, the pane holds ${RUNS} grounds, ${DIFF_PX}px of changed rows and" \
	"${NOTICE_PX}px of chrome above the first of them" >&2
