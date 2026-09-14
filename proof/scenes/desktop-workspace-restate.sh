#!/usr/bin/env bash
# Run one turn that edits a file and read back what the Changes pane draws
# afterwards, without asking it for anything.
#
# Records visual evidence for:
#   1. before-the-turn (the pane as the panel opens, on the operator's own edit)
#   2. after-the-turn  (the same pane once the agent has finished editing)
#
# THE CLAIM. The host answers Changes, the file tree, usage and the process
# list only when a client asks, and the desktop asks once, at the handshake.
# Every pane in the workspace panel therefore drew the repository as it stood
# before the session's first prompt, for the life of the window: a file the
# agent edited never reached the change list, and no gesture short of closing
# and reopening the panel brought it there. The host now re-states each of
# those domains when the agent goes idle. The take drives the shipped window
# against the shipped host, so the pane it photographs is the pane an operator
# gets.
#
# THE ARMS. One repository holding one file the operator modified by hand, so
# the pane is a diff before the turn begins and its ink is the scale both
# readings are judged against. The turn then rewrites every changed line of
# that same file through the agent's own tool, so a pane that re-states repaints
# its text. After, the pane differs across the turn by more than a fifth of its
# own ink. Before, it differs by under a fiftieth of it -- the same diff, of the
# lines the agent has already replaced on disk.
#
# The edit is proved on disk in both arms before either frame is read, so a
# before arm that draws nothing is a pane that did not re-state and not a turn
# that did not run.
#
# The change is entirely inside the host, which both arms share, so the before
# arm holds the source at the commit before the fix. The take is a still one --
# it opens a panel, waits out a turn and photographs two panes -- so it carries
# its own motion floor, which the gate otherwise reads as a stuttering
# pipeline:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh proof/scenes/desktop-workspace-restate.sh
#   SCENE_MOTION_FLOOR=5 SCENE_ARM=before PROOF_BASE_REF=<fix>^ \
#     proof/docker/record-native.sh proof/scenes/desktop-workspace-restate.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

# ─── One File The Operator Changed By Hand ───────────────────────────────────
# Committed, then modified, so the pane opens on a diff rather than on an empty
# list: an empty pane has no ink to judge either arm against. The ignore file
# admits the one path by name, or the sandbox home's own files are changes too
# and the pane draws more than the scene seeded.
REPO_DIR="${SCENE_CWD:-/sandbox/home/demo}"
LEDGER="ledger.rs"
# What the turn is asked to run. One short command, so a 1.5B model reproduces
# it verbatim, and one that replaces every line of the file: the diff the pane
# draws goes from six changed lines to forty added ones, which is a repaint of
# the whole column rather than of a row in it.
AGENT_COMMAND="seq 1 40 > ledger.rs"
AGENT_LINES=40

seed_one_edit() {
	printf 'fn ledger() {\nlet motif = 1;\nlet quiet = 2;\nlet raven = 3;\nlet solar = 4;\nlet tempo = 5;\n}\n' \
		>"${REPO_DIR}/${LEDGER}"
	printf '*\n!%s\n' "${LEDGER}" >"${REPO_DIR}/.gitignore"
	if [ ! -d "${REPO_DIR}/.git" ]; then
		git -C "${REPO_DIR}" init -q
	fi
	git -C "${REPO_DIR}" add -- "${LEDGER}" .gitignore
	git -C "${REPO_DIR}" \
		-c user.name=scene -c user.email=scene@example.invalid \
		commit -q -m "the lines before the turn" -- "${LEDGER}" .gitignore
	printf 'fn ledger() {\nlet motif = 11;\nlet quiet = 22;\nlet raven = 33;\nlet solar = 44;\nlet tempo = 55;\n}\n' \
		>"${REPO_DIR}/${LEDGER}"
}

seed_one_edit

STATUS="$(git -C "${REPO_DIR}" status --porcelain --untracked-files=all | sort | tr '\n' '|')"
if [ "${STATUS}" != " M ${LEDGER}|" ]; then
	abandon_take "the-pane-opens-on-one-edit" \
		"the repository reports '${STATUS}' instead of the one unstaged path the scene seeded"
fi

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

echo "scene: the composer preamble is done; ${LEDGER} is modified and unstaged" >&2

# ─── Where The Tab Strip, The Chrome Row And The Pane Draw ───────────────────
# Every rectangle comes from the token files and the panel geometry the
# composer preamble resolved, so the readings follow the shed at whatever width
# the take is recorded at.
read -r TABS_H CHROME_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

