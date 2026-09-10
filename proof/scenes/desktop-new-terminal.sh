#!/usr/bin/env bash
# Open the drawer, close the terminal it opened with, and ask the drawer for
# another one from the chrome it draws.
#
# Records visual evidence for:
#   1. terminal-open (the drawer as its opening left it, one terminal in it)
#   2. terminal-closed (the same drawer a press of `Close` later)
#   3. after-press (the same drawer a press of its trailing control later)
#   4. reopened (the drawer closed and opened again, which is the old route)
#
# THE PAIR IS TWO BINARIES, not two settings. The window turned the drawer's
# own opening into an attach of the running terminal, or a create when there
# was none, and it ran that once: closing the last terminal left the drawer
# standing open with no route to another -- the process list and its `Start`
# where the host supervises processes, an empty strip captioned `Terminal`
# where it does not -- and the way back to a terminal was closing the drawer
# and opening it again.
# Both arms run this same scene; the window is the differential.
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-new-terminal.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/new-terminal/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-new-terminal.sh
#
# The take is a still one: a grid appears, a grid goes away, and a grid comes
# back, which measures under the 12 fps default floor, so both arms record at
# 5.
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of this tree with the fix taken out of it instead
# (`.internal/build-commit-before.py --holdback
# .internal/before-edits/new-terminal.patch new-terminal`, then `--after` to
# put this tree's executable back).
#
# WHAT IS MEASURED. The drawer's own band, at the two presses. Closing the
# terminal has to take it away in both arms, which is the state the arms are
# compared in. The press that follows lands on the same point in both, one
# control in from the trailing edge: in the after arm that point is the `New`
# the chrome draws, and the drawer has to gain a terminal there; in the before
# arm nothing is drawn there, and the band has to be unchanged.
#
# THE AIM IS DERIVED, not guessed: the drawer is the bottom of the session
# column at the authored height, its chrome row is first inside it, and the
# trailing control is the last child of that row, one step and a half in from
# the row's own padding. Every number below comes out of the token files this
# checkout ships.
#
# THE BEFORE ARM CARRIES A POSITIVE CONTROL: after the press that does
# nothing, the drawer is closed and opened again, which is the route that
# existed, and the terminal comes back. The nothing the arm records belongs to
# the chrome rather than to a host that had stopped opening terminals.
#
# NOT RECORDED HERE: which host action the press raises, which tab draws the
# control and which withholds it, which
# `a-drawer-can-open-a-terminal-it-does-not-have` pins as the whole chrome row
# of every tab the drawer can show, and a capability the host does not offer.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where The Drawer Draws Its Chrome ───────────────────────────────────────
read -r DRAWER_H GRIP_PX CHROME_H S2 S3 S6 < <(
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
print(
    int(row["terminal_drawer_height_px"]),
    int(panels["chrome"]["resize_handle_hit_px"]),
    int(panels["chrome"]["row_height_px"]),
    int(scale["s2"]),
    int(scale["s3"]),
    int(scale["s6"]),
)
PY
)
if [ -z "${CHROME_H:-}" ]; then
	abandon_take "the-drawer-is-locatable" "no drawer geometry resolved for a ${WIN_W}px window"
fi
if [ "${DRAWER_PLACEMENT}" != "row" ]; then
	abandon_take "the-drawer-is-a-row" \
		"the drawer draws as a ${DRAWER_PLACEMENT} at ${WIN_W}px, and this scene aims at the row it takes"
fi

# The drawer's own content starts under the split's grip, and its chrome row is
# the first thing inside it.
DRAWER_TOP=$(( WIN_Y + WIN_H - DRAWER_H + GRIP_PX ))
CHROME_MID_Y=$(( DRAWER_TOP + CHROME_H / 2 ))
# The chrome row's last trailing child, which is `Close` while a terminal is
# drawn and the supervisor's `Start` once it is not.
TRAILING_X=$(( WIN_X + WIN_W - S3 - 24 ))
# The control before it. A medium ghost control is its label between one S6
# inset either side, and the row gaps its children by S2, so `New` sits one
# `Start` in from the trailing edge. `Start` measures 29px of label at the
# body ramp in this checkout's font.
NEW_X=$(( TRAILING_X - 29 - 2 * S6 - S2 ))
# The strip's first tab, which is the drawer's leading child: the session
# column's left edge, the chrome's S3 inset, and 20px into the label itself.
TAB_X=$(( SESSION_REGION_X + S3 + 20 ))
if (( CHROME_MID_Y <= WIN_Y || CHROME_MID_Y >= WIN_Y + WIN_H )); then
	abandon_take "the-chrome-is-locatable" \
		"the derived aim (${TRAILING_X},${CHROME_MID_Y}) does not sit inside a ${WIN_W}x${WIN_H} window"
