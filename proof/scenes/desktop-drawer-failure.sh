#!/usr/bin/env bash
# Start a supervised process from the terminal drawer, ask the host to start
# the same one again, and photograph whether the drawer states the refusal.
#
# Records visual evidence for:
#   1. supervisor-open (the drawer open on the supervisor, before anything is in it)
#   2. process-running (the same drawer with the row its first Start listed)
#   3. aim-taken (the pointer resting on the `Start` the refused press lands on)
#   4. refusal-stated (the same drawer a refused press later)
#
# THE CLAIM. A request the drawer sends and the host refuses is stated in the
# drawer, in the host's own words, with the answer the host offered about it.
# The drawer drew the failure of one control -- the terminal its own opening
# creates -- so a refused `Start`, a line the host could not write and a
# process it could not stop each landed on a surface nothing draws: the press
# looked answered and the reason sat in the store. The request also registered
# under the wrong id for most of those controls, so the press drew no pending
# mark either.
#
# THE REFUSAL IS THE SHIPPED HOST'S OWN. A supervised process is named for the
# application that spawned it, and the broker refuses a name it is already
# running with `Daemon <name> is already running`, which the GUI host reports
# as a retryable `Terminal`-scope failure. So the take starts `sleep 600`,
# waits until the host lists it, and presses `Start` on the same line again.
# Nothing is corrupted and nothing outside the take's own supervisor is
# touched.
#
# THE ARMS. The reading is the same in both: the runs of pixel rows under the
# drawer's chrome whose own ground is not the drawer's, counted by height. A
# text field and a process row draw a hairline over the drawer's ground and
# read one or two pixels tall; a notice carries a ground of its own for the
# whole row. Before, there is no filled band -- the field and the row the
# first `Start` listed, with the refusal reaching no drawn element at all.
# After, there is exactly one, a row of chrome tall, above that same field.
# Neither reading names a colour.
#
# BOTH ARMS SEND THE REFUSED REQUEST, and both arms assert the host refused it
# over the socket the window is attached to: the supervisor lists exactly one
# process after two presses of `Start`. The nothing the before arm records
# belongs to the window rather than to a host that answered the second press.
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build with the change removed:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-drawer-failure.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/drawer-failure/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-drawer-failure.sh
#
# The take is a still one: a drawer opens, a row appears and a sentence is
# drawn, so both arms are recorded under the 12 fps default floor.
#
# THE AIM IS DERIVED, not guessed: the drawer is the bottom of the session
# column at the authored height, its chrome row is the first row inside it, the
# tab strip is that row's leading child and the `Start` its trailing one, and
# the command field is the first row under the chrome. Every number below comes
# out of the token files this checkout ships.
#
# NOT RECORDED HERE: which control each refusal lands on, which
# `a-refusal-of-what-the-drawer-asked-for-is-stated-in-the-drawer` sweeps over
# every action of the drawer's two capabilities; and what a press of the drawn
# `Retry` sends, which
# `a-refusal-the-drawer-landed-is-drawn-in-the-drawer` presses on the frame.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# The command the field states. The broker names the process for the
# application, so both presses ask for the same name and the second is the one
# the host refuses.
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

# The rows under the chrome, which is where a refusal takes a row and where the
# supervisor's own field is drawn.
BODY_TOP=$(( DRAWER_TOP + CHROME_H ))
BODY_H=$(( WIN_Y + WIN_H - BODY_TOP ))
BODY_GEOM="${SESSION_REGION_W}x${BODY_H}+${SESSION_REGION_X}+${BODY_TOP}"
# A body no taller than a few rows of chrome cannot hold a sentence over a
# field, and one this take cannot tell from the field alone is no reading.
if [ "${BODY_H}" -lt "$(( 4 * CHROME_H ))" ]; then
	abandon_take "the-drawer-has-rows-to-read" \
		"the drawer's body is ${BODY_H}px at this size, too short to hold a refusal over its field"
fi

drawer_region() {
	use_crop "${SESSION_REGION_X}" "${DRAWER_TOP}" \
		"${SESSION_REGION_W}" "$(( WIN_Y + WIN_H - DRAWER_TOP ))"
}

