#!/usr/bin/env bash
# Start a real turn in the native GPUI window, press the `Stop` the run bar
# states beside it, and photograph whether the turn ends.
#
# Records visual evidence for:
#   1. turn-running (the run bar stating the turn, with its `Stop`)
#   2. stop-clicked (the same band, one click on that word later)
#   3. stop-settled (the same band again, fifteen seconds later)
#
# THE PAIR IS TWO BINARIES, not two settings. The run bar drew the word `Stop`
# as plain text: no id, no hitbox, no click handler. It read as the control for
# the turn the bar was stating, and a press on it did nothing at all. Both arms
# run this same scene; the window is the differential.
#
#   proof/docker/record-native.sh proof/scenes/desktop-run-bar-stop.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/run-bar-stop/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-run-bar-stop.sh
#
# The change is the window's alone, so the before arm holds no source back and
# runs a build of the commit before the fix instead
# (`.internal/build-commit-before.py --holdback <fix> run-bar-stop`, then
# `--after` to put this tree's executable back).
#
# WHAT IS MEASURED. `[tint.working]` is the fill the `Working` chip paints and
# nothing else in the window paints it, so the queue crop is reduced to its
# count of that fill: a turn that ended clears the chip, and a turn the press
# did not reach keeps it. The host is asked in its own vocabulary as well --
# the after arm requires a settled row, the before arm requires one still owed
# a reply -- so a chip that cleared for a reason other than the press cannot
# pass for the press working.
#
# THE AIM IS DERIVED, not guessed: the bar is centred at the composer card's
# measure under the card, and the stop is its trailing child, so the press
# lands one spacing step in from the card's right edge at the middle of the
# authored bar height. Both arms press the same derived point, at the same
# window size, against the same tokens; only the executable differs. The before
# arm then presses the composer's own stop chord, which proves the turn was
# alive and stoppable at that moment, so the nothing that happened belongs to
# the word rather than to the turn.
#
# NOT RECORDED HERE: which phases offer the stop at all, and the composer's own
# control and chord, which the surface suite
# `a-turn-parked-on-a-decision-can-still-be-stopped` sweeps over every variant
# of `TurnPhase`; and what the host does with the stop it receives, which the
# coding-agent suites own.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where The Queue Is ──────────────────────────────────────────────────────
# The queue is 256px wide beside the transcript, and collapses below it at the
# minimum width, where this scene has no row to read.
if [ "${WIN_W}" -le 800 ]; then
	abandon_take "queue-beside-transcript" \
		"the queue is collapsed at ${WIN_W}px, so no row is on screen to read the turn from"
fi
QUEUE_CROP="${RAIL_W}x$(( WIN_H - TITLEBAR_H ))+${WIN_X}+$(( WIN_Y + TITLEBAR_H ))"

# The chip is a small pill: a 20px-tall fill a few dozen pixels wide, measured
# at 1085 pixels of tint over this crop while a turn ran. A rail of prose is
# not silent at this fuzz -- a frame with no chip in it measured 250 -- so the
# floor sits between the two, and the arms also read the take's own chip, since
# a chip that shrank is not a chip that cleared.
CHIP_MIN_FILL=600
CHIP_CLEARED_FRACTION=3

chip_pixels() { # <shot> -> pixels of the working fill in the queue
	working_tint_pixels "${SCENE_OUT}/${SCENE_NAME}-$1.png" "${QUEUE_CROP}"
}

# ─── The Session The Turn Runs On ────────────────────────────────────────────
STOPPED_SESSION="$(python3 - <<'PY'
import json
import os
from pathlib import Path

print(json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text()))
PY
)"
if [ -z "${STOPPED_SESSION}" ]; then
	abandon_take "the-session-is-named" "the preamble recorded no created session, so no row can be read"
fi