panels = tomllib.loads((Path(sys.argv[1]) / "surface" / "panels.toml").read_text())
print(int(panels["tabs"]["height_px"]), int(panels["chrome"]["row_height_px"]))
PY
)

PANEL_LEFT=$(( WIN_X + WIN_W - PANEL_W + SHEET_INSET ))
PANEL_RIGHT=$(( WIN_X + WIN_W - SHEET_INSET ))
PANEL_TOP=$(( WIN_Y + TITLEBAR_H + SHEET_INSET ))
PANEL_BOTTOM=$(( WIN_Y + WIN_H - SHEET_INSET ))
if [ "${PANEL_MODE}" = "overlay" ]; then
	PANEL_BOTTOM=$(( WIN_Y + WIN_H - COMPOSER_BAND_H - SHEET_INSET ))
fi
PANE_W=$(( PANEL_RIGHT - PANEL_LEFT ))
PANE_TOP=$(( PANEL_TOP + TABS_H + CHROME_H ))
PANE_H=$(( PANEL_BOTTOM - PANE_TOP ))
PANE_GEOM="${PANE_W}x${PANE_H}+${PANEL_LEFT}+${PANE_TOP}"
if [ "${PANE_H}" -lt 120 ]; then
	abandon_take "the-pane-holds-a-diff" "the pane is ${PANE_H}px tall, too short to draw a diff"
fi
use_crop "${PANEL_LEFT}" "${PANE_TOP}" "${PANE_W}" "${PANE_H}"

echo "scene: the pane reads ${PANE_GEOM}" >&2

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The pane is drawn when two probes a moment apart are the same over it: its
# rows arrive on a host answer rather than on the gesture that asked for them.
wait_for_pane() { # <what>
	local settled=0
	for _ in $(seq 1 30); do
		probe_frame "${PROBE_DIR}/pane-a.png"
		pause 0.5
		probe_frame "${PROBE_DIR}/pane-b.png"
		if [ "$(frames_differ_pixels_at "${PROBE_DIR}/pane-a.png" "${PROBE_DIR}/pane-b.png" "${PANE_GEOM}")" -lt 40 ]; then
			settled=1
			break
		fi
		pause 0.5
	done
	if [ "${settled}" != "1" ]; then
		abandon_take "$1" "the pane never stopped repainting"
	fi
}

# How much of the pane is ink: pixels whose colour is not the pane's own
# ground. This is the scale both arms are judged against, so a pane that drew
# nothing cannot pass either reading by being empty.
pane_ink() { # <png>
	local dump="${PROBE_DIR}/pane-pixels.txt"
	magick "$1" -crop "${PANE_GEOM}" +repage txt:- >"${dump}"
	python3 - "${dump}" <<'PY'
import collections
import re
import sys

pixel = re.compile(r"^\d+,\d+: \([^)]*\)\s+(#[0-9A-Fa-f]+)")
colours = []
with open(sys.argv[1], encoding="ascii") as dump:
    for line in dump:
        match = pixel.match(line)
        if match:
            colours.append(match.group(1))

if not colours:
    print(0)
    raise SystemExit(0)

ground = collections.Counter(colours).most_common(1)[0][0]
print(sum(1 for colour in colours if colour != ground))
PY
}

# The model answers a shell request by backgrounding the command, so the
# command's output arrives after the turn that asked for it: the job's result
# re-wakes the loop, and that is a second turn with its own idle. The scene
# waits for the last of them -- the session Complete and its transcript no
# longer growing -- so the frame is read after the workspace has stopped
# changing rather than between two turns that change it.
native_agent_quiet() {
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text())
deadline = time.monotonic() + 240
quiet_for = 8.0
last_shape = None
quiet_since = None
last = "no session snapshot"
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
                        raise RuntimeError("missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Sessions" not in snapshot:
                        continue
                    sessions, errors = snapshot["Sessions"]
                    if errors:
                        raise RuntimeError("host session listing reported errors")
                    row = next((r for r in sessions["value"] if r["id"] == created), None)
                    if not row:
                        raise RuntimeError("created session missing from host snapshot")
                    last = f"status={row.get('status')}, messages={row.get('message_count', 0)}"
                    if row.get("status") in {"Error", "Aborted"}:
                        raise SystemExit(f"native turn ended with status {row['status']}")
                    shape = (row.get("status"), row.get("message_count", 0), Path(row["path"]).stat().st_size)
                    if shape != last_shape or row.get("status") != "Complete":
                        last_shape = shape
                        quiet_since = time.monotonic() if row.get("status") == "Complete" else None
                    elif quiet_since is not None and time.monotonic() - quiet_since >= quiet_for:
                        print(f"native session went quiet ({last})")
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError):
        quiet_since = None
    time.sleep(0.5)
