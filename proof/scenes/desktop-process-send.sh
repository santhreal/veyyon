#!/usr/bin/env bash
# Start a supervised process that reads its input, state a line in the drawer's
# input field, press the row's `Send`, and ask the host what the process
# received.
#
# Records visual evidence for:
#   1. supervisor-running (the drawer open on a supervisor with one row in it)
#   2. line-typed (the same drawer with a line stated below the list)
#   3. line-sent (the same drawer a press of the row's `Send` later)
#
# THE PAIR IS TWO BINARIES, not two settings. The row's `Send` raised
# `ProcessSend { data: [] }` on every press; the host writes that payload to the
# process's input verbatim and answers success, so the press wrote zero bytes
# and reported nothing wrong, and there was nowhere on the surface to state what
# to send. Both arms run this same scene; the window is the differential.
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-process-send.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/process-send/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-process-send.sh
#
# The take is a still one: a row appears, a line is typed and a field clears,
# which measures well under the 12 fps default floor, so both arms record at 5.
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of this tree with the fix taken out of it instead
# (`.internal/build-commit-before.py --holdback
# .internal/before-edits/process-send.patch process-send`, then `--after` to put
# this tree's executable back).
#
# WHAT IS MEASURED. The process the scene starts prints `ready` and then echoes
# every line it reads back as `got <line>`, so the host's own log of it states
# what the press delivered: the after arm requires `got sent-by-the-window`, the
# before arm requires none. Frames are read as well -- the drawer has to change
# when the line is typed and when the press lands -- so a take that photographed
# a still window cannot pass for one that sent something.
#
# THE AIM IS DERIVED, not guessed: the drawer is the bottom of the session
# column at the authored height, its chrome row is first inside it, the command
# field is the row under that, the process list follows, and the input field is
# the last row against the drawer's bottom padding. Every number below comes out
# of the token files this checkout ships.
#
# THE BEFORE ARM CARRIES A POSITIVE CONTROL: the same log request answers with
# the `ready` the process printed, so the log path the after arm reads `got` out
# of is working and the process is listening on its input. The nothing the arm
# records belongs to the window rather than to a process nobody could have
# written to.
#
# NOT RECORDED HERE: which bytes a line turns into, and which process a submit
# with no row named reaches, which
# `a-line-a-process-receives-is-the-line-the-field-states` sweeps over a padded
# line, whitespace, an empty field, one running process and several.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# The process the scene supervises. `sh` is the application, and the script it
# runs prints one line at startup and echoes every line it reads, so the host's
# log states both that the process is listening and what it received.
COMMAND_LINE="sh -c 'echo ready; while read line; do echo got \$line; done'"
COMMAND_NAME="sh"
# The line the field states. Not a word the process prints on its own, so a
# `got` line in the log can only have come from the press.
SENT_LINE="sent-by-the-window"

# ─── Where The Supervisor Draws Its Rows And Fields ──────────────────────────
read -r DRAWER_H GRIP_PX CHROME_H ROW_H S2 S3 < <(
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
    int(panels["terminal_drawer"]["process_row_height_px"]),
    int(scale["s2"]),
    int(scale["s3"]),
)
PY
)
if [ -z "${ROW_H:-}" ]; then
	abandon_take "the-drawer-is-locatable" "no drawer geometry resolved for a ${WIN_W}px window"
fi
if [ "${DRAWER_PLACEMENT}" != "row" ]; then
	abandon_take "the-drawer-is-a-row" \
		"the drawer draws as a ${DRAWER_PLACEMENT} at ${WIN_W}px, and this scene aims at the row it takes"
fi

# A field is this high, and its prose sits at its centre: the one number the
# token files state as a component rather than as a step.
FIELD_H=28

