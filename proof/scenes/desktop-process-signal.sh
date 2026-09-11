#!/usr/bin/env bash
# Start a supervised process that traps `SIGHUP`, press the row's `Signal`, pick
# `Hang up (SIGHUP)` out of the menu that opens, and ask the host what the
# process printed.
#
# Records visual evidence for:
#   1. supervisor-running (the drawer open on a supervisor with one row in it)
#   2. signal-menu (the same drawer with the row's five signals floated over it)
#   3. signal-sent (the same drawer once the picked signal has been sent)
#
# THE PAIR IS TWO BINARIES, not two settings. The row offered `Stop` and
# `Restart`, which is one signal of the five the supervisor accepts, spelled as
# a literal beside the action: a process that traps `SIGTERM` answered the only
# press the window had and kept running, and no press anywhere asked for
# `SIGINT`, `SIGHUP`, `SIGQUIT` or `SIGKILL`. Both arms run this same scene at
# the same coordinates; the window is the differential.
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-process-signal.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/process-signal/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-process-signal.sh
#
# The take is a still one: a row appears, a menu floats and a menu closes, which
# measures well under the 12 fps default floor, so both arms record at 5.
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of this tree with the fix taken out of it instead
# (`.internal/build-commit-before.py --holdback
# .internal/before-edits/process-signal.patch process-signal`, then `--after` to
# put this tree's executable back).
#
# WHAT IS MEASURED. The process the scene starts prints `ready` and then echoes
# `caught-hup` from a trap on `SIGHUP`, so the host's own log of it states which
# signal arrived: `SIGHUP` is a signal no other control in the window sends, so
# the line can only have come from the menu. The after arm requires
# `caught-hup`, the before arm requires none. The menu is read out of the frame
# as well -- its five rows are located by the fill a floated surface is drawn
# on, and the row that is clicked is the one the reading found -- so a take that
# clicked a coordinate nothing was drawn at cannot pass for one that picked a
# signal.
#
# THE AIM IS DERIVED, not guessed: the drawer is the bottom of the session
# column at the authored height, its chrome row is first inside it, the command
# field is the row under that, and the process list follows. The row's trailing
# controls end at the list's own padding, and `Signal` is the last of the four.
# Every number below comes out of the token files this checkout ships.
#
# THE BEFORE ARM CARRIES A POSITIVE CONTROL: the same log request answers with
# the `ready` the process printed, so the log path the after arm reads
# `caught-hup` out of is working and the process is running its trap. The
# nothing the arm records belongs to the window rather than to a process nobody
# could have signalled. In that arm the same press lands on the row's `Send`,
# which is the last control the row drew before this change, and the drawer
# states the refusal an empty field earns: that is what the window had there.
#
# NOT RECORDED HERE: which spelling each signal crosses the wire in, which
# `a-vocabulary-the-host-closed-is-sent-in-the-spelling-it-accepts` round-trips
# over every variant, and which row sends which signal, which
# `a-signal-the-supervisor-accepts-is-offered-on-the-process-row` presses one at
# a time over all five.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# The process the scene supervises. `sh` is the application, and the script it
# runs prints one line at startup and one more from a trap on `SIGHUP`, so the
# host's log states both that the process is listening and which signal it
# received. The handler is a function so the command line carries no nested
# quotes for the field's own parse to resolve.
COMMAND_LINE="sh -c 'caught() { echo caught-hup; }; trap caught HUP; echo ready; while :; do sleep 0.2; done'"
COMMAND_NAME="sh"
# The line the trap prints. Not a word the process prints on its own, and not a
# word any other signal produces.
CAUGHT_LINE="caught-hup"

# The menu's rows, and which of them is picked: `Hang up (SIGHUP)`, third of
# the five, which is neither the first row a press at the menu's corner would
# land on by accident nor the union's own default.
MENU_ITEMS=5
HUP_ITEM=3
# What a menu floated over the drawer repaints at the least. Its own box is
# about 175x150px on this window, and the fill differs from the canvas under it
# across nearly all of it.
MENU_MIN_PIXELS=8000
# How much of the menu's first row's ink a row has to carry to be an answer a
# click reaches rather than a disabled label.
OFFERED_MIN_STRENGTH=40

