#!/usr/bin/env bash
# Open the drawer with its chord and photograph the tab it draws.
#
# Records visual evidence for:
#   1. drawer-open (the drawer as its own opening leaves it)
#   2. aim-taken (the same drawer with the pointer resting on the second tab)
#   3. supervisor-shown (that tab pressed)
#   4. terminal-shown (the strip's first tab pressed)
#
# THE PAIR IS TWO BINARIES, not two settings. Opening the drawer asks the host
# for a terminal -- it attaches the newest running one and creates one where
# there is none -- and the answer arrives a round trip later. The projection
# carried the tab the drawer held until then as though something had chosen
# it, and on a host that supervises processes that tab is the process list, so
# the drawer created a terminal and drew the supervisor over it.
# Both arms run this same scene; the window is the differential.
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-drawer-opens-terminal.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/drawer-tab/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-drawer-opens-terminal.sh
#
# The take is a still one -- a drawer opens and two tabs are pressed -- which
# measures under the 12 fps default floor, so both arms record at 5.
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of this tree with the fix taken out of it instead
# (`.internal/build-commit-before.py --holdback
# .internal/before-edits/drawer-tab.patch drawer-tab`, then `--after` to put
# this tree's executable back).
#
# WHAT IS MEASURED. The drawer's own band, at the press of the second tab. In
# the after arm the drawer opened on the terminal, so pressing the supervisor's
# tab replaces a grid with the process list and the band has to change. In the
# before arm the supervisor is already drawn, so the same press lands on the
# tab that is already selected and the band has to be unchanged.
#
# THE AIM IS DERIVED, not guessed: the drawer is the bottom of the session
# column at the authored height, its chrome row is first inside it, and the
# tabs are its leading children. Every number below but one comes out of the
# token files this checkout ships; the exception is the 47px `/bin/sh` label
# that sets the offset between the two tabs.
#
# BOTH ARMS CARRY A POSITIVE CONTROL: the host is asked what it supervises,
# and answers with an empty list, so the supervisor's tab is a tab both arms
# have; and the strip's first tab is pressed at the end, which draws the
# terminal in both arms, so the before arm's supervisor is a terminal the
# drawer opened and drew over rather than a terminal it never opened.
#
# NOT RECORDED HERE: what a chosen tab does across the terminals the host
# opens afterwards, which
# `a-drawer-opens-on-the-terminal-it-asked-the-host-for` pins over every tab
# the drawer can show.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where The Drawer Draws Its Chrome ───────────────────────────────────────
read -r DRAWER_H GRIP_PX CHROME_H S2 S3 < <(
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
# The tab strip's leading child, past the chrome row's padding and the tab's
# own, onto the word the tab draws.
TAB_X=$(( WIN_X + RAIL_W + S3 + S2 + 20 ))
# The tab beside it, one `/bin/sh` label along.
PROCESSES_TAB_X=$(( TAB_X + 47 ))
if (( CHROME_MID_Y <= WIN_Y || CHROME_MID_Y >= WIN_Y + WIN_H )); then
	abandon_take "the-chrome-is-locatable" \
		"the derived aim (${TAB_X},${CHROME_MID_Y}) does not sit inside a ${WIN_W}x${WIN_H} window"
fi

drawer_region() {
	use_crop "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))"
}

# ─── What The Host Supervises ────────────────────────────────────────────────
# Asked over the socket the window is attached to, in the host's own
# vocabulary. An empty list is the reading this scene needs: the supervisor's
# tab is offered on the capability, so both arms have the tab the press aims at
# and neither has a process drawn in it.
host_processes() { # <seconds> -> "count=<n> names=<a,b>"
python3 - "$1" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
deadline = time.monotonic() + float(sys.argv[1])
last = "count=unreadable names="

while True:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5.0)
            connection.connect(str(endpoint))
            connection.sendall(b'{"id":1,"action":"RefreshProcesses"}\n')
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Processes" not in snapshot:
                        continue
                    # `Processes` carries the list itself, not the versioned
                    # pair `Sessions` carries.
                    rows = snapshot["Processes"]
                    names = ",".join(str(row.get("name", "")) for row in rows)
                    print(f"count={len(rows)} names={names}")
                    raise SystemExit(0)
    except (OSError, ValueError, RuntimeError) as error:
        last = f"count=unreadable names= ({error})"
    if time.monotonic() >= deadline:
        print(last)
        raise SystemExit(0)
    time.sleep(0.2)
PY
}

