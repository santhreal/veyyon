#!/usr/bin/env bash
# Print a line wider than eighty columns into the drawer's terminal and
# photograph how far across the drawer it reaches.
#
# Records visual evidence for:
#   1. grid-open (the drawer the chord opened, before anything was typed)
#   2. wide-line (the same drawer with a 96-column rule printed in it)
#
# THE PAIR IS TWO BINARIES, not two settings. The grid was a constant 80x24 --
# the number was written into the drawer's own default and nothing ever asked
# the window how much room it had -- so a terminal in a 1180px window wrapped
# its output two thirds of the way across and left the rest of the drawer
# blank, and ten of its rows were drawn under the bottom of the window. The
# grid is now counted off the box the frame laid it out in, so it is as wide as
# the drawer and as tall, and output printed at one width is broken again at
# the next.
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-terminal-width.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/terminal-width/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-terminal-width.sh
#
# The take is a still one -- a drawer opens and a command is typed into it --
# which measures under the 12 fps default floor, so both arms record at 5.
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of the commit before it
# (`.internal/build-commit-before.py --tree HEAD~1 terminal-width`, then
# `--after` to put this tree's executable back).
#
# BOTH WIDTHS ARE RECORDED. How wide the grid is, is what changed, so the pair
# is taken at every width the drawer reaches: 1180px, where the queue rail is
# inline and the drawer holds 126 columns, and 800px, where the rail is an
# overlay and it holds 107.
#
#   SCENE_WIDTH=800 SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-terminal-width.sh
#
# WHAT IS MEASURED. A strip of the grid that starts past the eightieth column
# and ends at the end of the rule. Nothing but terminal text draws there. In
# the after arm the rule runs through it, so the strip has to ink; in the
# before arm the grid stops at the eightieth column, so the strip has to stay
# as blank as the frame taken before the command was typed.
#
# BOTH ARMS CARRY A POSITIVE CONTROL: the grid as a whole is measured over the
# same two frames, and both arms have to change by a line of text. The before
# arm's strip is empty because its grid is 80 columns wide, not because the
# pty was never reached.
#
# NOT RECORDED HERE: the re-break itself, which
# `output-is-broken-again-when-the-grid-changes-width` drives over every width
# a grid takes, and the measure reaching the host's pty, which
# `the-terminal-the-window-draws-holds-the-size-the-window-measured` pins on
# the production path.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── The Box The Grid Is Drawn In ────────────────────────────────────────────
# Every number comes out of the token files this checkout ships: the drawer's
# height and its chrome row, the padding the grid sits inside, and the cell the
# drawer counts columns in.
read -r DRAWER_H GRIP_PX CHROME_H S2 S3 CELL_W_TENTHS MIN_COLS < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" "${WIN_W}" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
width = float(sys.argv[2])
panels = tomllib.loads((tokens / "surface" / "panels.toml").read_text())
scale = tomllib.loads((tokens / "scale.toml").read_text())["spacing"]
rows = sorted(
    tomllib.loads((tokens / "surface" / "breakpoints.toml").read_text())["breakpoint"].values(),
    key=lambda row: row["min_width_px"],
)
row = rows[0]
for candidate in rows:
    if width >= candidate["min_width_px"]:
        row = candidate
drawer = panels["terminal_drawer"]
print(
    int(row["terminal_drawer_height_px"]),
    int(panels["chrome"]["resize_handle_hit_px"]),
    int(panels["chrome"]["row_height_px"]),
    int(scale["s2"]),
    int(scale["s3"]),
    # A cell is 7.2px and this scene's arithmetic is integer, so the width
    # travels in tenths: a column boundary worked out from a cell rounded
    # down lands two columns early by the eightieth, which is inside the text
    # the old grid drew.
    round(drawer["cell_width_px"] * 10),
    int(drawer["min_columns"]),
)
PY
)
if [ -z "${MIN_COLS:-}" ]; then
	abandon_take "the-grid-is-locatable" "no drawer geometry resolved for a ${WIN_W}px window"
fi
if [ "${DRAWER_PLACEMENT}" != "row" ]; then
	abandon_take "the-drawer-is-a-row" \
		"the drawer draws as a ${DRAWER_PLACEMENT} at ${WIN_W}px, and this scene aims at the row it takes"
fi

# The drawer is the bottom of the session column, under the split's grip; its
# chrome row is first inside it and the grid is what follows, inset by its own
# padding.
DRAWER_TOP=$(( WIN_Y + WIN_H - DRAWER_H + GRIP_PX ))
GRID_X=$(( SESSION_REGION_X + S3 ))
GRID_W=$(( SESSION_REGION_W - 2 * S3 ))
GRID_TOP=$(( DRAWER_TOP + CHROME_H + S2 ))
GRID_H=$(( WIN_Y + WIN_H - S2 - GRID_TOP ))

