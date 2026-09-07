#!/usr/bin/env bash
# Drive the native GPUI desktop front end window and capture composer interactions.
#
# Records visual evidence for:
#   1. idle (composer in initial idle state)
#   2. typed-draft (draft text typed into composer)
#   3. model-picker-open (model picker palette overlay open)
#   4. model-picker-dismissed (model picker dismissed; draft retained in composer)
#   5. slash-palette-open (slash commands palette overlay open)
#   6. slash-palette-dismissed (slash palette dismissed)
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT,
# and SCENE_LIB already initialized.

set -euo pipefail

# ─── Bounded Window Readiness Check ──────────────────────────────────────────
# Ensure the mapped GPUI desktop window is viewable on the container-private display.
READY=0
for _ in $(seq 1 40); do
	if [ -n "${SCENE_WINDOW:-}" ] && xwininfo -id "${SCENE_WINDOW}" 2>/dev/null | grep -q "Map State: IsViewable"; then
		READY=1
		break
	fi
	sleep 0.25
done

if [ "${READY}" != "1" ]; then
	abandon_take "native-window-viewable" "native desktop window (${SCENE_WINDOW:-none}) was not viewable within 10s"
fi

# Wait for host state without resending an interaction.
native_session_ready() {
python3 - "$1" "${2:-2}" <<'PY'
import json
import os
from pathlib import Path
import socket
import time
import sys

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
baseline_path = Path(os.environ["SCENE_RUNTIME_DIR"]) / "sessions-before.json"
mode = sys.argv[1]
minimum_messages = int(sys.argv[2])
baseline = set(json.loads(baseline_path.read_text())) if mode != "before" else set()
created_path = Path(os.environ["SCENE_RUNTIME_DIR"]) / "created-session.json"
created_id = json.loads(created_path.read_text()) if mode == "finished" else None
deadline = time.monotonic() + (90 if mode == "finished" else 10)
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
                    if "Sessions" in snapshot:
                        sessions, errors = snapshot["Sessions"]
                        if errors:
                            raise RuntimeError("Host session listing reported errors")
                        identities = {session["id"] for session in sessions["value"]}
                        if mode == "before":
                            baseline_path.write_text(json.dumps(sorted(identities)))
                            print("native host returned its session snapshot")
                            raise SystemExit(0)
                        if mode == "created" and identities - baseline:
                            created_path.write_text(json.dumps(next(iter(identities - baseline))))
                            print("native session-creation interaction reached the host")
                            raise SystemExit(0)
                        if mode == "finished":
                            current = next((row for row in sessions["value"] if row["id"] == created_id), None)
                            last_error = (
                                f"session status={current.get('status')}, messages={current.get('message_count', 0)}"
                                if current else "created session missing from host snapshot"
                            )
                            if current and current.get("status") in {"Error", "Aborted", "Interrupted"}:
                                with Path(current["path"]).open() as transcript:
                                    for entry_line in transcript:
                                        entry = json.loads(entry_line)
                                        message = entry.get("message", {})
                                        if message.get("role") == "assistant" and message.get("errorMessage"):
                                            print(f"Native provider error: {message['errorMessage']}", file=sys.stderr)
                                raise SystemExit(f"Native turn ended with status {current['status']}")
                            if current and current.get("message_count", 0) >= minimum_messages and current.get("status") == "Complete":
                                print("native turn completed with persisted transcript messages")
                                raise SystemExit(0)
                        break
    except (OSError, ValueError, RuntimeError) as error:
        last_error = str(error)
    time.sleep(0.1)
raise SystemExit(f"Native session readiness timed out ({mode}): {locals().get('last_error', 'no new session')}")
PY
}
if ! native_session_ready before; then
	abandon_take "native-host-ready" "native host returned no session snapshot within 10s"
fi

# Establish input focus on the native window on this private display.
xdotool windowfocus --sync "${SCENE_WINDOW}"

# ─── Scene Interactions & Captures ───────────────────────────────────────────

# 1. Start a fresh session (primary-n -> ctrl+n) and capture composer idle state.
k "ctrl+n"
if ! native_session_ready created; then
	abandon_take "native-session-created" "native session-creation interaction produced no session within 10s"
fi
pause 2.0
COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + WIN_H - 98 ))
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
pause 0.5
shot idle

# 2. Type a realistic draft into the composer.
t "Summarize the project structure."
pause 1.2
shot typed-draft

# 3. Open the model picker overlay (primary-shift-m -> ctrl+shift+m).
k "ctrl+shift+m"
pause 0.8
shot model-picker-open

# 4. Dismiss the model picker (escape); verify the typed draft is retained.
k "Escape"
pause 0.8
shot model-picker-dismissed

# Exercise enter, exit, and reversal continuously rather than grading idle frames as motion.
for _ in $(seq 1 24); do
	k "ctrl+shift+m"
	pause 0.2
	k "Escape"
	pause 0.2
done

# 5. Clear the composer and open the slash command palette.
# In Editor context, ctrl+a selects all, backspace deletes.
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.4
t "/"
pause 0.8
shot slash-palette-open

# 6. Dismiss the slash palette (escape).
k "Escape"
pause 0.8
shot slash-palette-dismissed
