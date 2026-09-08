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

# ─── What The Window Sheds At This Width ─────────────────────────────────────
# Every desktop scene crops by region, and where a region IS depends on the
# breakpoint row the window's width resolves to: the rail is 256, 208 or gone,
# and the panel is a column of 540 or 360 or a float over the session surface.
# The rows are read from the token files this checkout ships rather than
# restated here, so a scene recorded at a new width crops what the product
# actually drew instead of what one width happened to make true.
read -r RAIL_W PANEL_MODE PANEL_W DRAWER_PLACEMENT LABELS COMPOSER_MAX_W GUTTER_PX SHEET_INSET COMPOSER_BAND_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" "${WIN_W}" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
width = float(sys.argv[2])
surface = tomllib.loads((tokens / "surface" / "breakpoints.toml").read_text())
panels = tomllib.loads((tokens / "surface" / "panels.toml").read_text())["right_panel"]
composer_tokens = tomllib.loads((tokens / "surface" / "composer.toml").read_text())
composer = composer_tokens["geometry"]
# §5.4 measures the composer against the session surface it sits in, insetting
# it by one spacing step on each side. Both numbers are authored, so the scene
# reads them rather than deciding what a card should measure.
scale = tomllib.loads((tokens / "scale.toml").read_text())
gutter = scale["spacing"]["s4"]
# A float draws as a sheet, which frames its body with one spacing step and a
# hairline on every side; a column has no such frame. Every crop of an
# overlaid panel starts inside it.
sheet = scale["spacing"]["s4"] + scale["stroke"]["hairline"]
# A floor on the band the composer owns at the window's lower edge: the card's
# authored minimum, the gap under it, the run bar, and the column's own bottom
# padding. `rest_height_px` is a minimum rather than a measure, and the card
# draws taller than it -- 86px at rest against an authored 70 at scale 1, since
# the editor line, the footer row and the card's padding are what decide it --
# so this number lies strictly inside the card. A crop of the band therefore
# omits its topmost rows, and a crop of the transcript above it takes a few of
# the card's; both are conservative for a float that is entitled to the
# transcript and nothing under it, which a generous band would read as a panel
# drawn over the draft.
band = (
    composer["rest_height_px"]
    + scale["spacing"]["s3"]
    + composer_tokens["run_bar"]["height_px"]
    + scale["spacing"]["s3"]
)

rows = sorted(surface["breakpoint"].values(), key=lambda row: row["min_width_px"])
row = rows[0]
for candidate in rows:
    if width >= candidate["min_width_px"]:
        row = candidate

rail = row["queue_width_px"]
share = width * panels["max_viewport_ratio"]
overlay = max(min(panels["default_width_px"], share), min(panels["min_width_px"], width))
mode = row["right_panel_mode"]
if mode.startswith("inline_"):
    asked = float(mode.removeprefix("inline_"))
    ceiling = width - rail - panels["container_margin_px"]
    inline = min(asked, share, ceiling)
    if inline < panels["min_width_px"]:
        placement, panel = "overlay", overlay
    else:
        placement, panel = "inline", inline
else:
    placement, panel = "overlay", overlay

print(
    int(rail),
    placement,
    int(panel),
    row["terminal_drawer_placement"],
    "labels" if row["composer_footer_labels"] else "no-labels",
    int(composer["max_width_px"]),
    int(gutter),
    int(sheet) if placement == "overlay" else 0,
    int(band),
)
PY
)
if [ -z "${PANEL_MODE:-}" ]; then
	abandon_take "the-shed-is-known" "no breakpoint row resolved for a ${WIN_W}px window"
fi
echo "scene: ${WIN_W}px sheds to rail ${RAIL_W}px, panel ${PANEL_MODE} ${PANEL_W}px," \
	"drawer ${DRAWER_PLACEMENT}, ${LABELS}" >&2

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
