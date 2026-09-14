#!/usr/bin/env bash
# Drive a prompt that names files with `@` in the native GPUI window, and
# photograph what the transcript states about the files it read.
#
# Records visual evidence for:
#   1. mention-rows-collapsed  (the operator's turn holding one row per file read)
#   2. mention-row-expanded    (a row disclosed to its detail)
#
# The rows have to come from a REAL read, so the local model is asked a question
# whose prompt names two paths in the demo workspace: one text file the reader
# takes, and one blob it refuses. Nothing here fabricates a transcript.
#
# THE ARMS. Before the fix, a mention was recorded as a message whose files sit
# under `files`, which the GUI host's converter never read, so the turn drew no
# row at all. The host's own transcript frame is what separates the arms, so
# each arm asserts its own state: after must carry the blocks, before must carry
# none of them.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-file-mention.sh
set -euo pipefail

# A file the auto-reader refuses, so one row states a body and another states
# why there is none. NUL bytes are what the reader tests, and the demo
# workspace is where the session runs.
synthesize_demo_blob() {
python3 - <<'PY'
from pathlib import Path

blob = Path("/sandbox/home/demo/src/vendor.bin")
blob.parent.mkdir(parents=True, exist_ok=True)
blob.write_bytes(bytes(range(256)) * 24)
print(f"synthesized demo blob: {blob} ({blob.stat().st_size} bytes)")
PY
}

synthesize_demo_blob

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# What the HOST sent, not what the window drew: the converter is the layer the
# before arm holds back, and its output is a count this scene can read.
host_mention_blocks() {
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text())
# A host action is externally tagged: the unit variants are a bare string and
# this one carries its own value, never a separate `payload` field.
request = json.dumps({"id": 1, "action": {"OpenSession": {"session": created}}}) + "\n"
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(request.encode())
            with connection.makefile("rb") as stream:
                for _ in range(64):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("missing or oversized host frame")
                    frame = json.loads(line)
                    failure = frame.get("RequestFailed")
                    if failure:
                        raise RuntimeError(f"host refused OpenSession: {failure['error']}")
                    transcript = frame.get("Snapshot", {}).get("Transcript")
                    if not transcript:
                        continue
                    blocks = sum(
                        1
                        for entry in transcript["value"]
                        for block in entry.get("content", [])
                        if isinstance(block, dict) and "FileMention" in block
                    )
                    print(blocks)
                    raise SystemExit(0)
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"the host sent no transcript frame within 30s ({locals().get('last', 'no reply')})")
PY
}

# ─── Comparing Two Frames ────────────────────────────────────────────────────
# The sidebar is cropped off because the session list prints each session's age,
# so two frames a second apart differ there whatever the transcript does.
use_crop \
	$(( WIN_X + RAIL_W )) \
	$(( WIN_Y + TITLEBAR_H )) \
	$(( WIN_W - RAIL_W )) \
	$(( WIN_H - TITLEBAR_H ))
# A disclosed row redraws a band of that area. Two settled frames of the same
# state measure tens of pixels apart under the software renderer, so a
# disclosure is counted in pixels rather than per mille: the row is 24px tall.
DISCLOSED_PIXELS=1200

# ─── A Prompt That Names Two Paths ───────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

# The aim is the preamble's, derived from the token files: a number restated
# here clicked 270px above the card, left the transcript focused, and reported
# the model as having produced no turn.
submit_prompt "State in one short sentence what @src/parser.ts exports. @src/vendor.bin is unrelated. Do not call tools."

if ! native_session_ready finished 2; then
	abandon_take "native-mention-turn-produced" "the prompt naming two paths produced no completed turn within 90s"
fi
pause 0.8
shot mention-rows-collapsed

# ─── What The Host Sent ──────────────────────────────────────────────────────
MENTION_BLOCKS="$(host_mention_blocks)"
echo "scene: the host sent ${MENTION_BLOCKS} file-mention block(s)" >&2
case "${SCENE_ARM:-after}" in
	before)
		if [ "${MENTION_BLOCKS}" != 0 ]; then
			abandon_take "native-mention-before-arm" \
				"the held arm sent ${MENTION_BLOCKS} file-mention block(s), so it is not the before state"
		fi
		exit 0
		;;
	*)
		if [ "${MENTION_BLOCKS}" -lt 2 ]; then
			abandon_take "native-mention-blocks-sent" \
				"the host sent ${MENTION_BLOCKS} file-mention block(s) for a prompt that named two paths"
		fi
		;;
esac

# ─── Disclosing One Row ──────────────────────────────────────────────────────
# A mention row is right-aligned to the transcript column, whatever width the
# prompt's own bubble takes, so the column's trailing edge is the one x that
# lands inside every row. The y depends on how much prose the model wrote
# around it, so it is found by clicking upward from just above the composer,
# each click measured against the collapsed frame.
ROW_X=$(( TRANSCRIPT_COLUMN_RIGHT - 40 ))
ROW_OPENED=0
for step in $(seq 0 15); do
	ROW_Y=$(( WIN_Y + WIN_H - 150 - step * 24 ))
	move_px "${ROW_X}" "${ROW_Y}"
	pause 0.2
	click
	pause 0.6
	move_px "${COMPOSER_X}" "${COMPOSER_Y}"
	pause 0.4
	if [ "$(screen_differs_from_shot_per_mille mention-rows-collapsed)" -gt 2 ]; then
		ROW_OPENED=1
		break
	fi
done
if [ "${ROW_OPENED}" != 1 ]; then
	abandon_take "native-mention-row-disclosed" \
		"no row in the last 16 transcript rows disclosed anything when clicked"
fi
shot mention-row-expanded

DISCLOSED="$(shots_differ_pixels mention-rows-collapsed mention-row-expanded)"
if [ "${DISCLOSED}" -lt "${DISCLOSED_PIXELS}" ]; then
	abandon_take "native-mention-row-disclosed" \
		"disclosing a row changed ${DISCLOSED} pixels, under the ${DISCLOSED_PIXELS} a 24px row and its detail redraw"
fi
echo "scene: disclosure ${DISCLOSED} pixels" >&2
