#!/usr/bin/env bash
# A turn stopped while it is waiting for an approval, in the native GPUI window.
#
# Records visual evidence for:
#   1. approval-waiting  (a real read call held at a decision card)
#   2. stop-pressed      (the same window one moment after the stop chord)
#   3. stop-settled      (thirty seconds later, which is what tells the arms apart)
#
# THE DIFFERENTIAL IS THE HOST SOURCE, held back on the before arm, so both arms
# run the same executable and the same seeded approval mode:
#
#   SCENE_SETTINGS='tools.approvalMode: ask' \
#     proof/docker/record-native.sh proof/scenes/desktop-approval-stop.sh
#   SCENE_ARM=before PROOF_BASE_REF=8890815979^ \
#     SCENE_SETTINGS='tools.approvalMode: ask' \
#     proof/docker/record-native.sh proof/scenes/desktop-approval-stop.sh
#
# `tools.approvalMode: ask` is not the claim -- it is the only way to get a card
# on screen at all, so both arms are seeded with it. What differs is whether the
# stop can reach a turn that is parked on one.
#
# WHAT WENT WRONG. The tool wrapper raised its approval card with one shared
# options object that carried no `AbortSignal`, so nothing could take the card
# down. Stopping the turn aborts the tool signal and then waits for the agent to
# go idle, which waits for the prompt, which waits for that card: the stop never
# came back, the card stayed up, and the turn was never ended. Every action that
# ends a turn before leaving the session was stuck the same way. The before arm
# is that window; the after arm is the card withdrawn and the row settled as
# aborted.
#
# NOTHING HERE IS STAGED. The turn is real, the read call is the model's own,
# and the card is the one the wrapper raised through the host's interaction
# ledger. The scene reads the card off the screen by colour -- `tint.approve` is
# painted by a waiting decision and by nothing else on this surface -- and reads
# the row off the host's own session snapshot.
#
# Sourced state comes from desktop-composer.sh: the helpers, the token-derived
# geometry, a created session and its composer frames.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where A Waiting Decision Is Drawn ───────────────────────────────────────
# The card is attached above the composer, and `tint.approve` is painted by a
# waiting decision and by nothing else on this surface, so the count of that
# fill over everything above the composer band is a reading of whether a
# decision is up. The crop is derived from the token-driven geometry the
# preamble exported rather than from numbers this scene picked.
#
# The rail is not read here. A turn parked on a decision has no stream in
# flight and its row reports `Interrupted`, so it draws no `Working` chip --
# correctly, and in both arms. What the row says instead is read from the host
# below, where the two arms differ.
CARD_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"

# A card's edge is a hairline ring around the composer's measure and its detail
# pane is filled with the same tint. Prose is not silent at this fuzz, so both
# floors are differentials against the take's own empty band rather than
# absolute counts: the card has to add this much to what the surface drew
# before it existed, and it has to give nearly all of it back.
CARD_MIN_RISE=400
CARD_CLEARED_FRACTION=4

card_tint() { # <png> -> pixels of a waiting decision's tint above the composer
	approve_tint_pixels "$1" "${CARD_CROP}"
}

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The screen as it is now, named, so a reading and the frame it was taken from
# can be looked at together when a take is diagnosed.
probe() { # <name> -> path to the frame
	local frame="${PROBE_DIR}/$1.png"
	probe_frame "${frame}"
	printf '%s' "${frame}"
}

# ─── The Session The Turn Runs On ────────────────────────────────────────────
# The preamble created it and named it. Every reading below is about this row,
# and the stop is aimed at this turn.
HELD_SESSION="$(python3 - <<'PY'
import json
import os
from pathlib import Path

print(json.loads((Path(os.environ["SCENE_RUNTIME_DIR"]) / "created-session.json").read_text()))
PY
)"
if [ -z "${HELD_SESSION}" ]; then
	abandon_take "the-session-is-named" "the preamble recorded no created session, so no row can be followed"
fi

