#!/usr/bin/env bash
# Open the Changes tab on a hunk that replaces four consecutive lines, in the
# native GPUI window, and measure the word-level highlight each changed line
# carries.
#
# Records visual evidence for:
#   1. changed-lines (the hunk drawn in the Changes tab, both blocks in frame)
#
# THE CLAIM. Every changed line highlights the words that differ from the line
# it replaced. A hunk that changes one line is the shape a reader of the parser
# has in mind and the shape every earlier take recorded; a hunk that changes
# four consecutive lines is the shape an operator reads, and it is where the
# added side's pairing was wrong. So the frame carries four replaced lines, one
# token changed on each, and the take reads the highlight on every one of them
# rather than on the first.
#
# THE ARMS. Before, the added side recovered its counterpart by counting
# backwards through the rows already pushed, which resolves to the removed row
# at twice the offset: the first line of a block paired correctly, the second
# highlighted against the third -- drawing its unchanged name as changed -- and
# the rows past the block's halfway point found an added row where a removed
# one was expected and drew no highlight at all. After, both halves of a pair
# come from one alignment of that pair. The removed column is the control: it
# read its counterpart out of the buffer in both arms, so four highlighted
# removed rows state that this build draws intraline highlights at all, and an
# added row with none is a missing highlight rather than a missing feature.
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build with the change removed:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh proof/scenes/desktop-diff-intraline.sh
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-diff-intraline.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── The Change The Pane Draws ───────────────────────────────────────────────
# The rows come from `git diff` in the session's own directory, which is what
# the host runs for the Changes tab: nothing here seeds a diff into the window.
# The repository tracks one file and ignores everything else in the sandbox
# home, so the tab lists one file and the take is not reading a hunk of some
# other file's rows.
#
# FOUR LINES, ONE TOKEN EACH. Every line of the block changes, so git emits one
# replace group -- four removed rows then four added rows -- and every pair
# differs in exactly one token. A pair that differed in two would make the
# correct highlight as wide as the wrong one.
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
	# The ignore file is committed with the source, or the sandbox home's own
	# ignore file is a second changed file and the tab draws two hunks where
	# this take reads one.
	git -C "${REPO_DIR}" add -- "${FILE_NAME}" .gitignore
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the lines before the change" -- "${FILE_NAME}" .gitignore
	printf 'fn totals() {\nlet alpha = 11;\nlet bravo = 22;\nlet carol = 33;\nlet delta = 44;\n}\n' >"${file}"
}

seed_changed_file

# The hunk the host will send, read back before the window is asked for it: a
# diff that grouped its rows some other way would be measured as a block that
# is the wrong height, and this says so here instead of in a pixel count.
DIFF_SHAPE="$(
	git -C "${REPO_DIR}" diff -- "${FILE_NAME}" | python3 -c '
import sys

removed = added = 0
for line in sys.stdin:
    if line.startswith("+++") or line.startswith("---"):
        continue
    if line.startswith("-"):
        removed += 1
    elif line.startswith("+"):
        added += 1
print(removed, added)
'
)"
if [ "${DIFF_SHAPE}" != "${CHANGED_LINES} ${CHANGED_LINES}" ]; then
	abandon_take "the-hunk-is-a-block" \
		"git emitted '${DIFF_SHAPE}' removed/added rows instead of ${CHANGED_LINES}/${CHANGED_LINES}"
fi

# The tab draws every changed file the host reports, and the take measures the
# blocks it finds in the pane. One changed file is what makes those blocks this
# file's, so a sandbox home that arrives with a change of its own is said here
# rather than measured as a hunk of the wrong height.
CHANGED_PATHS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | wc -l)"
if [ "${CHANGED_PATHS}" != "1" ]; then
	abandon_take "the-hunk-is-a-block" \
		"the repository holds ${CHANGED_PATHS} changed paths instead of ${FILE_NAME} alone"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; the hunk is ${DIFF_SHAPE} rows in ${REPO_DIR}" >&2