fi

drawer_region() {
	use_crop "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))"
}

# ─── The Terminal The Drawer Opens With ──────────────────────────────────────
# Opening the drawer creates a terminal and leaves the process list active, so
# the scene selects the terminal's own tab, which is the first in the strip.
k "ctrl+j"
settle 3
drawer_region
move_px "${TAB_X}" "${CHROME_MID_Y}"
pause 0.3
click
settle 3
shot terminal-open

# ─── The Close Beside It, Which Takes The Terminal Away ──────────────────────
echo "scene: pressing the chrome's trailing control at ${TRAILING_X},${CHROME_MID_Y}" >&2
move_px "${TRAILING_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot terminal-closed
CLOSED="$(shots_differ_pixels terminal-open terminal-closed)"
if [ "${CLOSED}" -lt 500 ]; then
	abandon_take "the-terminal-closed" \
		"the drawer changed ${CLOSED} pixels on the press of Close, so this take never reached the strip with no terminal in it that both arms are compared in"
fi

# ─── The Control Before It, Pressed In Both Arms ─────────────────────────────
# In the after arm the chrome draws `New` there. In the before arm the strip's
# trailing side carries the supervisor's `Start` alone, and the press lands on
# the chrome itself, one control in from it.
#
# The aim is taken up before the shot both arms are compared in: a pointer
# arriving on a control paints about 1,500px of hover fill and a pointer
# leaving one takes it away, and that is not what either arm is measuring.
echo "scene: pressing where the strip offers a terminal at ${NEW_X},${CHROME_MID_Y}" >&2
move_px "${NEW_X}" "${CHROME_MID_Y}"
pause 0.6
shot aim-taken
click
settle 4
shot after-press
PRESSED="$(shots_differ_pixels aim-taken after-press)"

# ─── The Tab The Press Left In The Strip ─────────────────────────────────────
# The first tab again: in the after arm that is the terminal the press opened,
# and in the before arm the strip holds only the process list, so the same
# click selects the tab that is already selected.
move_px "${TAB_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot terminal-back
BACK="$(shots_differ_pixels after-press terminal-back)"

# ─── The Route That Existed, Which Both Arms Still Have ──────────────────────
# Closing and opening the drawer attaches a terminal or creates one, and the
# strip's first tab draws it. Both arms reach a terminal grid this way, which
# is what makes the before arm's nothing the chrome's and not the host's.
k "ctrl+j"
pause 1.5
k "ctrl+j"
settle 4
shot reopened
move_px "${TAB_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot reopened-terminal
REOPENED="$(shots_differ_pixels terminal-closed reopened-terminal)"

echo "scene: ${CLOSED}px on the close, ${PRESSED}px on the press, ${BACK}px on the first tab after it, ${REOPENED}px on the terminal the drawer's own opening leaves" >&2

# A terminal grid replacing the supervisor's body is thousands of pixels, and
# both arms must reach one this way.
if [ "${REOPENED}" -lt 3000 ]; then
	abandon_take "the-drawer-still-opens-a-terminal" \
		"the terminal the drawer's own opening leaves drew ${REOPENED} pixels over the strip with none, so this take cannot say the host was still opening terminals when the press landed"
fi

if [ "${ARM}" = "before" ]; then
	if [ "${PRESSED}" -gt 40 ]; then
		abandon_take "the-press-changed-nothing" \
			"the drawer changed ${PRESSED} pixels on the press, so this arm is not the before one"
	fi
	if [ "${BACK}" -gt 500 ]; then
		abandon_take "the-strip-gained-no-tab" \
			"the strip's first tab drew ${BACK} pixels after the press, so this arm is not the before one"
	fi
	echo "scene: before arm -- the strip with no terminal in it offered nothing to press there, the press changed ${PRESSED} pixels and left the strip's first tab the process list (${BACK}px), while the drawer's own opening still reached a terminal (${REOPENED}px)" >&2
else
	if [ "${PRESSED}" -lt 500 ]; then
		abandon_take "the-strip-answered-the-press" \
			"the drawer changed ${PRESSED} pixels on the press of New, so the strip did not gain the terminal it had none of"
	fi
	if [ "${BACK}" -lt 3000 ]; then
		abandon_take "the-press-opened-a-terminal" \
			"the strip's first tab drew ${BACK} pixels after the press, so the press did not put a terminal back in a strip that had none"
	fi
	echo "scene: after arm -- the press of New put a terminal back into a strip that had none (${PRESSED}px on the press, ${BACK}px on the terminal it drew)" >&2
fi
