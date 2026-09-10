#!/usr/bin/env bash
# Start a real turn in the native GPUI window, leave it behind by creating
# another session while it streams, and photograph what the queue says about
# the session that was left.
#
# Records visual evidence for:
#   1. turn-running      (the row of the session whose turn is running)
#   2. left-behind       (the same row, a new session on screen over it)
#   3. left-behind-still (the same row again, fifteen seconds later)
#
# THE PAIR IS TWO HOSTS, not two settings. One client holds one `AgentSession`,
# so creating a session reloads that session in place and the turn in flight
# cannot survive it. `AgentSession` ended it on its own, but as an internal
# abort taken after the agent was already disconnected: no `message_end`
# reached the GUI host's listeners, so the reply the model had produced was
# appended nowhere, `StreamingChanged` was never cleared, and the file trailed
# a prompt with no reply after it -- which the session index reports as
# `Pending`, and the queue draws as a `Working` chip counting up for a turn
# that is over. Both arms run this same scene; the host is the differential.
#
#   proof/docker/record-native.sh proof/scenes/desktop-abandoned-stream.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=02902457aa^ \
#     proof/docker/record-native.sh proof/scenes/desktop-abandoned-stream.sh
#
# The change is the GUI host's alone, so the before arm needs no build of its
# own: the recorder holds the host's own source back to the commit before the
# fix and runs this tree's executable against it.
#
# WHAT IS MEASURED. `[tint.working]` is the fill the `Working` chip paints and
# nothing else in the window paints it, so each frame is reduced to its count
# of that fill inside the queue crop. A frame difference alone cannot separate
# the chip from the row's own elapsed time, which ticks between any two frames.
# The reading is taken three times: while the turn is genuinely running, which
# both arms must show a chip for, immediately after the gesture, and fifteen
# seconds later -- so a chip that was merely slow to clear is not published as
# one that never clears.
#
# The queue is not the only place the turn was left. The host is asked, in its
# own vocabulary, what the abandoned session's row now says: the after arm
# requires a settled status and the reply counted in the file, and the before
# arm requires the row still owed a reply it will never get.
#
# The turn is REAL. The prompt asks the local model for a long enough answer
# that it is still generating when the session is created under it, and the
# session that is created is created the way an operator creates one.
#
# NOT RECORDED HERE: the other ten actions that leave a session while a turn
# runs, and the order the clear has to arrive in, which
# `packages/coding-agent/test/gui-host/a-turn-the-desktop-leaves-behind-is-ended-and-stated.test.ts`
# sweeps over every action the host registers; and the window's own drawing of
# a cleared stream, which the transcript surface owns.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where The Queue Is ──────────────────────────────────────────────────────
# The queue is 256px wide beside the transcript, and collapses below it at the
# minimum width, where this scene has nothing to photograph.
if [ "${WIN_W}" -le 800 ]; then
	abandon_take "queue-beside-transcript" \
		"the queue is collapsed at ${WIN_W}px, so no row is on screen to photograph"
fi
QUEUE_CROP="${RAIL_W}x$(( WIN_H - TITLEBAR_H ))+${WIN_X}+$(( WIN_Y + TITLEBAR_H ))"

# The chip is a small pill: a 20px-tall fill a few dozen pixels wide, measured
# at 1085 pixels of tint over this crop while a turn ran. A rail of prose is
# not silent at this fuzz -- a frame with no chip in it measured 250 -- so the
# floor sits between the two rather than just above zero, and the arms also
# read the take's own chip, since a chip that shrank is not a chip that
# cleared.
CHIP_MIN_FILL=600
CHIP_CLEARED_FRACTION=3

chip_pixels() { # <shot> -> pixels of the working fill in the queue
	working_tint_pixels "${SCENE_OUT}/${SCENE_NAME}-$1.png" "${QUEUE_CROP}"
}

# ─── The Session The Turn Is Left On ─────────────────────────────────────────
# The preamble created it and named it, and this scene has to keep the name:
# the gesture below creates a second one, and every reading after it is about
# the first.
LEFT_SESSION="$(python3 - <<'PY'
import json
import os
from pathlib import Path

print(json.loads((Path(os.environ["SCENE_RUNTIME_DIR"]) / "created-session.json").read_text()))
PY
)"
if [ -z "${LEFT_SESSION}" ]; then
	abandon_take "the-session-is-named" "the preamble recorded no created session, so no row can be followed"
fi

