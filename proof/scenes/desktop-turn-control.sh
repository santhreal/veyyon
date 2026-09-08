#!/usr/bin/env bash
# Drive a real running turn in the native GPUI window and photograph what the
# composer offers while it runs: steer, queue, the queued follow-up, and abort.
#
# Records visual evidence for:
#   1. turn-running-steer      (the turn running, primary action Steer)
#   2. turn-running-queue      (the same turn after `primary-/`, primary Queue)
#   3. turn-queued-followup    (a follow-up submitted behind the running turn)
#   4. turn-queue-taken-back   (the same follow-up returned to the draft by alt+Up)
#   5. turn-steer-command-typed (`/Steer <message>` typed, the row selected)
#   6. turn-steer-queued       (the composer listing the steer the host holds)
#   7. turn-aborted            (a turn stopped by `primary-.`)
#
# Frames 1 and 2 are a differential of one state: the run bar's primary action is
# the whole difference, so a single frame of a running turn proves nothing about
# the mode. Frames 3 and 4 are the queue the operator can read and the way back
# out of it, each compared against the frame before it. Frames 5 and 6 are the
# keyboard route to a steer and what the host answered with, and frame 7 ends a
# run.
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
# An errored turn is not evidence of anything this scene is named for, and it
# is terminal, so a wait that accepted it published a broken run as a steered
# one: a take read `status=Error, messages=2` and went on to photograph the
# abort. `Error` ends the wait as a failure carrying the provider's own
# message, which the session index does not hold.
settled = {"Complete", "Interrupted", "Aborted"}
last = "no host frame"


def provider_error(row):
    # The failure the provider reported sits in the transcript on the assistant
    # message, not in the session index, so a take that stopped on `Error`
    # states what broke rather than only that something did.
    try:
        with Path(row["path"]).open() as transcript:
            for entry in transcript:
                message = json.loads(entry).get("message", {})
                if message.get("role") == "assistant" and message.get("errorMessage"):
                    return message["errorMessage"]
    except (OSError, ValueError, KeyError):
        pass
    return "the transcript states no provider message"


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
                    if row.get("status") == "Error":
                        raise SystemExit(f"Native turn ended in Error ({last}): {provider_error(row)}")
                    if mode == "settled" and row.get("status") in settled:
                        print(f"native turn settled ({last})")
                        raise SystemExit(0)
                    if mode == "aborted" and row.get("status") == "Aborted":
                        print(f"native turn aborted ({last})")
                        raise SystemExit(0)
                    if mode == "aborted" and row.get("status") == "Complete":
                        raise SystemExit(f"Native turn completed instead of aborting ({last})")
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.1)
raise SystemExit(f"Native turn state timed out ({mode}): {last}")
PY
}

