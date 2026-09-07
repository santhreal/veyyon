#!/usr/bin/env bash
# Drive a real running turn in the native GPUI window and photograph what the
# composer offers while it runs: steer, queue, the queued follow-up, and abort.
#
# Records visual evidence for:
#   1. turn-running-steer      (the turn running, primary action Steer)
#   2. turn-running-queue      (the same turn after `primary-/`, primary Queue)
#   3. turn-queued-followup    (a follow-up submitted behind the running turn)
#   4. turn-queue-taken-back   (the same follow-up returned to the draft by alt+Up)
#   5. turn-aborted            (the turn stopped by `primary-.`)
#
# Frames 1 and 2 are a differential of one state: the run bar's primary action is
# the whole difference, so a single frame of a running turn proves nothing about
# the mode. Frames 3 and 4 are the queue the operator can read and the way back
# out of it, each compared against the frame before it, and frame 5 ends the run.
#
# The turn is REAL. The prompt asks the local model for output long enough to
# still be generating while the frames are taken, the queued follow-up reaches
# the host as a queued prompt, and the abort ends the turn the host is running.
# Nothing here fabricates a phase, and nothing here trusts one either: frame 1
# waits for the answer to start landing in the transcript, because a submit the
# host has accepted is not yet a turn the composer draws as running, and the
# pair is then compared over the run bar so a mode swap that moved no pixels
# ends the take instead of publishing two frames of an idle composer.
#
# Sourced state comes from desktop-composer.sh: the helpers, a created session
# and its composer frames. This scene adds the model selection it needs, since a
# turn cannot run without one.

set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# Wait for one of the created session's own states, read from the host rather
# than from the window: a frame taken on a guess photographs whatever the shell
# happened to be drawing. `started` waits for the user message the submission
# persists, `settled` for a terminal status.
native_turn_state() {
python3 - "$1" "${2:-30}" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created_path = Path(os.environ["SCENE_RUNTIME_DIR"]) / "created-session.json"
created_id = json.loads(created_path.read_text())
mode = sys.argv[1]
deadline = time.monotonic() + float(sys.argv[2])
settled = {"Complete", "Interrupted", "Aborted", "Error"}
last = "no host frame"
while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(b'{"id":1,"action":"ListSessions"}\n')
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("Missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Sessions" not in snapshot:
                        continue
                    sessions, errors = snapshot["Sessions"]
                    if errors:
                        raise RuntimeError("Host session listing reported errors")
                    row = next(
                        (entry for entry in sessions["value"] if entry["id"] == created_id),
                        None,
                    )
                    if row is None:
                        last = "created session missing from host snapshot"
                        break
                    last = f"status={row.get('status')}, messages={row.get('message_count', 0)}"
                    if mode == "started" and row.get("message_count", 0) >= 1:
                        print(f"native turn reached the host ({last})")
                        raise SystemExit(0)
                    if mode == "settled" and row.get("status") in settled:
                        print(f"native turn settled ({last})")
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.1)
raise SystemExit(f"Native turn state timed out ({mode}): {last}")
PY
}

# The composer draws `Running` from the moment the host STREAMS, which is later
# than the persisted user message `started` waits for. Under the software
# renderer this model's first token arrived seconds after the submit reached
# the host, and the take that motivated this guard photographed an idle
# composer under both mode names: same up-arrow send button in each, one
# differential of nothing. Streaming frames go to the socket running the turn,
# so no second connection can ask; the observable is the transcript column
# repainting as the answer lands under the prompt.
streamed_into_the_transcript() { # <baseline-png> <ceiling-seconds>
	local baseline="$1" ceiling="${2:-180}" waited=0 moved
	while [ "${waited}" -lt "${ceiling}" ]; do
		moved="$(screen_differs_from_frame_per_mille "${baseline}")"
		if [ "${moved}" -ge "${STREAMED_PER_MILLE}" ]; then
			echo "scene: the transcript repainted ${moved} per mille after ${waited}s, so the turn is generating" >&2
			return 0
		fi
		sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# The two rectangles this scene compares over, in root coordinates. The sidebar
# is outside both: it prints each session's age, so it differs a second later
# whatever the surface under test did.
SIDEBAR_W=$(( WIN_W > 800 ? 256 : 0 ))
COMPOSER_H=140
transcript_crop() {
	use_crop \
		$(( WIN_X + SIDEBAR_W )) \
		$(( WIN_Y + 48 )) \
		$(( WIN_W - SIDEBAR_W )) \
		$(( WIN_H - 48 - COMPOSER_H ))
}
run_bar_crop() {
	use_crop \
		$(( WIN_X + SIDEBAR_W )) \
		$(( WIN_Y + WIN_H - COMPOSER_H )) \
		$(( WIN_W - SIDEBAR_W )) \
		"${COMPOSER_H}"
}
# The composer grows upward once it lists what the session is holding, so the
# queued frames are compared over a taller strip than the run bar's own.
QUEUED_H=240
queued_crop() {
	use_crop \
		$(( WIN_X + SIDEBAR_W )) \
		$(( WIN_Y + WIN_H - QUEUED_H )) \
		$(( WIN_W - SIDEBAR_W )) \
		"${QUEUED_H}"
}
# A streamed line of words repaints far more than the renderer's own noise,
# which two settled frames of one state measure at a couple of pixels per
# thousand.
STREAMED_PER_MILLE=4
# §5.4 draws ONE up arrow in every turn state: the mode changes what the
# control does and what it is called, never its shape. So the differential is
# the control's own name, read where an operator reads it -- hovering the arrow
# -- and the pair is compared over the composer strip that holds the tooltip.
# A word of it is some hundreds of pixels against a renderer noise floor of a
# few dozen over the same crop.
MODE_NAME_PIXELS=300
# A queued prompt is a count row and a line of its own text, which is a few
# hundred pixels of ink over the same crop that measures a few dozen between
# two settled frames of one state.
QUEUED_STRIP_PIXELS=300
COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + WIN_H - 98 ))
# The up arrow, at the trailing edge of the composer's own column: the right
# panel takes the trailing 356px above 980px of window (§5.6), and the control
# is one 28px square and its gap in from that edge.
PRIMARY_X=$(( WIN_X + (WIN_W > 980 ? WIN_W - 356 : WIN_W) - 43 ))
PRIMARY_Y=$(( WIN_Y + WIN_H - 67 ))

