#!/usr/bin/env bash
# Open the terminal drawer's process supervisor in the native GPUI window, type
# a command into it, press `Start`, and photograph whether a process runs.
#
# Records visual evidence for:
#   1. supervisor-open (the drawer open on the supervisor, before anything is in it)
#   2. command-typed (the same drawer with a command stated in its field)
#   3. process-running (the same drawer a press of `Start` later)
#
# THE PAIR IS TWO BINARIES, not two settings. The `Start` dispatched
# `ProcessStart { command: "", args: [] }`, which the host answers with
# `INVALID_ARGUMENTS`, and there was nowhere on the surface to state a command;
# the tab it sits on was pushed only once the host already listed a process, so
# the tab the first process is started from appeared only after something else
# had started one. Both arms run this same scene; the window is the
# differential.
#
#   proof/docker/record-native.sh proof/scenes/desktop-process-start.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/process-start/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-process-start.sh
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of the commit before the fix instead
# (`.internal/build-commit-before.py --holdback <fix> process-start`, then
# `--after` to put this tree's executable back).
#
# WHAT IS MEASURED. The host is asked in its own vocabulary, over the same
# socket the window uses: the after arm requires a supervised process named for
# the application the field stated, the before arm requires none. A frame is
# read as well -- the drawer region has to change when the drawer opens, when
# the command is typed and when the press lands -- so a take that photographed
# a still window cannot pass for one that started something.
#
# THE AIM IS DERIVED, not guessed: the drawer is the bottom of the session
# column at the authored height, its chrome row is the first row inside it, the
# tab strip is that row's leading child and the `Start` its trailing one, and
# the command field is the first row under the chrome. Every number below comes
# out of the token files this checkout ships.
#
# THE BEFORE ARM CARRIES A POSITIVE CONTROL: the same socket answers
# `RefreshProcesses` with a list, so the supervisor the host declares is
# reachable and empty. The nothing the arm records belongs to the window rather
# than to a host that supervises nothing.
#
# NOT RECORDED HERE: what a command line splits into, which
# `the-supervisor-starts-the-command-its-field-states` sweeps over quoted,
# padded and empty lines; and which capability states offer the tab, which
# `a-tab-the-host-offers-is-reachable-before-anything-is-in-it` sweeps.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# The command the field states. `sleep` is the application and `600` its one
# argument, so the row the host lists is named for a real spawn that outlives
# the take rather than for one that exited before the frame.
COMMAND_LINE="sleep 600"
COMMAND_NAME="sleep"

# ─── Where The Supervisor Is ─────────────────────────────────────────────────
# The drawer takes the authored height off the bottom of the session column,
# with the split's grip above it. Inside it the chrome row is first, carrying
# the tab strip at its leading edge and the `Start` at its trailing one, and
# the command field is the first row under that.
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

# The drawer's own content starts under the split's grip.
DRAWER_TOP=$(( WIN_Y + WIN_H - DRAWER_H + GRIP_PX ))
CHROME_MID_Y=$(( DRAWER_TOP + CHROME_H / 2 ))
# The tab strip's leading child, past the chrome row's padding and the tab's
# own, onto the word the tab draws.
TAB_X=$(( WIN_X + RAIL_W + S3 + S2 + 20 ))
# The chrome row's trailing child, one step and a half in from the row's own
# padding, which is inside the word at the authored label size.
START_X=$(( WIN_X + WIN_W - S3 - 24 ))
# The command field, the first row under the chrome.
FIELD_X=$(( WIN_X + RAIL_W + S3 + 60 ))
FIELD_Y=$(( DRAWER_TOP + CHROME_H + S2 + 12 ))
if (( CHROME_MID_Y <= WIN_Y || FIELD_Y >= WIN_Y + WIN_H )); then
	abandon_take "the-supervisor-is-locatable" \
		"the derived aims (chrome ${CHROME_MID_Y}, field ${FIELD_Y}) fall outside a ${WIN_H}px window"
fi

drawer_region() {
	use_crop "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))"
}