# What the host says about that row, polled until it settles or the deadline
# passes. A reading is printed either way: a timeout is a reading too, and the
# before arm is written around one.
host_row() { # <seconds> -> "status=<s> messages=<n>"
python3 - "${HELD_SESSION}" "$1" <<'PY'
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
# row still owed a reply, which is where a stop that never returned leaves it.
settled = {"Complete", "Aborted", "Error"}
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
# Named rather than left at whatever the composer starts on, so the turn runs
# against the recorder's own model and a provider error cannot be photographed
# as a stopped turn.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
k "ctrl+shift+m"
pause 0.4
t "local/qwen2.5-1.5b"
pause 0.5
k "Return"
pause 0.5

# The empty band, before any card exists, which is what both card readings below
# are differentials against.
EMPTY_CARD_TINT="$(card_tint "$(probe approval-empty)")"

# ─── One Read Call, Held At A Decision ───────────────────────────────────────
# The prompt names the tool and a file this repository has, so the call is the
# model's to make and not the scene's to fake. At `tools.approvalMode: ask` the
# wrapper stops it for an answer, and the scene gives it none: an operator who
# reaches for the stop instead is the whole subject.
submit_prompt "Call the read tool once with path AGENTS.md, then tell me the first heading in it. Call no other tool."

WAITED=0
RAISED_CARD_TINT=0
while [ "${WAITED}" -lt 240 ]; do
	RAISED_CARD_TINT="$(card_tint "$(probe approval-waiting-probe)")"
	if [ "$(( RAISED_CARD_TINT - EMPTY_CARD_TINT ))" -ge "${CARD_MIN_RISE}" ]; then
		break
	fi
	sleep 2
	WAITED=$((WAITED + 2))
done
if [ "$(( RAISED_CARD_TINT - EMPTY_CARD_TINT ))" -lt "${CARD_MIN_RISE}" ]; then
	abandon_take "the-call-is-held-for-an-answer" \
		"the band above the composer went from ${EMPTY_CARD_TINT} to ${RAISED_CARD_TINT} pixels of approve tint within ${WAITED}s, under the ${CARD_MIN_RISE} a card adds, so no decision was raised to stop a turn on"
fi
# What the host says about the row while the call is held: a turn that has not
# ended, which is what makes the stop below aimed at something. `Interrupted`
# is the shape of an assistant turn holding an unanswered tool call, and
# `Pending` is the row still owed a reply; a row already settled means the take
# photographed the wrong moment.
HELD_ROW="$(host_row 2)"
case "${HELD_ROW}" in
	"status=Interrupted"* | "status=Pending"*) ;;
	*)
		abandon_take "the-turn-is-still-owed-a-reply" \
			"the host says ${HELD_ROW} for the session holding the card, so the turn ended before the stop and there is nothing for the stop to reach"
		;;
esac
settle 2
shot approval-waiting

# ─── The Stop ────────────────────────────────────────────────────────────────
# The composer's own chord, which is the control an operator reaches for while a
# turn is running (`primary-.` in the surface keymap). No pointer aim is needed
# and none is taken: the claim is about what the host does with the action, not
# about where the button is.
k "ctrl+period"
settle 2
shot stop-pressed
PRESSED_CARD_TINT="$(card_tint "$(probe stop-pressed-probe)")"

# ─── Thirty Seconds Later ────────────────────────────────────────────────────
# Longer than any withdrawal the host schedules, so a card that came down slowly
# is not published as one that never came down, and a card that is still up is
# up for good.
sleep 30
settle 2
shot stop-settled
SETTLED_CARD_TINT="$(card_tint "$(probe stop-settled-probe)")"
ROW="$(host_row 20)"

echo "scene: approve tint ${EMPTY_CARD_TINT} empty -> ${RAISED_CARD_TINT} held -> ${PRESSED_CARD_TINT} stopped" \
	"-> ${SETTLED_CARD_TINT} settled; the host said ${HELD_ROW} while the card was up, and ${ROW} after the stop" >&2

if [ "${ARM}" = "before" ]; then
	if [ "$(( SETTLED_CARD_TINT - EMPTY_CARD_TINT ))" -lt "${CARD_MIN_RISE}" ]; then
		abandon_take "the-card-outlived-the-stop" \
			"the card came down (${SETTLED_CARD_TINT} pixels of approve tint against the ${RAISED_CARD_TINT} it drew while the call was held, over an empty ${EMPTY_CARD_TINT}), so this arm did not reproduce the stop that could not reach it"
	fi
	case "${ROW}" in
		"status=Aborted"*)
			abandon_take "the-row-is-still-owed-a-reply" \
				"the host says ${ROW} for the stopped session, so the stop reached the turn after all and this arm is not the before one"
			;;
	esac
	echo "scene: before arm -- thirty seconds after the stop the card is still up and the host still owes the turn" \
		"a reply (${ROW})" >&2
else
	if [ "$(( SETTLED_CARD_TINT - EMPTY_CARD_TINT ))" -ge "${CARD_MIN_RISE}" ]; then
		abandon_take "the-card-went-with-the-turn" \
			"the card is still up (${SETTLED_CARD_TINT} pixels of approve tint against an empty ${EMPTY_CARD_TINT}), so the stop did not withdraw the decision the turn was parked on"
	fi
	if [ "$(( SETTLED_CARD_TINT * CARD_CLEARED_FRACTION ))" -ge "${RAISED_CARD_TINT}" ]; then
		abandon_take "the-card-cleared-rather-than-shrank" \
			"the band is at ${SETTLED_CARD_TINT} of the ${RAISED_CARD_TINT} pixels the held card drew, which is a card that got smaller rather than one that went"
	fi
	case "${ROW}" in
		"status=Aborted"*) ;;
		*)
			abandon_take "the-stop-ended-the-turn" \
				"the host says ${ROW} for the stopped session, against the aborted row a stop that reached the turn leaves behind"
			;;
	esac
	echo "scene: after arm -- the stop withdrew the decision, ended the turn, and the row settled as aborted (${ROW})" >&2
fi