# What the host says about that row, polled until it settles or the deadline
# passes. A reading is printed either way: a timeout is a reading too, and the
# before arm is written around one.
host_row() { # <seconds> -> "status=<s> messages=<n>"
python3 - "${LEFT_SESSION}" "$1" <<'PY'
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
# row still owed a reply, which is the state the defect leaves it in.
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
# state this scene is trying to tell apart from a real one. The picker is
# opened from its own chip, whose point the preamble derived from the tokens.
PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
PICKER_CLOSED="${PROBE_DIR}/abandoned-picker-closed.png"
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

# ─── A Turn Still Generating When The Gesture Lands ──────────────────────────
# A counting verb, digits, and an answer asked for in the reply keep it a
# single prose turn: this model drifts into repetition when asked for words,
# which the runtime's loop detector reads as a stalled stream and ends in
# `Error`, and a turn aborted inside a tool batch settles on the ledger turn
# that follows it rather than on the abort.
RUNNING_PROMPT="Count from 1 to 400 in your reply, one number per line as digits, and nothing else. Do not use tools."
submit_prompt "${RUNNING_PROMPT}"

# The pointer is parked in the composer for every frame below: a pointer over a
# queue row reveals that row's own actions, which would move the crop by itself.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# A submit the host accepted is not yet a turn that has produced anything, and
# a gesture that lands before the first token leaves nothing to lose, which is
# not the defect. The observable is the transcript column repainting as the
# answer arrives under the prompt.
transcript_region
BEFORE_FIRST_TOKEN="${PROBE_DIR}/abandoned-before-first-token.png"
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
		"the host accepted the turn but nothing streamed into the transcript within 180s, so there is no reply to leave behind"
fi

pause 1.5
shot turn-running
RUNNING_CHIP="$(chip_pixels turn-running)"
# Both arms must reach this state, since it is the state before the gesture. An
# arm that photographs no running turn has nothing to say about leaving one.
if [ "${RUNNING_CHIP}" -lt "${CHIP_MIN_FILL}" ]; then
	abandon_take "the-row-reports-the-running-turn" \
		"the queue drew ${RUNNING_CHIP} pixels of working tint while a turn was streaming, under the ${CHIP_MIN_FILL} a chip fills"
fi

# ─── Leaving It: A New Session, Over The Running Turn ────────────────────────
# The gesture an operator makes, on the chord the preamble used to make the
# first session. The wait is on the transcript emptying, which both arms do:
# the session is created either way, and what they differ on is the row left
# behind.
transcript_region
STREAMING_FRAME="${PROBE_DIR}/abandoned-streaming.png"
probe_frame "${STREAMING_FRAME}"
k "ctrl+n"
CREATED=0
for _ in $(seq 1 30); do
	if [ "$(screen_differs_from_frame_per_mille "${STREAMING_FRAME}")" -ge 40 ]; then
		CREATED=1
		break
	fi
	sleep 1
done
if [ "${CREATED}" -ne 1 ]; then
	abandon_take "the-new-session-is-on-screen" \
		"the transcript never changed after primary-n, so no session was created over the running turn"
fi

settle 3
shot left-behind
LEFT_CHIP="$(chip_pixels left-behind)"
ROW="$(host_row 20)"

# ─── The Same Row, Fifteen Seconds Later ─────────────────────────────────────
# Longer than any clear the host schedules, so a chip that cleared slowly is
# not published as one that never cleared, and a chip that is still there is
# there for good.
sleep 15
settle 2
shot left-behind-still
STILL_CHIP="$(chip_pixels left-behind-still)"
STILL_ROW="$(host_row 2)"

echo "scene: working tint ${RUNNING_CHIP} running -> ${LEFT_CHIP} left -> ${STILL_CHIP} still;" \
	"the host says ${ROW}, and ${STILL_ROW} fifteen seconds later" >&2

if [ "${ARM}" = "before" ]; then
	if [ "${LEFT_CHIP}" -lt "${CHIP_MIN_FILL}" ] || [ "${STILL_CHIP}" -lt "${CHIP_MIN_FILL}" ]; then
		abandon_take "the-chip-outlived-the-turn" \
			"the abandoned row cleared its working chip (${LEFT_CHIP} then ${STILL_CHIP} pixels of tint against the ${RUNNING_CHIP} it drew while the turn ran), so this arm did not reproduce the turn that was left running"
	fi
	if [ "$(( STILL_CHIP * 2 ))" -lt "${RUNNING_CHIP}" ]; then
		abandon_take "the-chip-is-the-same-chip" \
			"the abandoned row draws ${STILL_CHIP} pixels of tint against the ${RUNNING_CHIP} of the running turn, so it is drawing something smaller than the chip rather than the chip"
	fi
	case "${STILL_ROW}" in
		"status=Pending "*) ;;
		*)
			abandon_take "the-row-is-still-owed-a-reply" \
				"the host says ${STILL_ROW} for the abandoned session, so the turn ended after all and this arm is not the before one"
			;;
	esac
	echo "scene: before arm -- the row of the abandoned turn still reports one, and the host still owes it a reply" >&2
else
	if [ "${LEFT_CHIP}" -ge "${CHIP_MIN_FILL}" ] || [ "${STILL_CHIP}" -ge "${CHIP_MIN_FILL}" ]; then
		abandon_take "the-chip-went-with-the-turn" \
			"the abandoned row still draws a working chip (${LEFT_CHIP} then ${STILL_CHIP} pixels of tint against the ${RUNNING_CHIP} it drew while the turn ran), so the turn was left running"
	fi
	if [ "$(( STILL_CHIP * CHIP_CLEARED_FRACTION ))" -ge "${RUNNING_CHIP}" ]; then
		abandon_take "the-chip-cleared-rather-than-shrank" \
			"the abandoned row is at ${STILL_CHIP} of the ${RUNNING_CHIP} pixels of tint the running turn drew, which is a chip that got smaller rather than one that went"
	fi
	case "${STILL_ROW}" in
		"status=Aborted messages=2") ;;
		*)
			abandon_take "the-turn-ended-and-kept-its-reply" \
				"the host says ${STILL_ROW} for the abandoned session, against the settled row holding a prompt and the reply the abort kept"
			;;
	esac
	echo "scene: after arm -- the row settled the moment the session was left, and the reply is in the file it was produced in" >&2
fi