# ─── What The Host Supervises ────────────────────────────────────────────────
# Asked over the socket the window is attached to, in the host's own
# vocabulary. A list is printed either way: an empty one is a reading too, and
# the before arm is written around one.
host_processes() { # <seconds> -> "count=<n> names=<a,b> statuses=<s,t>"
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
last = "count=unreadable names= statuses="

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
                    processes, _errors = snapshot["Processes"]
                    rows = processes["value"]
                    names = ",".join(str(row.get("name", "")) for row in rows)
                    statuses = ",".join(str(row.get("status", "")) for row in rows)
                    last = f"count={len(rows)} names={names} statuses={statuses}"
                    if rows:
                        print(last)
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = f"count=unreadable names= statuses= ({error})"
    if time.monotonic() >= deadline:
        print(last)
        raise SystemExit(0)
    time.sleep(0.2)
PY
}

# Nothing is supervised before the press, in either arm. A workspace that
# already had a process in it would hand the before arm the tab the defect
# withholds, and the after arm a row it did not start.
STARTING_LIST="$(host_processes 2)"
case "${STARTING_LIST}" in
	"count=0 "*) ;;
	*)
		abandon_take "the-supervisor-starts-empty" \
			"the host already supervises something (${STARTING_LIST}), so neither arm can say what the press did"
		;;
esac

# ─── The Drawer, Open On The Supervisor ──────────────────────────────────────
AT_REST="${SCENE_RUNTIME_DIR}/frame-compare/process-at-rest.png"
mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
probe_frame "${AT_REST}"

k "ctrl+j"
pause 2
drawer_region
shot supervisor-open
OPENED="$(screen_differs_from_frame_pixels_at "${AT_REST}" \
	"${SESSION_REGION_W}x$(( WIN_Y + WIN_H - DRAWER_TOP ))+${SESSION_REGION_X}+${DRAWER_TOP}")"
if [ "${OPENED}" -lt 2000 ]; then
	abandon_take "the-drawer-answered-its-chord" \
		"the drawer region changed ${OPENED} pixels on primary-j, so no drawer opened over the session"
fi

# ─── The Command The Field States ────────────────────────────────────────────
# The pointer clicks where the field is drawn and the line is typed there. In
# the before arm there is no field: the click lands on the drawer's own body
# and the keystrokes go wherever that leaves the focus, which is the state the
# arm is recording.
move_px "${FIELD_X}" "${FIELD_Y}"
pause 0.3
click
pause 0.4
t "${COMMAND_LINE}"
pause 0.8
shot command-typed
TYPED="$(shots_differ_pixels supervisor-open command-typed)"

# ─── The Press, On The Word The Chrome States ────────────────────────────────
echo "scene: pressing the supervisor's start at ${START_X},${CHROME_MID_Y}" >&2
move_px "${START_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot process-running
PRESSED="$(shots_differ_pixels command-typed process-running)"
LIST="$(host_processes 20)"

echo "scene: drawer ${OPENED}px open, ${TYPED}px typed, ${PRESSED}px after the press;" \
	"the host says ${LIST}" >&2

if [ "${ARM}" = "before" ]; then
	case "${LIST}" in
		"count=0 "*) ;;
		*)
			abandon_take "the-press-started-nothing" \
				"the host says ${LIST} after the press, so something started and this arm is not the before one"
			;;
	esac
	# The positive control: the same socket answered the list, so the
	# supervisor the host declares is reachable and empty. Without this the
	# nothing above could be a host that supervises nothing rather than a
	# window that offers no route to it.
	case "${LIST}" in
		count=unreadable*)
			abandon_take "the-supervisor-answered-the-host" \
				"the host did not answer RefreshProcesses (${LIST}), so this take cannot say the window was what offered nothing"
			;;
	esac
	echo "scene: before arm -- the drawer opened on a supervisor with no tab, no field and a Start that started nothing (${LIST})" >&2
else
	if [ "${TYPED}" -lt 150 ]; then
		abandon_take "the-command-reached-the-field" \
			"the drawer changed ${TYPED} pixels while a command was typed, so the keystrokes went somewhere else"
	fi
	if [ "${PRESSED}" -lt 150 ]; then
		abandon_take "the-press-changed-the-drawer" \
			"the drawer changed ${PRESSED} pixels on the press, so the field neither cleared nor listed what it started"
	fi
	case "${LIST}" in
		*"names=${COMMAND_NAME}"*) ;;
		*)
			abandon_take "the-press-started-the-command" \
				"the host says ${LIST} after the press, against the ${COMMAND_NAME} the field stated"
			;;
	esac
	echo "scene: after arm -- the press started what the field stated, and the host supervises it (${LIST})" >&2
fi