# The drawer's own content starts under the split's grip.
DRAWER_TOP=$(( WIN_Y + WIN_H - DRAWER_H + GRIP_PX ))
CHROME_MID_Y=$(( DRAWER_TOP + CHROME_H / 2 ))
# The chrome row's trailing child, which is the supervisor's `Start`.
START_X=$(( WIN_X + WIN_W - S3 - 24 ))
# The strip's tabs: the terminal the drawer opened with is first, past the
# chrome row's padding and the tab's own, and the supervisor's tab is one
# `/bin/sh` label along (47px at the body ramp in this checkout's font).
TAB_X=$(( WIN_X + RAIL_W + S3 + S2 + 20 ))
PROCESSES_TAB_X=$(( TAB_X + 47 ))
# The command field, the first row under the chrome.
FIELD_X=$(( WIN_X + RAIL_W + S3 + 60 ))
COMMAND_TOP=$(( DRAWER_TOP + CHROME_H + S2 ))
FIELD_Y=$(( COMMAND_TOP + FIELD_H / 2 ))
# The list under it, and the one row in it once the press has started something.
ROW_MID_Y=$(( COMMAND_TOP + FIELD_H + S2 + ROW_H / 2 ))
# The row's trailing controls are `Stop`, `Restart` and `Send`, and `Send` is
# the last of them, one step and a half in from the list's own padding.
SEND_X=$(( WIN_X + WIN_W - S3 - 40 ))
# The input field, the last row against the drawer's bottom padding.
INPUT_Y=$(( WIN_Y + WIN_H - S2 - FIELD_H / 2 ))
if (( ROW_MID_Y >= INPUT_Y || INPUT_Y >= WIN_Y + WIN_H )); then
	abandon_take "the-supervisor-is-locatable" \
		"the derived aims (row ${ROW_MID_Y}, input ${INPUT_Y}) do not sit inside a ${WIN_H}px window"
fi

drawer_region() {
	use_crop "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))"
}

# ─── What The Host Supervises, And What It Logged ────────────────────────────
# Both readings are asked over the socket the window is attached to, in the
# host's own vocabulary.
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
                    # `Processes` carries the list itself, not the versioned
                    # pair `Sessions` carries.
                    rows = snapshot["Processes"]
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

host_log() { # <process> <seconds> <line-to-wait-for> -> "log=<a|b|c>"
python3 - "$1" "$2" "$3" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

process = sys.argv[1]
deadline = time.monotonic() + float(sys.argv[2])
wanted = sys.argv[3]
profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
# The host reads an action as the externally tagged enum the window sends: a
# unit action is its own name, and one carrying fields is a single-key object.
request = json.dumps(
    {"id": 1, "action": {"ProcessLogs": {"process_id": process, "follow": False}}}
).encode() + b"\n"
last = "log=unreadable"

while True:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5.0)
            connection.connect(str(endpoint))
            connection.sendall(request)
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    frame = stream.readline(8 * 1024 * 1024 + 1)
                    if not frame or len(frame) > 8 * 1024 * 1024:
                        raise RuntimeError("missing or oversized host frame")
                    snapshot = json.loads(frame).get("Snapshot", {})
                    if "ProcessLogs" not in snapshot:
                        continue
                    lines = [
                        str(entry).strip()
                        for entry in snapshot["ProcessLogs"].get("lines", [])
                        if str(entry).strip()
                    ]
                    last = "log=" + "|".join(lines)
                    if any(wanted in entry for entry in lines):
                        print(last)
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = f"log=unreadable ({error})"
    if time.monotonic() >= deadline:
        print(last)
        raise SystemExit(0)
    time.sleep(0.3)
PY
}

# Nothing is supervised before the scene starts anything, in either arm.
STARTING_LIST="$(host_processes 2)"
case "${STARTING_LIST}" in
	"count=0 "*) ;;
	*)
		abandon_take "the-supervisor-starts-empty" \
			"the host already supervises something (${STARTING_LIST}), so neither arm can say what the press delivered"
		;;
esac

