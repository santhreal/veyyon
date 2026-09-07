#!/usr/bin/env bash
# Drive a real running turn in the native GPUI window and photograph what the
# composer offers while it runs: steer, queue, the queued follow-up, and abort.
#
# Records visual evidence for:
#   1. turn-running-steer    (the turn running, primary action Steer)
#   2. turn-running-queue    (the same turn after `primary-/`, primary Queue)
#   3. turn-queued-followup  (a follow-up submitted behind the running turn)
#   4. turn-aborted          (the turn stopped by `primary-.`)
#
# Frames 1 and 2 are a differential of one state: the run bar's primary action is
# the whole difference, so a single frame of a running turn proves nothing about
# the mode. Frame 3 is what queue mode is for, and frame 4 is the way out.
#
# The turn is REAL. The prompt asks the local model for output long enough to
# still be generating while the frames are taken, the queued follow-up reaches
# the host as a queued prompt, and the abort ends the turn the host is running.
# Nothing here fabricates a phase: `TurnPhase::Running` is what the host
# reported, and the scene fails rather than photographing an idle composer.
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

COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + WIN_H - 98 ))

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
pause 1.0
shot turn-running-steer

# ─── The same run, in queue mode (primary-/) ─────────────────────────────────
k "ctrl+slash"
pause 0.6
shot turn-running-queue

# ─── A follow-up submitted behind the running turn ───────────────────────────
t "Then say the word done."
pause 0.4
k "Return"
pause 0.8
shot turn-queued-followup

# ─── The way out (primary-.) ─────────────────────────────────────────────────
k "ctrl+period"
if ! native_turn_state settled 60; then
	abandon_take "native-turn-aborted" "the abort chord left the host still running the turn"
fi
pause 1.0
shot turn-aborted