# The transcript the host holds for this session, searched for one string.
# Every reply shape is walked rather than indexed by field, so a snapshot key
# renamed upstream cannot make the probe pass over a transcript that never
# carried the text. It also refuses a transcript carrying the command spelling
# itself: a count of the session's messages cannot separate a steer that
# delivered the draft from one that delivered `/Steer ` in front of it.
native_transcript_holds() { # <text> <seconds>
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
wanted = sys.argv[1]
deadline = time.monotonic() + float(sys.argv[2])
request = json.dumps({"id": 1, "action": {"LoadTranscript": {"session": created_id, "before": None}}})
last = "no host frame"


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(request.encode() + b"\n")
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("Missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Transcript" not in snapshot:
                        continue
                    held = list(strings(snapshot["Transcript"]))
                    spelled = next((text for text in held if "/steer" in text.lower()), None)
                    if spelled is not None:
                        raise SystemExit(
                            f"The transcript carries the command spelling, not only its message: {spelled!r}"
                        )
                    if any(wanted in text for text in held):
                        print(f"the steering message reached the session ({len(held)} strings in its transcript)")
                        raise SystemExit(0)
                    last = f"{len(held)} strings in the transcript, none carrying the message"
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"The steering message never reached the host transcript ({last})")
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
# whatever the surface under test did. RAIL_W, TITLEBAR_H and COMPOSER_BAND_H
# come from the token files through the preamble this scene sources, so a
# rectangle follows the shed at whatever width the take is recorded at, and a
# retuned titlebar or composer moves the crop with it rather than leaving it
# reaching into the surface next door.
transcript_crop() {
	use_crop \
		$(( WIN_X + RAIL_W )) \
		$(( WIN_Y + TITLEBAR_H )) \
		$(( WIN_W - RAIL_W )) \
		$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))
}
run_bar_crop() {
	use_crop \
		$(( WIN_X + RAIL_W )) \
		$(( WIN_Y + WIN_H - COMPOSER_BAND_H )) \
		$(( WIN_W - RAIL_W )) \
		"${COMPOSER_BAND_H}"
}
# The composer grows upward once it lists what the session is holding, so the
# queued frames are compared over a taller strip than the run bar's own.
QUEUED_H=240
queued_crop() {
	use_crop \
		$(( WIN_X + RAIL_W )) \
		$(( WIN_Y + WIN_H - QUEUED_H )) \
		$(( WIN_W - RAIL_W )) \
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
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
# The up arrow, at the trailing edge of the composer's own card. The card is
# centred in the session surface -- the window less the queue rail -- and
# measures the authored maximum, or the surface less one gutter each side when
# that is narrower. The control is one 28px square (§6.10) inside the card's
# horizontal padding, so half of it is the offset from the card's content edge
# to the control's centre.
#
# An earlier offset subtracted the right panel's 356px from the window. §8.10
# opens that panel for an operator who opened it and for nobody else, so at
# the defaults a take starts from it is closed, the card is centred in the
# whole row, and that offset aimed 300px left of the arrow: the pointer rested
# on the transcript, no control named itself, and the mode pair measured
# nothing.
PRIMARY_PAD="$(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
geometry = tomllib.loads((tokens / "surface/composer.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())
print(int(scale["spacing"][geometry["padding_horizontal"]]))
PY
)"
COMPOSER_SURFACE_W=$(( WIN_W - RAIL_W ))
COMPOSER_CARD_W=$(( COMPOSER_MAX_W < COMPOSER_SURFACE_W - 2 * GUTTER_PX
	? COMPOSER_MAX_W
	: COMPOSER_SURFACE_W - 2 * GUTTER_PX ))
COMPOSER_CARD_RIGHT=$(( RAIL_W + (COMPOSER_SURFACE_W - COMPOSER_CARD_W) / 2 + COMPOSER_CARD_W ))
PRIMARY_X=$(( WIN_X + COMPOSER_CARD_RIGHT - PRIMARY_PAD - 14 ))
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
# The turn has to run for the length of the frames below, it has to answer in
# prose, and it has to end cleanly. Two prompts failed the take before this
# one: asked for the numbers as English words the 1.5B model drifted into
# Italian and repeated one word twenty times, which the runtime's loop
# detector reads as a stalled stream and the turn ended in `Error`; asked to
# "write the numbers" it called the write tool, and a turn aborted inside a
# tool batch leaves the session running the ledger turn that follows it rather
# than `Aborted`. A counting verb, digits, and an answer asked for in the
# reply keep it a single prose turn; the count runs to 400 because the frames
# below are taken while it generates, and a turn that ends first leaves the
# primary action at Send under both mode names.
RUNNING_PROMPT="Count from 1 to 400 in your reply, one number per line as digits, and nothing else. Do not use tools."
submit_prompt "${RUNNING_PROMPT}"
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

# ─── A steer typed as a command, in any capitalisation ──────────────────────
# `/Steer <message>` is the keyboard route to the control the pointer reaches
# on the composer, and the words after the spelling are what the running turn
# receives. Ranking folds case over the first word alone, so the row is
# selected while the message behind it is left out of the score.
#
# It runs after the frames above because an interjection ends the count the
# turn was in the middle of: a steer delivered before them left an idle
# composer under both mode names, and the pair measured nothing.
#
# WHEN A STEER BECOMES READABLE. Two observables answer for it and they answer
# at different times. The composer's strip is immediate: it lists what the
# HOST reported holding, so a strip carrying the message proves the row ran,
# the window sent the steer and the host took it. The transcript is not: a
# steer joins the run loop's steering queue and is recorded when the loop next
# polls it, which for a single long generation is when that generation ends.
# A take that asked the transcript 30s after the keystroke read a turn still
# counting and abandoned a scene whose steer had been delivered correctly, so
# the strip is read first and the transcript only after the turn settles.
STEER_MESSAGE="Say the words steered by the palette."
type_prompt "/Steer ${STEER_MESSAGE}"
pause 0.4
shot turn-steer-command-typed
k "Return"
pause 1.2
shot turn-steer-queued
queued_crop
STEER_HELD="$(shots_differ_pixels turn-queue-taken-back turn-steer-queued)"
echo "scene: the composer moved ${STEER_HELD} pixels when the steer was sent" >&2
if [ "${STEER_HELD}" -lt "${QUEUED_STRIP_PIXELS}" ]; then
	abandon_take "native-steer-stated-by-the-composer" \
		"the steer moved ${STEER_HELD} pixels, so the command row ran without reaching the host or the host reported no steering prompt"
fi

# What the model received, once the turn it was steering has ended: the
# message, and no `/steer` spelling in front of it. The probe prints the
# provider's message and fails when the run ends in `Error`, so a steer that
# breaks the turn it joined is a failed take rather than a photographed one.
if ! native_turn_state settled 300; then
	abandon_take "native-steered-turn-settled" \
		"the steered turn reached no clean terminal status within 300s, so the steering queue was never polled or the run it joined broke"
fi
if ! native_transcript_holds "${STEER_MESSAGE}" 90; then
	abandon_take "native-steer-reached-the-turn" \
		"the steering message never reached the host, so the command row ran without what was typed after it"
fi

# ─── The way out (primary-.) ─────────────────────────────────────────────────
# The abort needs a turn of its own: the steer above is only readable once the
# turn it joined has ended, and a chord pressed at a settled session photographs
# a finished turn under the name of an aborted one.
submit_prompt "${RUNNING_PROMPT}"
# `started` counts the session's persisted messages, and the turns above left
# several, so it answers yes before this prompt reaches anything. What proves
# this turn is running is the transcript repainting under it.
transcript_crop
ABORT_BASELINE="${SCENE_RUNTIME_DIR}/before-the-abort.png"
probe_frame "${ABORT_BASELINE}"
if ! streamed_into_the_transcript "${ABORT_BASELINE}" 180; then
	abandon_take "native-abort-turn-generating" \
		"nothing streamed into the transcript within 180s, so the chord would have aborted a turn that had not started"
fi
k "ctrl+period"
# `Aborted`, not any terminal status: the session index still carries the
# previous turn's `Complete` for a moment after a submission, so a wait that
# took the first terminal status it saw returned before this turn existed and
# published a finished turn under the name of an aborted one.
if ! native_turn_state aborted 60; then
	abandon_take "native-turn-aborted" "the abort chord left the host running the turn or let it finish"
fi
pause 1.0
shot turn-aborted