# ─── The Process Both Arms Supervise ─────────────────────────────────────────
# The start is the same in both arms: the field it reads and the control that
# reads it are not what this scene records.
#
# The drawer opens on the terminal it asked the host for, so the scene moves
# to the supervisor's tab before it types into the field the supervisor draws.
k "ctrl+j"
pause 2
drawer_region
move_px "${PROCESSES_TAB_X}" "${CHROME_MID_Y}"
pause 0.3
click
settle 2
move_px "${FIELD_X}" "${FIELD_Y}"
pause 0.3
click
pause 0.4
t "${COMMAND_LINE}"
pause 0.6
move_px "${START_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot supervisor-running
LIST="$(host_processes 20)"
case "${LIST}" in
	*"names=${COMMAND_NAME}"*) ;;
	*)
		abandon_take "the-process-is-supervised" \
			"the host says ${LIST}, so neither arm has a process to send a line to"
		;;
esac

# The positive control, read before the press: the log path answers, and the
# process printed the line it prints when it starts reading its input.
READY="$(host_log "${COMMAND_NAME}" 15 ready)"
case "${READY}" in
	*ready*) ;;
	*)
		abandon_take "the-log-path-answers" \
			"the host says ${READY} for ${COMMAND_NAME}, so this take cannot read what the press delivered"
		;;
esac

# ─── The Line The Field States ───────────────────────────────────────────────
# The pointer clicks where the input field is drawn and the line is typed there.
# In the before arm there is no field: the click lands on the drawer's own body
# and the keystrokes go wherever that leaves the focus, which is the state the
# arm is recording.
move_px "${FIELD_X}" "${INPUT_Y}"
pause 0.3
click
pause 0.4
t "${SENT_LINE}"
pause 0.8
shot line-typed
TYPED="$(shots_differ_pixels supervisor-running line-typed)"

# ─── The Press, On The Word The Row States ───────────────────────────────────
echo "scene: pressing the row's send at ${SEND_X},${ROW_MID_Y}" >&2
move_px "${SEND_X}" "${ROW_MID_Y}"
pause 0.4
click
settle 3
shot line-sent
PRESSED="$(shots_differ_pixels line-typed line-sent)"
DELIVERED="$(host_log "${COMMAND_NAME}" 20 "got ${SENT_LINE}")"

echo "scene: ${TYPED}px typed, ${PRESSED}px after the press; the host says ${LIST}; ${DELIVERED}" >&2

if [ "${ARM}" = "before" ]; then
	case "${DELIVERED}" in
		*"got ${SENT_LINE}"*)
			abandon_take "the-press-delivered-nothing" \
				"the process received the line (${DELIVERED}), so this arm is not the before one"
			;;
	esac
	case "${DELIVERED}" in
		log=unreadable*)
			abandon_take "the-process-answered-the-host" \
				"the host did not answer ProcessLogs (${DELIVERED}), so this take cannot say the window was what delivered nothing"
			;;
	esac
	echo "scene: before arm -- the supervisor listed a running process with nowhere to state a line, and the press wrote nothing to it (${DELIVERED})" >&2
else
	if [ "${TYPED}" -lt 150 ]; then
		abandon_take "the-line-reached-the-field" \
			"the drawer changed ${TYPED} pixels while a line was typed, so the keystrokes went somewhere else"
	fi
	if [ "${PRESSED}" -lt 60 ]; then
		abandon_take "the-press-cleared-the-field" \
			"the drawer changed ${PRESSED} pixels on the press, so the field the line was sent from did not empty"
	fi
	case "${DELIVERED}" in
		*"got ${SENT_LINE}"*) ;;
		*)
			abandon_take "the-process-received-the-line" \
				"the host says ${DELIVERED} for ${COMMAND_NAME}, against the line the field stated"
			;;
	esac
	echo "scene: after arm -- the press delivered the line the field stated, and the process echoed it (${DELIVERED})" >&2
fi
