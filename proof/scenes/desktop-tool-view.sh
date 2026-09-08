#!/usr/bin/env bash
# Drive a real tool call in the native GPUI window and disclose its card both
# ways: with the keyboard, and with the pointer.
#
# Records visual evidence for:
#   1. tool-card-collapsed        (one line, host-supplied view, turn focused)
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
# it is asserted here rather than left to whoever opens the gallery. The
# counting is `lib.sh`'s; this scene states the rectangle and the thresholds.
#
# The sidebar is cropped off because the session list prints each session's age,
# so two frames a second apart differ there whatever the transcript does.
use_crop \
	$(( WIN_X + (WIN_W > 800 ? 256 : 0) )) \
	$(( WIN_Y + 48 )) \
	$(( WIN_W - (WIN_W > 800 ? 256 : 0) )) \
	$(( WIN_H - 48 ))
# A disclosed card redraws a quarter of that area. Two settled frames of the
# same state measured 26 pixels apart out of 694,848, which is the software
# renderer's own noise, so agreement is generous and disclosure is unmistakable.
DISCLOSED_PER_MILLE=50
IDENTICAL_PER_MILLE=2

# ─── A Real Tool Call ────────────────────────────────────────────────────────
k "ctrl+shift+m"
pause 0.3
t "local/qwen2.5-1.5b"
pause 0.4
k "Return"
pause 0.5

COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
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
# The card exists as soon as the tool result is recorded, and the model goes on
# writing after it. Every frame below is compared against a baseline over the
# whole transcript, so a turn still streaming under the card puts its next
# paragraph in the differential: a take that opened and closed the card
# correctly measured 136 per mille between two collapsed frames, which is a
# paragraph, not a disclosure. The comparison starts once the turn is settled.
if ! native_session_ready finished 2; then
	abandon_take "native-tool-turn-settled" \
		"the turn that called the tool never reached Complete within 90s, so no two frames of it are comparable"
fi
pause 0.8

# ─── Disclosure From The Keyboard ────────────────────────────────────────────
# The transcript owns `space`, so the pointer establishes that scope first; the
# turn step focuses the turn the card is in, which is the last one.
#
# The baseline is shot AFTER that, not before: a focused turn draws its own
# ring and reveals the footer stating which model wrote it, so a frame taken
# before the focus lands differs from the closed card by everything the focus
# added. That read 210 per mille between two frames of one collapsed card. The
# disclosure is the only thing that may differ between the three frames below.
TRANSCRIPT_X=$(( WIN_X + WIN_W / 2 ))
TRANSCRIPT_Y=$(( WIN_Y + (WIN_H > 481 ? 481 / 3 : WIN_H / 3) ))
move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
click
pause 0.4
k "End"
pause 1.0
shot tool-card-collapsed

k "space"
pause 1.0
shot tool-card-keyboard-open

k "space"
pause 1.0
shot tool-card-keyboard-closed

# ─── Disclosure From The Pointer ─────────────────────────────────────────────
# The same card, opened the other way. Which row holds it is found by clicking,
# because nothing else states it: the transcript is laid out from the host's
# blocks, so the row moves with every word the model wrote around it, and the
# transcript is anchored on its live edge, so the whole turn also moves when
# the card opens. Two arithmetic aims were tried and neither lands: a fixed
# offset above the composer photographed the collapsed card unchanged, and the
# box of the difference between the disclosed and collapsed frames spans the
# shifted prose as well as the card, so its top edge is 300px above the row.
#
# The search runs DOWN the transcript, from the ground above the turn to the
# prose under the card, and stops at the first click that disclosed. Upward
# from the composer it reached the focused turn's own footer first, whose
# trailing actions opened the right panel over the transcript: every later
# click then landed on a surface that had been re-laid-out around a 360px
# column, and the take recorded a frame with a panel in it.
#
# Two of the rows above the card answer a press as well. The footer states
# which model wrote the turn, revealed while the keyboard is on it, and a
# click on that name opens the usage tab. So a click is read three ways: the
# disclosed card is the frame the keyboard already produced; ground and prose
# leave the collapsed frame alone; anything else opened a surface, which the
# panel chord puts back before the next row is tried. A stray change the
# chord does not undo ends the take naming the row that did it, since no later
# frame is comparable to the ones already taken.
#
# The step is smaller than the row, so no row is passed over, and the pointer
# parks where the keyboard frames were taken so no hover state separates the
# pair.
CARD_X=$(( TRANSCRIPT_COLUMN_LEFT + 8 ))
CARD_FLOOR=$(( WIN_Y + WIN_H - COMPOSER_BAND_H - 40 ))
CARD_OPENED=0
park_pointer() {
	move_px "${TRANSCRIPT_X}" "${TRANSCRIPT_Y}"
	pause 0.4
}
for step in $(seq 0 39); do
	CARD_Y=$(( CROP_Y + 8 + step * 16 ))
	[ "${CARD_Y}" -lt "${CARD_FLOOR}" ] || break
	move_px "${CARD_X}" "${CARD_Y}"
	pause 0.2
	click
	pause 0.8
	park_pointer
	if [ "$(screen_differs_from_shot_per_mille tool-card-keyboard-open)" -le "${IDENTICAL_PER_MILLE}" ]; then
		CARD_OPENED="${CARD_Y}"
		break
	fi
	STRAY_PER_MILLE="$(screen_differs_from_shot_per_mille tool-card-collapsed)"
	if [ "${STRAY_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
		k "ctrl+backslash"
		pause 0.8
		park_pointer
		STRAY_PER_MILLE="$(screen_differs_from_shot_per_mille tool-card-collapsed)"
		if [ "${STRAY_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
			abandon_take "a-click-on-the-transcript-discloses-or-does-nothing" \
				"the click at y=${CARD_Y} left ${STRAY_PER_MILLE} pixels per thousand changed after the panel chord put the surface back"
		fi
	fi
done
if [ "${CARD_OPENED}" = 0 ]; then
	abandon_take "the-pointer-disclosed-the-card" \
		"no row between the top of the transcript and the composer drew the card the keyboard disclosed"
fi
echo "scene: the pointer disclosed the card from the row at y=${CARD_OPENED}" >&2
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
# Parity is decided by the search above, which ends only on a click that drew
# the keyboard's frame. This reads it again from the published shot, so a frame
# that changed between the measurement and the capture is caught rather than
# gallery-published as a pair.
PARITY_PER_MILLE="$(shots_differ_per_mille tool-card-keyboard-open tool-card-pointer-open)"
if [ "${PARITY_PER_MILLE}" -gt "${IDENTICAL_PER_MILLE}" ]; then
	abandon_take "both-gestures-open-the-same-card" \
		"the keyboard frame and the pointer frame differ by ${PARITY_PER_MILLE} pixels per thousand"
fi
echo "scene: disclosure ${OPENED_PER_MILLE}/1000, close ${CLOSED_PER_MILLE}/1000, parity ${PARITY_PER_MILLE}/1000" >&2