# ─── The model the turn runs on ──────────────────────────────────────────────
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
k "BackSpace"
k "ctrl+shift+m"
pause 0.4
t "local/qwen2.5-1.5b"
pause 0.5
k "Return"
pause 0.5

# ─── A turn that is still running when the shutter opens ─────────────────────
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
t "Count from one to two hundred, writing each number on its own line as an English word. Do not call tools."
k "Return"
if ! native_turn_state started 30; then
	abandon_take "native-turn-started" "the submitted prompt never reached the host as a persisted turn"
fi
transcript_crop
BASELINE="${SCENE_RUNTIME_DIR}/before-the-first-token.png"
probe_frame "${BASELINE}"
if ! streamed_into_the_transcript "${BASELINE}" 180; then
	abandon_take "native-turn-generating" \
		"the host accepted the turn but nothing streamed into the transcript within 180s, so the composer was still idle"
fi
# The pointer rests on the arrow for both arms, which is where its name is
# readable. Hovering takes no focus, so the chord between the two shots still
# reaches the composer.
move_px "${PRIMARY_X}" "${PRIMARY_Y}"
pause 1.2
shot turn-running-steer

# ─── The same run, in queue mode (primary-/) ─────────────────────────────────
k "ctrl+slash"
pause 1.2
shot turn-running-queue

# The pair is one differential and the control's name is the whole of it, so
# the swap is asserted here. The crop is the composer strip alone: the
# transcript above is still streaming, so a whole-frame comparison would differ
# by pages of numbers whatever the chord did.
run_bar_crop
MODE_MOVED="$(shots_differ_pixels turn-running-steer turn-running-queue)"
echo "scene: the composer moved ${MODE_MOVED} pixels between the two modes" >&2
if [ "${MODE_MOVED}" -lt "${MODE_NAME_PIXELS}" ]; then
	abandon_take "native-queue-mode-differential" \
		"the control's name moved ${MODE_MOVED} pixels after primary-/, which is renderer noise rather than a mode the operator can read"
fi

# ─── A follow-up submitted behind the running turn ───────────────────────────
# The prompt leaves the draft and the composer lists it, so the queued frame
# differs from the frame of the same running turn holding nothing. Comparing
# the two is what separates a queue the operator can read from a prompt that
# vanished into the runtime.
t "Then say the word done."
pause 0.4
k "Return"
pause 1.2
shot turn-queued-followup
queued_crop
QUEUED_MOVED="$(shots_differ_pixels turn-running-queue turn-queued-followup)"
echo "scene: the composer moved ${QUEUED_MOVED} pixels when the prompt was queued" >&2
if [ "${QUEUED_MOVED}" -lt "${QUEUED_STRIP_PIXELS}" ]; then
	abandon_take "native-queued-prompt-stated" \
		"the queued prompt moved ${QUEUED_MOVED} pixels, which is renderer noise rather than a prompt the operator can read"
fi

# ─── The queued prompt taken back (alt+Up) ───────────────────────────────────
k "alt+Up"
pause 1.2
shot turn-queue-taken-back
TAKEN_BACK="$(shots_differ_pixels turn-queued-followup turn-queue-taken-back)"
echo "scene: the composer moved ${TAKEN_BACK} pixels when the prompt was taken back" >&2
if [ "${TAKEN_BACK}" -lt "${QUEUED_STRIP_PIXELS}" ]; then
	abandon_take "native-queued-prompt-taken-back" \
		"alt+Up moved ${TAKEN_BACK} pixels, so the queued prompt did not return to the draft"
fi

# ─── The way out (primary-.) ─────────────────────────────────────────────────
k "ctrl+period"
if ! native_turn_state settled 60; then
	abandon_take "native-turn-aborted" "the abort chord left the host still running the turn"
fi
pause 1.0
shot turn-aborted