# The rule printed below is 96 columns, and the strip measured is what of it
# lies past the eightieth column the old grid stopped at: from the start of
# the eighty-third column to the end of the ninety-fifth.
RULE_COLS=96
STRIP_X=$(( GRID_X + (MIN_COLS + 2) * CELL_W_TENTHS / 10 ))
STRIP_W=$(( GRID_X + (RULE_COLS - 1) * CELL_W_TENTHS / 10 - STRIP_X ))
STRIP_CROP="${STRIP_W}x${GRID_H}+${STRIP_X}+${GRID_TOP}"
GRID_CROP="${GRID_W}x${GRID_H}+${GRID_X}+${GRID_TOP}"

if (( STRIP_W < 60 )); then
	abandon_take "the-strip-is-measurable" \
		"a ${WIN_W}px window leaves ${STRIP_W}px between the eightieth column and the end of the rule, too little to read"
fi
if (( RULE_COLS * CELL_W_TENTHS / 10 > GRID_W )); then
	abandon_take "the-rule-fits" \
		"a ${RULE_COLS}-column rule does not fit the ${GRID_W}px grid of a ${WIN_W}px window, so both arms would clip it"
fi
if (( GRID_H < 3 * 16 )); then
	abandon_take "the-grid-is-drawn" "the drawer leaves ${GRID_H}px for its grid, under three rows"
fi

grid_region() {
	use_crop "${GRID_X}" "${GRID_TOP}" "${GRID_W}" "${GRID_H}"
}

# ─── The Drawer Its Own Chord Opens ──────────────────────────────────────────
AT_REST="${SCENE_RUNTIME_DIR}/frame-compare/grid-at-rest.png"
mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
probe_frame "${AT_REST}"

k "ctrl+j"
settle 4
grid_region
shot grid-open
OPENED="$(screen_differs_from_frame_pixels_at "${AT_REST}" "${GRID_CROP}")"
if [ "${OPENED}" -lt 2000 ]; then
	abandon_take "the-drawer-answered-its-chord" \
		"the drawer's own band changed ${OPENED} pixels on primary-j, so no terminal was drawn in it"
fi

# ─── A Rule Wider Than The Old Grid ──────────────────────────────────────────
# Typed into the grid itself: the pointer takes its focus, the keystrokes reach
# the host's pty, and what comes back is what the emulator lays out.
move_px "$(( GRID_X + GRID_W / 2 ))" "$(( GRID_TOP + GRID_H / 2 ))"
click
pause 0.4

BLANK="${SCENE_RUNTIME_DIR}/frame-compare/grid-blank.png"
probe_frame "${BLANK}"

RULE="$(python3 -c "import sys; sys.stdout.write('=' * ${RULE_COLS})")"
if [ "${#RULE}" -ne "${RULE_COLS}" ]; then
	abandon_take "the-rule-is-the-width-it-claims" \
		"the rule came out ${#RULE} characters rather than ${RULE_COLS}"
fi
t "echo ${RULE}"
pause 1.2
k "Return"
settle 3
shot wide-line

PRINTED="$(screen_differs_from_frame_pixels_at "${BLANK}" "${GRID_CROP}")"
REACHED="$(screen_differs_from_frame_pixels_at "${BLANK}" "${STRIP_CROP}")"
echo "scene: the grid changed ${PRINTED}px, and ${REACHED}px of that lies past column ${MIN_COLS}" >&2

# The positive control, read in both arms: a command typed and answered inks a
# line of text wherever the grid is wide enough to hold it.
if [ "${PRINTED}" -lt 800 ]; then
	abandon_take "the-pty-answered-the-command" \
		"the grid changed ${PRINTED} pixels after a command and a Return, so the keystrokes never reached the pty"
fi

if [ "${ARM}" = "before" ]; then
	if [ "${REACHED}" -gt 40 ]; then
		abandon_take "the-before-arm-is-the-old-grid" \
			"${REACHED} pixels of the rule reached past column ${MIN_COLS} in the before arm, so this binary already measures its grid and the arms are the same window"
	fi
else
	if [ "${REACHED}" -lt 400 ]; then
		abandon_take "the-rule-reached-the-width-of-the-drawer" \
			"only ${REACHED} pixels of the rule lie past column ${MIN_COLS}, so the grid is still wrapping at the old floor"
	fi
fi