SUPERVISED="$(host_processes 10)"
case "${SUPERVISED}" in
	"count=0 "*) ;;
	*)
		abandon_take "the-supervisor-answers-and-runs-nothing" \
			"the host says ${SUPERVISED}, so this take cannot say which tab the drawer opened on"
		;;
esac

# ─── The Drawer Its Own Chord Opens ──────────────────────────────────────────
AT_REST="${TMPDIR}/frame-compare/drawer-at-rest.png"
mkdir -p "${TMPDIR}/frame-compare"
probe_frame "${AT_REST}"

k "ctrl+j"
settle 4
drawer_region
shot drawer-open
OPENED="$(screen_differs_from_frame_pixels_at "${AT_REST}" \
	"${SESSION_REGION_W}x$(( WIN_Y + WIN_H - DRAWER_TOP ))+${SESSION_REGION_X}+${DRAWER_TOP}")"
if [ "${OPENED}" -lt 2000 ]; then
	abandon_take "the-drawer-answered-its-chord" \
		"the drawer region changed ${OPENED} pixels on primary-j, so no drawer opened over the session"
fi

# ─── The Supervisor's Own Tab, Pressed In Both Arms ──────────────────────────
# The aim is taken up before the shot the arms are compared in: a pointer
# arriving on a tab paints its hover fill, and that is not what is measured.
echo "scene: pressing the second tab at ${PROCESSES_TAB_X},${CHROME_MID_Y}" >&2
move_px "${PROCESSES_TAB_X}" "${CHROME_MID_Y}"
pause 0.6
shot aim-taken
click
settle 3
shot supervisor-shown
SWITCHED="$(shots_differ_pixels aim-taken supervisor-shown)"

# ─── The Terminal Both Arms Opened ───────────────────────────────────────────
move_px "${TAB_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot terminal-shown
TERMINAL="$(shots_differ_pixels supervisor-shown terminal-shown)"

echo "scene: ${OPENED}px on the chord, ${SWITCHED}px on the supervisor's tab, ${TERMINAL}px on the terminal's" >&2

# A grid replacing the supervisor's body is thousands of pixels, and both arms
# have to reach one: the terminal exists in both, drawn in one.
if [ "${TERMINAL}" -lt 3000 ]; then
	abandon_take "the-drawer-opened-a-terminal" \
		"the strip's first tab drew ${TERMINAL} pixels over the supervisor, so this take cannot say the drawer had opened a terminal at all"
fi

if [ "${ARM}" = "before" ]; then
	if [ "${SWITCHED}" -gt 40 ]; then
		abandon_take "the-drawer-opened-on-the-supervisor" \
			"the drawer changed ${SWITCHED} pixels on the press of the supervisor's tab, so it had not opened on the supervisor and this arm is not the before one"
	fi
	echo "scene: before arm -- the drawer opened on the process list, so pressing its tab changed ${SWITCHED} pixels, while the terminal it had created was one tab along (${TERMINAL}px)" >&2
else
	if [ "${SWITCHED}" -lt 3000 ]; then
		abandon_take "the-drawer-opened-on-the-terminal" \
			"the drawer changed ${SWITCHED} pixels on the press of the supervisor's tab, so it was not drawing the terminal it asked the host for"
	fi
	echo "scene: after arm -- the drawer opened on the terminal it asked the host for, so the supervisor's tab replaced it (${SWITCHED}px)" >&2
fi
