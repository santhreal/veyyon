#!/usr/bin/env bash
# Drive a real tool call in the native GPUI window and disclose its card both
# ways: with the keyboard, and with the pointer.
#
# Records visual evidence for:
#   1. tool-card-collapsed        (the settled card, one line, host-supplied view)
#   2. tool-card-keyboard-open    (disclosed with `space` on the focused turn)
#   3. tool-card-keyboard-closed  (`space` again closes it)
#   4. tool-card-pointer-open     (disclosed by clicking the same card's row)
#
# Frames 2 and 4 are a pair: a tool card's disclosure is the host's, and the two
# gestures must open the same card. They came out different -- the keyboard
# expanded the block locally and never told the host, so its body held the
# collapsed view -- which is what this scene photographs.
#
# The block has to come from a REAL tool call, so the local model is asked, in
# the plainest sentence it will follow, to run a shell command. Nothing here
# fabricates a transcript.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-tool-view.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# A tool call, not merely a finished turn: a turn that answered in prose has no
# card to disclose, and every assertion below would then photograph the prose.
# The host names the session's transcript, and the transcript states the block.
#
# A session whose last entry is an assistant turn holding an unanswered tool
# call reads as `Interrupted`, and that is exactly the state a turn passes
# through while the tool runs, so only `Error` and `Aborted` end the wait. What
# the probe waits for is the completed shape: a `toolCall` block, the
# `toolResult` that answered it, and the turn settled at `Complete`.
native_tool_call_recorded() {
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["SCENE_RUNTIME_DIR"]) / "created-session.json").read_text())
deadline = time.monotonic() + 240
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
                    calls = 0
                    results = 0
                    with Path(row["path"]).open() as transcript:
                        for entry_line in transcript:
                            message = json.loads(entry_line).get("message", {})
                            if message.get("role") == "toolResult":
                                results += 1
                            content = message.get("content")
                            if isinstance(content, list):
                                calls += sum(
                                    1
                                    for block in content
                                    if isinstance(block, dict) and block.get("type") == "toolCall"
                                )
                    last = f"{last}, calls={calls}, results={results}"
                    if calls and results and row.get("status") == "Complete":
                        print(f"native turn recorded {calls} tool call(s), {results} result(s)")
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"no completed tool call within 240s ({last})")
PY
}

# ─── Comparing Two Frames ────────────────────────────────────────────────────
# What this scene records is that both gestures open the same card and that
# closing returns it to the collapsed one. That is a statement about pixels, so
# it is asserted here rather than left to whoever opens the gallery.
#
# Whole frames cannot be compared: the session list prints each session's age,
# so two frames a second apart differ in the sidebar whatever the transcript
# does. The comparison crops the sidebar off and counts differing pixels per
# thousand of what is left.
CROP_X=$(( WIN_X + (WIN_W > 800 ? 256 : 0) ))
CROP_Y=$(( WIN_Y + 48 ))
CROP_W=$(( WIN_W - (WIN_W > 800 ? 256 : 0) ))
CROP_H=$(( WIN_H - 48 ))
# A disclosed card redraws a quarter of that area. Two settled frames of the
# same state measured 26 pixels apart out of 694,848, which is the software
# renderer's own noise, so agreement is generous and disclosure is unmistakable.
DISCLOSED_PER_MILLE=50
IDENTICAL_PER_MILLE=2

frames_differ_per_mille() { # <png-a> <png-b>
	local scratch="${SCENE_RUNTIME_DIR}/frame-compare"
	mkdir -p "${scratch}"
	local crop="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}" differing
	magick "$1" -crop "${crop}" +repage "${scratch}/a.png"
	magick "$2" -crop "${crop}" +repage "${scratch}/b.png"
	# `compare` exits non-zero whenever the two images differ at all, which is
	# the ordinary case here, so only the count it prints is read.
	differing="$(compare -metric AE "${scratch}/a.png" "${scratch}/b.png" null: 2>&1 || true)"
	case "${differing}" in
		'' | *[!0-9]*)
			abandon_take "frames-comparable" \
				"comparing $(basename "$1") with $(basename "$2") reported '${differing}' instead of a pixel count"
			;;
	esac
	echo $(( differing * 1000 / (CROP_W * CROP_H) ))
}

shots_differ_per_mille() { # <shot-a> <shot-b>
	frames_differ_per_mille "${SCENE_OUT}/${SCENE_NAME}-$1.png" "${SCENE_OUT}/${SCENE_NAME}-$2.png"
}