# ─── Where The Pane Draws ────────────────────────────────────────────────────
# The pane's rectangle comes from the token files and the panel geometry the
# composer preamble resolved, so the crop follows the shed at whatever width
# the take is recorded at. Nothing below counts rows from the top of the pane:
# the bands are found in the frame, because a row of chrome added above them
# would silently shift a counted offset onto the wrong rows.
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
# The rows sit under the tab strip, the diff toolbar and the file's own header.
# The search starts at the tab strip rather than at the first row, so a band
# that begins higher than the layout says is found and reported rather than cut
# in half by the crop.
ROWS_TOP=$(( PANEL_TOP + TABS_H ))
ROWS_BOTTOM=$(( PANEL_BOTTOM - ROW_H ))
ROWS_H=$(( ROWS_BOTTOM - ROWS_TOP ))
PANE_W=$(( PANEL_RIGHT - PANEL_LEFT ))
# Both blocks, the hunk header between them and the chrome above them have to
# be inside the pane, or a block is cut and its height fails the read below.
if [ "${ROWS_H}" -lt "$(( 2 * CHROME_H + (2 * CHANGED_LINES + 4) * ROW_H ))" ]; then
	abandon_take "the-pane-holds-the-hunk" \
		"the pane is ${ROWS_H}px tall, under the $(( 2 * CHROME_H + (2 * CHANGED_LINES + 4) * ROW_H ))px this hunk needs"
fi

echo "scene: the pane reads ${PANE_W}x${ROWS_H} at +${PANEL_LEFT}+${ROWS_TOP}, rows ${ROW_H}px" >&2
# ─── Reading A Highlight Out Of The Frame ────────────────────────────────────
# A changed row draws its tint as the row's ground and the same tint at a
# higher alpha behind the words that differ (`panels.toml`, `added_removed_alpha`
# against `intraline_alpha`), so a highlighted column of pixels holds no ground
# colour anywhere down the row. A glyph that reaches the row's full height
# leaves no ground pixel in its column either, so every row reads a handful of
# columns whatever it highlights; the reader states that floor as well, taken
# on the unchanged context row above the block, and each reading below is the
# columns above it. It needs no colour named here: the ground is whatever
# colour the row is mostly made of, and the two blocks are found as the two
# runs of pixel rows whose ground is not the pane's.
#
# Sets ROW_READING to `noise:0:<floor>` and one `kind:index:columns` triple per
# changed row.
# The dump goes through a file rather than a pipe: `python3 -` takes its own
# script on stdin, so a crop piped into it is read by nothing and the reader
# it never had leaves magick writing into a closed pipe.
read_highlights() { # <png>
	local dump="${SCENE_RUNTIME_DIR}/frame-compare/pane-pixels.txt"
	magick "$1" -crop "${PANE_W}x${ROWS_H}+${PANEL_LEFT}+${ROWS_TOP}" +repage txt:- >"${dump}"
	ROW_READING="$(
		python3 - "${ROW_H}" "${CHANGED_LINES}" "${dump}" <<'PY'
import collections
import re
import sys

row_h, changed = int(sys.argv[1]), int(sys.argv[2])
pixel = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+(#[0-9A-Fa-f]+)")
rows = collections.defaultdict(collections.Counter)
grid = {}
with open(sys.argv[3], encoding="ascii") as dump:
    for line in dump:
        match = pixel.match(line)
        if not match:
            continue
        x, y, colour = int(match.group(1)), int(match.group(2)), match.group(3)
        rows[y][colour] += 1
        grid[(x, y)] = colour

if not grid:
    print("no-pixels")
    raise SystemExit(0)

height = max(y for _, y in grid) + 1
width = max(x for x, _ in grid) + 1
ground = collections.Counter(colour for colour in grid.values()).most_common(1)[0][0]
modal = {y: rows[y].most_common(1)[0][0] for y in range(height) if rows[y]}

# The blocks: runs of pixel rows whose ground is one colour that is not the
# pane's. A run shorter than a block is chrome -- a hunk header, a tab strip --
# and is left where it is.
bands, start = [], None
for y in range(height + 1):
    colour = modal.get(y)
    if start is None:
        if colour is not None and colour != ground:
            start = (y, colour)
        continue
    if colour != start[1]:
        if y - start[0] >= (changed - 1) * row_h:
            bands.append((start[0], y, start[1]))
        start = (y, colour) if colour is not None and colour != ground else None

if len(bands) != 2:
    print(f"bands={len(bands)}")
    raise SystemExit(0)

readings = []


def clear_columns(fill, first, last):
    """Columns holding no `fill` pixel anywhere between rows `first` and `last`."""
    return sum(
        1 for x in range(width) if all(grid.get((x, y)) != fill for y in range(first, last))
    )


# The floor, read on the context row above the block: an unchanged row draws no
# highlight, so whatever it reads is what a glyph alone contributes.
noise_top = max(0, bands[0][0] - row_h)
noise_fill = modal.get(noise_top + row_h // 2)
noise = clear_columns(noise_fill, noise_top, bands[0][0]) if noise_fill else 0
readings.append(f"noise:0:{noise}")

# The removed block is drawn above the added one in a unified hunk.
for kind, (top, bottom, fill) in zip(("removed", "added"), bands):
    if not (changed * row_h - 4) <= bottom - top <= (changed * row_h + 4):
        print(f"band-height={bottom - top}")
        raise SystemExit(0)
    for index in range(changed):
        first = top + index * row_h
        last = min(first + row_h, bottom)
        readings.append(f"{kind}:{index}:{clear_columns(fill, first, last)}")
print(" ".join(readings))
PY
	)"
}

# The width one token of this mono column inks, and the width a whole word plus
# a token inks. Both are read out of the frame rather than stated: a token is
# the narrowest highlight the removed column draws, since every removed row
# lost exactly one token, and a highlight several times that wide is a row
# highlighted against a line it did not replace.
highlight_of() { # <kind> <index>
	local want="$1:$2:"
	local reading
	for reading in ${ROW_READING}; do
		case "${reading}" in
			"${want}"*) echo "${reading##*:}"; return 0 ;;
		esac
	done
	echo "-1"
}