# What the host says about that row, polled until it settles or the deadline
# passes. A reading is printed either way: a timeout is a reading too, and the
# before arm is written around one.
host_row() { # <seconds> -> "status=<s> messages=<n>"
python3 - "${STOPPED_SESSION}" "$1" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
wanted = sys.argv[1]
deadline = time.monotonic() + float(sys.argv[2])
# A turn that ended is one of these, whichever way it ended. `Pending` is the
# row still owed a reply, which is what a turn nothing stopped leaves.
settled = {"Complete", "Interrupted", "Aborted", "Error"}
last = "status=none messages=0"

while True:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(5.0)
            connection.connect(str(endpoint))
            connection.sendall(b'{"id":1,"action":"ListSessions"}\n')
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("Missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Sessions" not in snapshot:
                        continue
                    sessions, _errors = snapshot["Sessions"]
                    row = next((entry for entry in sessions["value"] if entry["id"] == wanted), None)
                    if row is None:
                        last = "status=missing messages=0"
                        break
                    last = f"status={row.get('status')} messages={row.get('message_count', 0)}"
                    if row.get("status") in settled:
                        print(last)
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = f"status=unreadable messages=0 ({error})"
    if time.monotonic() >= deadline:
        print(last)
        raise SystemExit(0)
    time.sleep(0.2)
PY
}

# ─── The Model The Turn Runs On ──────────────────────────────────────────────
# Named rather than left at whatever the composer starts on: a prompt submitted
# with no model chosen is a turn the provider ends as an abort, which is the
# state this scene is trying to tell apart from a stop.
PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
PICKER_CLOSED="${PROBE_DIR}/run-bar-picker-closed.png"
probe_frame "${PICKER_CLOSED}"
move_px "${MODEL_CHIP_X}" "${MODEL_CHIP_Y}"
pause 0.3
click
pause 0.8
PICKER="$(screen_differs_from_frame_pixels_at "${PICKER_CLOSED}" "${WINDOW_CROP}")"
if [ "${PICKER}" -lt 20000 ]; then
	abandon_take "model-picker-open" \
		"a press on the model chip changed ${PICKER} pixels of the window, under the 20000 an overlay of model rows draws, so the keys after it would land in the composer"
fi
t "local/qwen2.5-1.5b"
pause 0.6
k "Return"
pause 0.8

# ─── A Turn Still Generating When The Press Lands ────────────────────────────
# A counting verb, digits, and an answer asked for in the reply keep it a
# single prose turn: this model drifts into repetition when asked for words,
# which the runtime's loop detector reads as a stalled stream and ends in
# `Error`. The count is long enough that the before arm's turn is still
# generating a quarter of a minute after the press it ignored.
RUNNING_PROMPT="Count from 1 to 900 in your reply, one number per line as digits, and nothing else. Do not use tools."
submit_prompt "${RUNNING_PROMPT}"

# The pointer waits in the composer until the press: a pointer resting on the
# run bar reveals the control's own hover fill, which would move the crop by
# itself between the running frame and the pressed one.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# A submit the host accepted is not yet a turn that has produced anything, and
# a press that lands before the first token stops nothing worth photographing.
transcript_region
BEFORE_FIRST_TOKEN="${PROBE_DIR}/run-bar-before-first-token.png"
probe_frame "${BEFORE_FIRST_TOKEN}"
STREAMED=0
for _ in $(seq 1 180); do
	if [ "$(screen_differs_from_frame_per_mille "${BEFORE_FIRST_TOKEN}")" -ge 4 ]; then
		STREAMED=1
		break
	fi
	sleep 1
done
if [ "${STREAMED}" -ne 1 ]; then
	abandon_take "the-turn-is-generating" \
		"the host accepted the turn but nothing streamed into the transcript within 180s, so there is no turn to stop"
fi

pause 1.5
composer_band_region
shot turn-running
RUNNING_CHIP="$(chip_pixels turn-running)"
# Both arms must reach this state, since it is the state before the press. An
# arm that photographs no running turn has nothing to say about stopping one.
if [ "${RUNNING_CHIP}" -lt "${CHIP_MIN_FILL}" ]; then
	abandon_take "the-row-reports-the-running-turn" \
		"the queue drew ${RUNNING_CHIP} pixels of working tint while a turn was streaming, under the ${CHIP_MIN_FILL} a chip fills"
fi

# ─── The Press, On The Word The Bar States ───────────────────────────────────
echo "scene: pressing the run bar's stop at ${RUN_BAR_STOP_X},${RUN_BAR_Y}" >&2
move_px "${RUN_BAR_STOP_X}" "${RUN_BAR_Y}"
pause 0.4
click
settle 3
shot stop-clicked
CLICKED_CHIP="$(chip_pixels stop-clicked)"
CLICKED_ROW="$(host_row 20)"

# ─── The Same Row, Fifteen Seconds Later ─────────────────────────────────────
# Longer than any clear the host schedules, so a chip that cleared slowly is
# not published as one that never cleared, and a chip that is still there is
# there for good.
sleep 15
settle 2
shot stop-settled
SETTLED_CHIP="$(chip_pixels stop-settled)"
SETTLED_ROW="$(host_row 2)"

echo "scene: working tint ${RUNNING_CHIP} running -> ${CLICKED_CHIP} pressed -> ${SETTLED_CHIP} settled;" \
	"the host says ${CLICKED_ROW}, and ${SETTLED_ROW} fifteen seconds later" >&2

if [ "${ARM}" = "before" ]; then
	if [ "${CLICKED_CHIP}" -lt "${CHIP_MIN_FILL}" ] || [ "${SETTLED_CHIP}" -lt "${CHIP_MIN_FILL}" ]; then
		abandon_take "the-turn-outlived-the-press" \
			"the row cleared its working chip (${CLICKED_CHIP} then ${SETTLED_CHIP} pixels of tint against the ${RUNNING_CHIP} the running turn drew), so something stopped the turn and this arm is not the before one"
	fi
	case "${SETTLED_ROW}" in
		"status=Pending "*) ;;
		*)
			abandon_take "the-row-is-still-owed-a-reply" \
				"the host says ${SETTLED_ROW} after the press, so the turn ended and this arm is not the before one"
			;;
	esac
	# The turn was alive and stoppable while the word was pressed: the chord
	# ends it now, from the same window, on the same turn. Without this the
	# nothing above could be a turn that was never stoppable rather than a word
	# that was never a control.
	#
	# The chord is composer-scope, and the press above landed outside the
	# composer, so the editor is clicked back into focus first: a chord that
	# reached no scope would report the same nothing as a turn that could not
	# be stopped.
	move_px "${COMPOSER_X}" "${COMPOSER_Y}"
	pause 0.3
	click
	pause 0.5
	k "ctrl+period"
	CHORD_ROW="$(host_row 30)"
	case "${CHORD_ROW}" in
		"status=Aborted "*|"status=Interrupted "*) ;;
		*)
			abandon_take "the-turn-was-stoppable-all-along" \
				"the composer's stop chord left the row at ${CHORD_ROW}, so this take cannot say the press on the word was what did nothing"
			;;
	esac
	echo "scene: before arm -- the word the bar states answered the press with nothing, and the chord that is a control ended the same turn (${CHORD_ROW})" >&2
else
	if [ "${CLICKED_CHIP}" -ge "${CHIP_MIN_FILL}" ] || [ "${SETTLED_CHIP}" -ge "${CHIP_MIN_FILL}" ]; then
		abandon_take "the-turn-went-with-the-press" \
			"the row still draws a working chip (${CLICKED_CHIP} then ${SETTLED_CHIP} pixels of tint against the ${RUNNING_CHIP} the running turn drew), so the press did not stop the turn"
	fi
	if [ "$(( SETTLED_CHIP * CHIP_CLEARED_FRACTION ))" -ge "${RUNNING_CHIP}" ]; then
		abandon_take "the-chip-cleared-rather-than-shrank" \
			"the row is at ${SETTLED_CHIP} of the ${RUNNING_CHIP} pixels of tint the running turn drew, which is a chip that got smaller rather than one that went"
	fi
	case "${SETTLED_ROW}" in
		"status=Aborted "*) ;;
		*)
			abandon_take "the-turn-ended-on-the-press" \
				"the host says ${SETTLED_ROW} after the press, against the aborted row a stop leaves"
			;;
	esac
	echo "scene: after arm -- the press on the run bar's stop ended the turn, and the row settled on it" >&2
fi