# ─── Where The Supervisor Draws Its Rows, And What A Menu Floats On ──────────
read -r DRAWER_H GRIP_PX CHROME_H ROW_H S2 S3 MENU_FILL < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" "${WIN_W}" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
tokens = root / "tokens"
width = float(sys.argv[2])
panels = tomllib.loads((tokens / "surface" / "panels.toml").read_text())
scale = tomllib.loads((tokens / "scale.toml").read_text())["spacing"]
roles = tomllib.loads((root / "themes" / "dark.toml").read_text())["role"]
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
    roles["float"],
)
PY
)
if [ -z "${MENU_FILL:-}" ]; then
	abandon_take "the-drawer-is-locatable" "no drawer geometry resolved for a ${WIN_W}px window"
fi
if [ "${DRAWER_PLACEMENT}" != "row" ]; then
	abandon_take "the-drawer-is-a-row" \
		"the drawer draws as a ${DRAWER_PLACEMENT} at ${WIN_W}px, and this scene aims at the row it takes"
fi
echo "scene: a menu floats on ${MENU_FILL}" >&2

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
# The row's trailing controls are `Stop`, `Restart`, `Send` and `Signal`, and
# `Signal` is the last of them: its box ends at the list's own padding plus the
# row's, and `Signal` at the body ramp is 40px of label inside a medium
# button's two 12px insets.
SIGNAL_X=$(( WIN_X + WIN_W - S3 - 46 ))
# Somewhere inside the drawer that no menu covers, where the pointer waits
# while a frame is read: the drawer's leading edge under its own list.
PARK_X=$(( WIN_X + RAIL_W + S3 ))
PARK_Y=$(( WIN_Y + WIN_H - S2 - FIELD_H / 2 ))
if (( ROW_MID_Y >= PARK_Y || PARK_Y >= WIN_Y + WIN_H )); then
	abandon_take "the-supervisor-is-locatable" \
		"the derived aims (row ${ROW_MID_Y}, park ${PARK_Y}) do not sit inside a ${WIN_H}px window"
fi

drawer_region() {
	use_crop "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))"
}

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

WINDOW_CROP="$(printf '%dx%d+%d+%d' "${WIN_W}" "${WIN_H}" "${WIN_X}" "${WIN_Y}")"
MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

# A menu's rows, read over the drawer's own band. The menu is clamped inside
# the window, so it is found by its fill anywhere in that band rather than at
# the corner the press stated; nothing else the drawer draws carries the fill a
# floated surface is drawn on.
menu_item() { # <frame> <items> <item> -> <y> <x> <strength>
	python3 "${MEASURE}" menu-item "$1" "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))" \
		"${MENU_FILL}" "$3" "$2"
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
			"the host already supervises something (${STARTING_LIST}), so neither arm can say which signal the press sent"
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
move_px "${PARK_X}" "${PARK_Y}"
pause 0.5
shot supervisor-running
BEFORE_PRESS="${PROBE_DIR}/process-signal-before-press.png"
probe_frame "${BEFORE_PRESS}"
LIST="$(host_processes 20)"
case "${LIST}" in
	*"names=${COMMAND_NAME}"*) ;;
	*)
		abandon_take "the-process-is-supervised" \
			"the host says ${LIST}, so neither arm has a process to signal"
		;;
esac

# The positive control, read before the press: the log path answers, and the
# process printed the line it prints once its trap is armed.
READY="$(host_log "${COMMAND_NAME}" 15 ready)"
case "${READY}" in
	*ready*) ;;
	*)
		abandon_take "the-log-path-answers" \
			"the host says ${READY} for ${COMMAND_NAME}, so this take cannot read which signal arrived"
		;;
esac