# ─── The Changes Tab Opens On The Hunk ───────────────────────────────────────
# Opening the panel is what asks the host for the working tree's changes, and
# the Changes tab is the leftmost one the host offers. The take clicks it
# rather than trusting the tab the window opens on: which tab that is comes
# out of what the window was last left in, and a take that read a file view
# would abandon on a pane of rows that are not a hunk.
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 0.8

# The pane is drawn when two probes a moment apart are the same over it: the
# rows arrive on a host answer rather than on the key press, and a frame taken
# between the two shows the tab's empty state.
mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
PANE_GEOM="${PANE_W}x${ROWS_H}+${PANEL_LEFT}+${ROWS_TOP}"
PANE_A="${SCENE_RUNTIME_DIR}/frame-compare/pane-a.png"
PANE_B="${SCENE_RUNTIME_DIR}/frame-compare/pane-b.png"
SETTLED=0
for _ in $(seq 1 30); do
	probe_frame "${PANE_A}"
	pause 0.5
	probe_frame "${PANE_B}"
	if [ "$(frames_differ_pixels_at "${PANE_A}" "${PANE_B}" "${PANE_GEOM}")" -lt 40 ]; then
		read_highlights "${PANE_B}"
		case "${ROW_READING}" in
			noise:*) SETTLED=1; break ;;
		esac
	fi
	pause 0.5
done
if [ "${SETTLED}" != "1" ]; then
	abandon_take "the-hunk-is-drawn" \
		"the Changes tab never settled on two blocks of ${CHANGED_LINES} rows (last read: ${ROW_READING:-none})"
fi

shot changed-lines
read_highlights "${SCENE_OUT}/${SCENE_NAME}-changed-lines.png"
case "${ROW_READING}" in
	noise:*) ;;
	*) abandon_take "changed-lines" "the frame read as '${ROW_READING}' instead of two blocks of rows" ;;