raise SystemExit(f"the session never went quiet within 240s ({last})")
PY
}

# ─── The Panel Opens On The Changes Tab ──────────────────────────────────────
# Opening the panel is what asks the host for the working tree's changes, and
# it is the only time anything asks. The leftmost tab is clicked rather than
# trusting the tab the window opens on, which is the one it was last left in.
k "ctrl+backslash"
pause 1.2
move_px "$(( PANEL_LEFT + 40 ))" "$(( PANEL_TOP + TABS_H / 2 ))"
pause 0.3
click
pause 1.0
wait_for_pane "the-pane-is-drawn"

shot before-the-turn
INK="$(pane_ink "${SCENE_OUT}/${SCENE_NAME}-before-the-turn.png")"
if [ "${INK}" -lt 2000 ]; then
	abandon_take "before-the-turn" "the pane carried ${INK}px of ink, too little to be a diff"
fi
echo "scene: the pane before the turn carries ${INK}px of ink" >&2

# ─── A Turn That Edits The File The Pane Is Drawing ──────────────────────────
# The model is named rather than inherited, so the take runs on the local
# tool-calling model the recorder ships and not on whatever the profile was
# last left on.
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

submit_prompt "run this shell command for me with your bash tool: ${AGENT_COMMAND}"

# A turn is over when the host has recorded the tool call and its result and
# the session index reports the turn Complete, and it is over for this scene
# only once the file on disk holds what the tool was asked to write. All of it
# is read from the host and the repository, never from the pixels: the pane
# not repainting is the defect under test, so it cannot also be the signal
# that the turn ended.
if ! native_tool_call_recorded; then
	abandon_take "the-turn-called-a-tool" "the submitted turn recorded no completed tool call within 240s"
fi
if ! native_session_ready finished 2; then
	abandon_take "the-turn-settled" "the turn that edited the file never reached Complete within 90s"
fi
if ! native_agent_quiet; then
	abandon_take "the-session-went-quiet" \
		"the session kept writing its transcript for 240s, so no frame reads a workspace that stopped changing"
fi

# The workspace really changed, in both arms: the pane is being read against a
# repository whose file the agent rewrote.
WROTE="$(wc -l <"${REPO_DIR}/${LEDGER}")"
if [ "${WROTE}" != "${AGENT_LINES}" ] || [ "$(tail -n 1 "${REPO_DIR}/${LEDGER}")" != "${AGENT_LINES}" ]; then
	abandon_take "the-turn-edited-the-file" \
		"${LEDGER} holds ${WROTE} line(s), not the ${AGENT_LINES} the turn was asked to write, so neither arm has anything to re-state"
fi
echo "scene: the turn rewrote ${LEDGER}; nothing has asked the host for the changes since the panel opened" >&2

wait_for_pane "the-pane-settles-after-the-turn"
shot after-the-turn
MOVED="$(shots_differ_pixels before-the-turn after-the-turn)"
echo "scene: the turn moved ${MOVED}px of ${INK}px of ink" >&2

# The pane keeps its chrome, its gutters and its row tints across the turn, so
# a re-statement repaints the text of the diff rather than all of its ink: a
# fifth of the ink is far above anything a settling repaint moves, and a
# fiftieth is far below the reading a pane that re-stated produces.
ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	CEILING=$(( INK / 50 ))
	if [ "${MOVED}" -gt "${CEILING}" ]; then
		abandon_take "after-the-turn" \
			"the before arm moved ${MOVED}px of ${INK}px, over the ${CEILING}px a stale pane may move"
	fi
	echo "scene: BEFORE -- the pane moved ${MOVED}px of ${INK}px, at or under the ${CEILING}px ceiling" >&2
else
	FLOOR=$(( INK / 5 ))
	if [ "${MOVED}" -lt "${FLOOR}" ]; then
		abandon_take "after-the-turn" \
			"the after arm moved ${MOVED}px of ${INK}px, under the ${FLOOR}px a re-stated pane must move"
	fi
	echo "scene: AFTER -- the pane moved ${MOVED}px of ${INK}px, over the ${FLOOR}px floor" >&2
fi