# ─── Reading The Bands Under The Chrome ──────────────────────────────────────
# The drawer's own ground is the colour most of the crop below its chrome is,
# so a band is a run of pixel rows whose modal colour is not that. A column
# holding one colour all the way down is a gap rather than content, so it is
# skipped, and the reading names no colour.
#
# The two kinds of band are told apart by height, not by hue. A text field
# draws a hairline border over the drawer's own ground, so it reads as runs
# one or two pixels tall. A notice carries a ground of its own for the whole
# row, so it reads as one run as tall as a row of chrome. `FILLED` counts the
# second kind, which is what a refusal is and what the field, the rows and the
# grid are not.
#
# Sets RUNS, FILLED, BAND_PX and BAND_OFFSET.
read_bands() { # <png>
	local dump="${SCENE_RUNTIME_DIR}/frame-compare/drawer-pixels.txt"
	mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
	magick "$1" -crop "${BODY_GEOM}" +repage txt:- >"${dump}"
	read -r RUNS FILLED BAND_PX BAND_OFFSET < <(
		python3 - "${dump}" "$(( CHROME_H / 2 ))" <<'PY'
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

filled_px = int(sys.argv[2])
if not grid:
    print("-1 0 0 0")
    raise SystemExit(0)

width = max(x for x, _ in grid) + 1
height = max(y for _, y in grid) + 1


def modal(pixels):
    counter = collections.Counter(p for p in pixels if p is not None)
    return counter.most_common(1)[0][0] if counter else None


# A column holding one colour all the way down is the drawer's gap or its
# border, not one of its rows.
columns = [x for x in range(width) if len({grid.get((x, y)) for y in range(height)}) > 1]
if not columns:
    print("0 0 0 0")
    raise SystemExit(0)

ground = modal(grid.get((x, y)) for y in range(height) for x in columns)
rows = {y: modal(grid.get((x, y)) for x in columns) for y in range(height)}

runs = []
start = None
for y in range(height):
    if rows[y] == ground:
        if start is not None:
            runs.append((start, y - start))
            start = None
        continue
    if start is None:
        start = y
if start is not None:
    runs.append((start, height - start))

filled = [run for run in runs if run[1] >= filled_px]
tallest = max(filled, key=lambda run: run[1]) if filled else (0, 0)
print(len(runs), len(filled), tallest[1], tallest[0])
PY
	)
}

# ─── What The Host Supervises ────────────────────────────────────────────────
# Asked over the socket the window is attached to, in the host's own
# vocabulary. A list is printed either way: an empty one is a reading too.
host_processes() { # <seconds> <expected-count> -> "count=<n> names=<a,b> statuses=<s,t>"
python3 - "$1" "$2" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
deadline = time.monotonic() + float(sys.argv[1])
wanted = int(sys.argv[2])
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
                    if len(rows) == wanted:
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

# Nothing is supervised before the first press, in either arm. A workspace that
# already ran this name would hand the take a refusal it did not send.
STARTING_LIST="$(host_processes 2 0)"
case "${STARTING_LIST}" in
	"count=0 "*) ;;
	*)
		abandon_take "the-supervisor-starts-empty" \
			"the host already supervises something (${STARTING_LIST}), so neither arm can say what a press did"
		;;
esac

# ─── The Drawer, Moved To The Supervisor ─────────────────────────────────────
# The drawer opens on the terminal it asked the host for, so the supervisor is
# one tab along: one `/bin/sh` label (47px at the body ramp in this checkout's
# font) past the strip's first tab.
PROCESSES_TAB_X=$(( TAB_X + 47 ))
AT_REST="${SCENE_RUNTIME_DIR}/frame-compare/drawer-at-rest.png"
mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
probe_frame "${AT_REST}"

k "ctrl+j"
pause 2
drawer_region
OPENED="$(screen_differs_from_frame_pixels_at "${AT_REST}" \
	"${SESSION_REGION_W}x$(( WIN_Y + WIN_H - DRAWER_TOP ))+${SESSION_REGION_X}+${DRAWER_TOP}")"
if [ "${OPENED}" -lt 2000 ]; then
	abandon_take "the-drawer-opened" \
		"the drawer region changed ${OPENED} pixels on ctrl+j, so no drawer opened to press anything in"
fi

move_px "${PROCESSES_TAB_X}" "${CHROME_MID_Y}"
pause 0.3
click
settle 3
shot supervisor-open