# ─── The Press, On The Last Control The Row States ───────────────────────────
echo "scene: pressing the row's signal at ${SIGNAL_X},${ROW_MID_Y}" >&2
move_px "${SIGNAL_X}" "${ROW_MID_Y}"
pause 0.4
click
pause 1.0
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
MENU_OPEN="${PROBE_DIR}/process-signal-menu.png"
probe_frame "${MENU_OPEN}"
MENU_PX="$(frames_differ_pixels_at "${BEFORE_PRESS}" "${MENU_OPEN}" "${WINDOW_CROP}")"
shot signal-menu
echo "scene: the press repainted ${MENU_PX}px of the window" >&2

# ─── The Signal The Menu Offers ──────────────────────────────────────────────
case "${ARM}" in
	after)
		if [ "${MENU_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
			abandon_take "the-press-opened-a-menu" \
				"the press on the row's signal repainted ${MENU_PX}px, under the ${MENU_MIN_PIXELS} a menu floated over the drawer inks"
		fi
		read -r HUP_Y HUP_X HUP_STRENGTH < <(menu_item "${MENU_OPEN}" "${MENU_ITEMS}" "${HUP_ITEM}") \
			|| abandon_take "the-signals-are-readable" \
				"the ${MENU_ITEMS} rows a signal menu offers were not readable out of the frame it opened in"
		if [ "${HUP_STRENGTH}" -lt "${OFFERED_MIN_STRENGTH}" ]; then
			abandon_take "the-signal-row-is-offered" \
				"the hang-up row is inked to ${HUP_STRENGTH}% of the menu's first row, under the ${OFFERED_MIN_STRENGTH} an offered answer draws, so a click on it sends nothing"
		fi
		echo "scene: the hang-up row is drawn at ${HUP_X}+${HUP_Y}, inked to ${HUP_STRENGTH}% of the first row" >&2
		move_px "${HUP_X}" "${HUP_Y}"
		pause 0.4
		click
		settle 3
		;;
	before)
		if menu_item "${MENU_OPEN}" "${MENU_ITEMS}" "${HUP_ITEM}" > /dev/null 2>&1; then
			abandon_take "the-row-offers-no-signals" \
				"the press floated ${MENU_ITEMS} rows in the arm whose row offers none, so this arm is not the state the fix changed"
		fi
		echo "scene: before arm -- the press at the row's last control floated no menu of signals" >&2
		;;
esac

move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot signal-sent
CLOSED="$(shots_differ_pixels signal-menu signal-sent)"
DELIVERED="$(host_log "${COMMAND_NAME}" 20 "${CAUGHT_LINE}")"

echo "scene: ${MENU_PX}px on the press, ${CLOSED}px after the pick; the host says ${LIST}; ${DELIVERED}" >&2

if [ "${ARM}" = "before" ]; then
	case "${DELIVERED}" in
		*"${CAUGHT_LINE}"*)
			abandon_take "the-press-sent-no-signal" \
				"the process caught a hang-up (${DELIVERED}), so this arm is not the before one"
			;;
	esac
	case "${DELIVERED}" in
		log=unreadable*)
			abandon_take "the-process-answered-the-host" \
				"the host did not answer ProcessLogs (${DELIVERED}), so this take cannot say the window was what sent nothing"
			;;
	esac
	echo "scene: before arm -- the supervisor listed a running process with no signal to send it, and the press sent none (${DELIVERED})" >&2
else
	if [ "${CLOSED}" -lt "${MENU_MIN_PIXELS}" ]; then
		abandon_take "the-menu-closed-on-the-pick" \
			"the drawer changed ${CLOSED} pixels when the row was picked, so the menu that was floated over it did not close"
	fi
	case "${DELIVERED}" in
		*"${CAUGHT_LINE}"*) ;;
		*)
			abandon_take "the-process-caught-the-signal" \
				"the host says ${DELIVERED} for ${COMMAND_NAME}, against the hang-up the menu's row asked for"
			;;
	esac
	echo "scene: after arm -- the picked row sent the signal the process traps, and the process printed it (${DELIVERED})" >&2
fi