# What is on screen now, against a frame already recorded. This is how the
# card's row is found: a click that disclosed it changed the transcript, and a
# click that landed on prose changed nothing.
screen_differs_from_shot_per_mille() { # <shot>
	local probe="${SCENE_RUNTIME_DIR}/pointer-probe.png"
	mkdir -p "${SCENE_RUNTIME_DIR}"
	if ! _be_capture "${probe}" 2>&1 || [ ! -s "${probe}" ]; then
		abandon_take "pointer-probe-captured" "the probe capture wrote nothing or an empty file"
	fi
	frames_differ_per_mille "${SCENE_OUT}/${SCENE_NAME}-$1.png" "${probe}"
}

# ─── A Real Tool Call ────────────────────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

COMPOSER_X=$(( WIN_X + (WIN_W > 800 ? 400 : WIN_W / 2) ))
COMPOSER_Y=$(( WIN_Y + (WIN_H > 481 ? 408 : WIN_H - 98) ))
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.3
t "run this shell command for me with your bash tool: printf 'running 6 tests\n'; printf 'test transcribes_a_16k_mono_wav ... ok\n'"
k "Return"

if ! native_tool_call_recorded; then
	abandon_take "native-tool-call-recorded" "the submitted turn recorded no completed tool call within 240s"
fi
pause 0.8
shot tool-card-collapsed

# ─── Disclosure From The Keyboard ────────────────────────────────────────────
# The transcript owns `space`, so the pointer establishes that scope first; the
# turn step focuses the turn the card is in, which is the last one.
TRANSCRIPT_X=$(( WIN_X + WIN_W / 2 ))
TRANSCRIPT_Y=$(( WIN_Y + (WIN_H > 481 ? 481 / 3 : WIN_H / 3) ))
move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
click
pause 0.4
k "End"
pause 0.4
k "space"
pause 1.0
shot tool-card-keyboard-open

k "space"
pause 1.0
shot tool-card-keyboard-closed

# ─── Disclosure From The Pointer ─────────────────────────────────────────────
# The same card, opened the other way. Its row is found by clicking rather than
# by arithmetic: the transcript is laid out from the host's blocks, so the row's
# y depends on how much prose the turn wrote around it, and the fixed offset
# this used to carry photographed the collapsed card unchanged. Rows are clicked
# from just above the composer upwards on the card's chevron, which carries the
# card's own toggle and none of the view's targets. After each click the pointer
# returns to where the keyboard frames were taken, so no hover state separates
# the two frames, and the transcript is compared with the collapsed frame: the
# first click that discloses the card is the card's row, and a click on prose
# changes nothing and costs one probe.
CARD_X=$(( CROP_X + 16 ))
CARD_OPENED=0
for step in $(seq 0 15); do
	CARD_Y=$(( WIN_Y + WIN_H - 140 - step * 24 ))
	[ "${CARD_Y}" -gt "${CROP_Y}" ] || break
	move_px "${CARD_X}" "${CARD_Y}"
	pause 0.2
	click
	pause 0.6
	move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
	pause 0.4
	if [ "$(screen_differs_from_shot_per_mille tool-card-collapsed)" -ge "${DISCLOSED_PER_MILLE}" ]; then
		CARD_OPENED=1
		break
	fi
done
if [ "${CARD_OPENED}" != 1 ]; then
	abandon_take "the-pointer-found-the-card-row" \
		"no row between the composer and the top of the transcript disclosed the card when clicked"
fi
shot tool-card-pointer-open

# ─── What The Four Frames State ──────────────────────────────────────────────
OPENED_PER_MILLE="$(shots_differ_per_mille tool-card-collapsed tool-card-keyboard-open)"
if [ "${OPENED_PER_MILLE}" -lt "${DISCLOSED_PER_MILLE}" ]; then
	abandon_take "the-keyboard-disclosed-the-card" \
		"the space key changed ${OPENED_PER_MILLE} pixels per thousand, under the ${DISCLOSED_PER_MILLE} a disclosed card changes"
fi
CLOSED_PER_MILLE="$(shots_differ_per_mille tool-card-collapsed tool-card-keyboard-closed)"
if [ "${CLOSED_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "the-keyboard-closed-the-card" \
		"the closed card differs from the collapsed one by ${CLOSED_PER_MILLE} pixels per thousand"
fi
PARITY_PER_MILLE="$(shots_differ_per_mille tool-card-keyboard-open tool-card-pointer-open)"
if [ "${PARITY_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "both-gestures-open-the-same-card" \
		"the keyboard frame and the pointer frame differ by ${PARITY_PER_MILLE} pixels per thousand"
fi
echo "scene: disclosure ${OPENED_PER_MILLE}/1000, close ${CLOSED_PER_MILLE}/1000, parity ${PARITY_PER_MILLE}/1000" >&2