# ─── The Process The Host Accepts ────────────────────────────────────────────
# The first press is the same in both arms and succeeds in both: the fix under
# test is what the drawer does with a refusal, not whether a start works.
move_px "${FIELD_X}" "${FIELD_Y}"
pause 0.3
click
pause 0.4
t "${COMMAND_LINE}"
pause 0.8
move_px "${START_X}" "${CHROME_MID_Y}"
pause 0.4
click
settle 3
shot process-running
FIRST_LIST="$(host_processes 20 1)"
case "${FIRST_LIST}" in
	*"names=${COMMAND_NAME}"*) ;;
	*)
		abandon_take "the-first-press-started-the-command" \
			"the host says ${FIRST_LIST}, so there is no live ${COMMAND_NAME} for a second start to be refused over"
		;;
esac

# ─── The Press The Host Refuses ──────────────────────────────────────────────
# The same line again, so the broker is asked for a name it is already running
# and answers `Daemon ${COMMAND_NAME} is already running`. The pointer rests on
# the word before the baseline is taken, so the hover fill a control paints as
# a pointer arrives sits in both shots rather than in the number the press is
# read from.
move_px "${FIELD_X}" "${FIELD_Y}"
pause 0.3
click
pause 0.4
t "${COMMAND_LINE}"
pause 0.8
echo "scene: pressing the refused Start at ${START_X},${CHROME_MID_Y}" >&2
move_px "${START_X}" "${CHROME_MID_Y}"
pause 0.6
shot aim-taken
click
settle 4
shot refusal-stated

read_bands "${SCENE_OUT}/${SCENE_NAME}-refusal-stated.png"
if [ "${RUNS}" -lt 1 ]; then
	abandon_take "refusal-stated" "the frame carried no drawer rows to read"
fi

# The host refused the second press in both arms: it supervises one process
# under that name, not two. Without this the nothing the before arm records
# could be a host that started something quietly.
SECOND_LIST="$(host_processes 8 1)"
case "${SECOND_LIST}" in
	"count=1 names=${COMMAND_NAME} "*) ;;
	*)
		abandon_take "the-host-refused-the-second-start" \
			"the host says ${SECOND_LIST} after the second press, so it did not refuse the name it was already running"
		;;
esac

if [ "${ARM}" = "before" ]; then
	# The field and the row it lists, and no notice over either: the refusal
	# reached no drawn element at all.
	if [ "${FILLED}" != "0" ]; then
		abandon_take "refusal-stated" \
			"the drawer drew ${FILLED} filled band(s) under its chrome, so this build states the refusal and is not the before one"
	fi
	# The positive control on the reading itself: the supervisor's own field
	# and row are in the crop, so the zero above is a drawer that said
	# nothing rather than a crop that read nothing.
	if [ "${RUNS}" -lt 1 ]; then
		abandon_take "refusal-stated" \
			"the crop under the chrome holds ${RUNS} bands, so it read none of the supervisor either"
	fi
	echo "scene: before arm -- the host refused the start (${SECOND_LIST}) and the drawer stated nothing" >&2
else
	if [ "${FILLED}" != "1" ]; then
		abandon_take "refusal-stated" \
			"the drawer drew ${FILLED} filled bands under its chrome, against the one row a refusal takes"
	fi
	# One row of chrome, so a sentence carried onto a second line or a band as
	# tall as a list of rows is a failed take rather than a taller notice.
	if [ "${BAND_PX}" -gt "$(( 2 * CHROME_H ))" ]; then
		abandon_take "refusal-stated" \
			"the refusal's band is ${BAND_PX}px, past the $(( 2 * CHROME_H ))px two rows of chrome take"
	fi
	# Drawn under the chrome and above the body, which is what a reader of a
	# refused press reaches without scrolling.
	if [ "${BAND_OFFSET}" -gt "${CHROME_H}" ]; then
		abandon_take "refusal-stated" \
			"the refusal's band starts ${BAND_OFFSET}px under the chrome, past the ${CHROME_H}px a row of chrome sits in"
	fi
	# The supervisor is still under it: the refusal took a row from the body
	# rather than replacing what the press was made in.
	if [ "${RUNS}" -lt 2 ]; then
		abandon_take "refusal-stated" \
			"the crop holds ${RUNS} band(s), so the refusal replaced the supervisor rather than sitting over it"
	fi
	echo "scene: after arm -- the drawer states the refusal in a ${BAND_PX}px band at +${BAND_OFFSET}," \
		"over ${RUNS} bands of supervisor (${SECOND_LIST})" >&2
fi

echo "scene: ${ARM} arm -- ${RUNS} bands under the chrome, ${FILLED} of them filled;" \
	"drawer ${OPENED}px open; first press ${FIRST_LIST}" >&2