esac

# ─── The Control: The Removed Column Highlights Every Row ────────────────────
# Read first, and in both arms. Every reading is the columns a row draws above
# the floor the context row set, so a row that highlights nothing reads zero
# whatever its glyphs are. Every removed row lost one character, so each one
# owes a highlight, and the narrowest of them is what one character of this
# column inks -- the unit every reading below is stated in.
NOISE="$(highlight_of noise 0)"
if [ "${NOISE}" -lt 0 ]; then
	abandon_take "changed-lines" "the frame stated no floor to read the highlights against"
fi
TOKEN_PX=0
for index in $(seq 0 $(( CHANGED_LINES - 1 ))); do
	COLUMNS=$(( $(highlight_of removed "${index}") - NOISE ))
	if [ "${COLUMNS}" -lt 3 ]; then
		abandon_take "changed-lines" \
			"removed row ${index} carries ${COLUMNS} columns of highlight, so this build draws none at all"
	fi
	if [ "${TOKEN_PX}" = "0" ] || [ "${COLUMNS}" -lt "${TOKEN_PX}" ]; then
		TOKEN_PX="${COLUMNS}"
	fi
done
# Each added line introduced two characters where its removed line had one, so
# a correct highlight is about two of those units wide. Four is the bar: twice
# what the change is, and well under the whole name and number the wrong
# pairing drew.
WORD_PX=$(( TOKEN_PX * 4 ))

ARM="${SCENE_ARM:-after}"
ADDED_HIGHLIGHTED=0
ADDED_BLANK=0
ADDED_OVERWIDE=0
ADDED_READING=""
for index in $(seq 0 $(( CHANGED_LINES - 1 ))); do
	COLUMNS=$(( $(highlight_of added "${index}") - NOISE ))
	ADDED_READING="${ADDED_READING}${ADDED_READING:+, }row ${index}: ${COLUMNS}px"
	if [ "${COLUMNS}" -lt 3 ]; then
		ADDED_BLANK=$(( ADDED_BLANK + 1 ))
	else
		ADDED_HIGHLIGHTED=$(( ADDED_HIGHLIGHTED + 1 ))
	fi
	if [ "${COLUMNS}" -ge "${WORD_PX}" ]; then
		ADDED_OVERWIDE=$(( ADDED_OVERWIDE + 1 ))
	fi
done

if [ "${ARM}" = "before" ]; then
	# The two failures the pairing produced, in one frame: a row highlighted
	# against a line it did not replace, and rows past the halfway point with
	# no highlight at all.
	if [ "${ADDED_OVERWIDE}" -lt 1 ]; then
		abandon_take "changed-lines" \
			"no added row was highlighted past ${WORD_PX}px, so this build is not the one that mispaired (${ADDED_READING})"
	fi
	if [ "${ADDED_BLANK}" -lt 2 ]; then
		abandon_take "changed-lines" \
			"only ${ADDED_BLANK} added rows lost their highlight, where the pairing left two of ${CHANGED_LINES} (${ADDED_READING})"
	fi
else
	if [ "${ADDED_HIGHLIGHTED}" != "${CHANGED_LINES}" ]; then
		abandon_take "changed-lines" \
			"${ADDED_HIGHLIGHTED} of ${CHANGED_LINES} added rows carry a highlight (${ADDED_READING})"
	fi
	if [ "${ADDED_OVERWIDE}" != "0" ]; then
		abandon_take "changed-lines" \
			"an added row is highlighted past ${WORD_PX}px, which is wider than the token it introduced (${ADDED_READING})"
	fi
fi

echo "scene: ${ARM} arm -- one token of this column inks ${TOKEN_PX}px; of ${CHANGED_LINES} added rows," \
	"${ADDED_HIGHLIGHTED} carry a highlight, ${ADDED_BLANK} carry none and ${ADDED_OVERWIDE} run past" \
	"${WORD_PX}px (${ADDED_READING}); the removed column highlighted all ${CHANGED_LINES} of its rows" >&2
