#!/usr/bin/env bash
# Write a plan from a turn in the native GPUI window and photograph the
# composer before and after the board that turn wrote reaches it.
#
# Records visual evidence for:
#   1. plan-absent (the composer of a settled turn that wrote no plan)
#   2. plan-chip   (the same composer once a turn has written one)
#
# THE PAIR IS TWO BINARIES, not two settings. Before this change a window was
# sent no plan and drew none: the wire carried no board, the composer footer
# held no chip for one, and the only statement of what the agent had planned
# was the tool card in the transcript, which scrolls away with the turn that
# wrote it. Both arms run this same scene against the same two prompts, and the
# window is the differential.
#
#   SCENE_MOTION_FLOOR=5 \
#     proof/docker/record-native.sh proof/scenes/desktop-plan-chip.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=<plan-commit>^ SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/bin/veyyon-desktop-plan-before \
#     proof/docker/record-native.sh proof/scenes/desktop-plan-chip.sh
#
# The before arm holds the host at the same ref as the binary, not at HEAD. The
# wire carries a capability and a snapshot section this change adds, and a base
# binary that receives them closes the socket, so a run with PROOF_BASE_REF=HEAD
# photographs a reconnect banner instead of a composer.
#
# The take is a still one: a chip appears in a footer and nothing moves after
# it, which is under the 12 fps default floor, so both arms are recorded at 5.
#
# WHAT IS MEASURED. Two readings, and a frame is not one of them on its own.
# The composer band has to change across the second turn, which is the chip
# arriving in the footer; and the session's own transcript has to record the
# todo call that wrote the board together with the tally its result states, so
# the frame is read against a plan the tool actually holds rather than against
# whatever else a second turn drew. The before arm requires the band to hold
# still with that same call recorded as its positive control: the plan is
# written there too, so the nothing that arm records belongs to the window
# rather than to a turn that planned nothing.
#
# THE BAND IS COMPARED WHERE IT WAS MEASURED. Two settled turns separate the
# frames, and a card that moved between them would put transcript ink in the
# comparison and grade the take on the prose the model wrote. The card is
# measured before each frame and the take is abandoned when it moved, so the
# reading below is of one rectangle in both frames.
#
# NOT RECORDED HERE: what the chip opens, which
# `crates/veyyon-desktop-surface/tests/every-control-that-cuts-what-it-knows-opens-a-detail-that-states-it.rs`
# drives through the surface and asserts states the task in flight and the
# tally of every phase; that the chip is reachable at all, held by the control
# census in `crates/veyyon-desktop-surface/tests/support/control-reach/mod.rs`;
# and which board a window is sent, swept over the tool's own vocabulary by
# `packages/coding-agent/test/gui-host/a-plan-the-agent-moved-is-stated-to-the-window.test.ts`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# The first turn plans nothing, and its only purpose is a settled composer to
# read the second against: a frame taken before any turn exists is a frame of a
# centred card (§5.4) rather than of the composer the plan arrives in.
QUIET_PROMPT="reply with the single word ready and nothing else"

# The plan the second turn writes. The tasks are named in the prompt so the
# board the frames are read against is this one rather than whatever a turn
# chose to plan, and the call is asked for in the tool's own vocabulary: the
# seeded model is a 1.5b local one, and a flat `items` list under `op: init`
# is the shape it follows where a nested phase list is the shape it invents.
PLAN_TASK="draft the health check"
PLAN_PROMPT="call your todo tool once with op init and items:"
PLAN_PROMPT="${PLAN_PROMPT} ${PLAN_TASK}, wire the route, record the result."
PLAN_PROMPT="${PLAN_PROMPT} Write the plan and stop."

# The chip is an icon and a cut tally in a 28px footer row. Two settled frames
# of one state measured well under this on this renderer.
CHIP_MIN_PIXELS=120
# What the band is allowed to change by while nothing is drawn: the caret inks
# a column of a text cursor in the editor line the frames share.
STILL_MAX_PIXELS=60
# What the card is allowed to move by between the two measurements. A card that
# did not move measures the same row twice; the tolerance is the rounding of a
# ringed edge found in a greyscale pass rather than a band of slack.
CARD_DRIFT_MAX_PX=3

# Wait until the host's own transcript records the todo call this scene reads
# for, and the result that states the board it wrote.
#
# Bounded: a call that never arrives ends this at the deadline and abandons the
# take naming what the transcript held.
plan_recorded() { # <seconds>
	BUDGET="$1" TASK="${PLAN_TASK}" python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import time

budget = float(os.environ["BUDGET"])
task = os.environ["TASK"]
# The tally every todo result ends with. `todo.ts` writes it, and it is the one
# sentence that states the board rather than the call that asked for it.
TALLY = "Overall: "
profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text())
deadline = time.monotonic() + budget


def transcript_path():
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
				return row["path"], row.get("status")
	raise RuntimeError("host answered no session listing")


def reading(path):
	"""(calls naming the task, results stating a board).

	The task is matched without case. The prompt states it in lower case and
	the model writes it into the call as it pleases: one take recorded "draft
	the health check" and the next "Draft the health check", which is the same
	plan and was read as no plan at all.
	"""
	calls = 0
	boards = 0
	wanted = task.lower()
	with Path(path).open() as transcript:
		for entry_line in transcript:
			message = json.loads(entry_line).get("message", {})
			content = message.get("content")
			if isinstance(content, list):
				for block in content:
					if not isinstance(block, dict):
						continue
					if block.get("type") == "toolCall" and wanted in json.dumps(block).lower():
						calls += 1
			if message.get("role") == "toolResult" and TALLY in json.dumps(message):
				boards += 1
	return calls, boards


def tail(path, rows=6):
	"""The last few messages, as role and the opening of their text.

	A take that ends here ended because the transcript never carried the plan
	the frame is named for, and the next question is always what it carried
	instead. Printing it costs one read of a file already open.
	"""
	seen = []
	try:
		with Path(path).open() as transcript:
			for entry_line in transcript:
				message = json.loads(entry_line).get("message", {})
				role = message.get("role")
				if not role:
					continue
				seen.append(f"{role}: {json.dumps(message.get('content'))[:180]}")
	except (OSError, ValueError):
		return "the transcript could not be read"
	return " | ".join(seen[-rows:]) or "the transcript carries no messages"


last = "no transcript"
held = "no transcript"
while time.monotonic() < deadline:
	try:
		path, status = transcript_path()
		calls, boards = reading(path)
		last = f"status={status}, calls={calls}, boards={boards}"
		held = tail(path)
		if calls and boards:
			print(f"the transcript records a plan holding '{task}'")
			raise SystemExit(0)
	except (OSError, ValueError, RuntimeError) as error:
		last = str(error)
	time.sleep(0.5)
raise SystemExit(f"no plan was written within {budget:.0f}s ({last}); the transcript held {held}")
PY
}

# ─── 1. A Composer With No Plan Behind It ────────────────────────────────────
submit_prompt "${QUIET_PROMPT}"
if ! native_session_ready finished 2; then
	abandon_take "a-turn-settles-before-the-plan" \
		"the first turn never reached Complete within its ceiling, so there is no settled composer to read the plan against"
fi
pause 1.0
measure_composer_card

# The aim a prompt is typed at follows the card. The preamble pinned it where
# the card rests on a session holding no turns, which is the middle of the
# window (§5.4), and a settled turn moves the card to the foot: the second
# prompt typed at the pinned aim clicked into the transcript, which takes the
# keyboard with it, and the take abandoned on a band that changed nothing
# while the keystrokes were sent.
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
ABSENT_CARD_BOTTOM="${COMPOSER_CARD_BOTTOM}"
shot plan-absent

# ─── 2. A Turn That Writes One ───────────────────────────────────────────────
# The prompt is typed into the real composer and submitted through the real
# host, so the board the frame is read against is one the agent's own tool
# wrote through the product path.
submit_prompt "${PLAN_PROMPT}"
if ! plan_recorded 240; then
	abandon_take "a-plan-is-written" \
		"no todo call holding '${PLAN_TASK}' was answered with a board within 240s, so there was no plan to photograph"
fi
if ! native_session_ready finished 4; then
	abandon_take "the-planning-turn-settles" \
		"the turn that wrote the plan never reached Complete within its ceiling, so the composer under it is still moving"
fi
pause 1.0
measure_composer_card
shot plan-chip

DRIFT=$(( COMPOSER_CARD_BOTTOM - ABSENT_CARD_BOTTOM ))
if [ "${DRIFT#-}" -gt "${CARD_DRIFT_MAX_PX}" ]; then
	abandon_take "the-band-is-one-rectangle" \
		"the composer card moved ${DRIFT} pixels between the two frames, so the comparison below would read the transcript above it rather than the footer"
fi

# ─── 3. What The Plan Left In The Footer ─────────────────────────────────────
composer_band_region
CHANGED="$(shots_differ_pixels plan-absent plan-chip)"
echo "scene: the composer band changed ${CHANGED} pixels across the planning turn" >&2

if [ "${ARM}" = "before" ]; then
	if [ "${CHANGED}" -gt "${STILL_MAX_PIXELS}" ]; then
		abandon_take "the-base-composer-holds-still" \
			"the base composer band changed ${CHANGED} pixels across a turn whose plan it is sent nothing about, over the ${STILL_MAX_PIXELS} a caret inks"
	fi
	exit 0
fi

if [ "${CHANGED}" -lt "${CHIP_MIN_PIXELS}" ]; then
	abandon_take "the-chip-reached-the-footer" \
		"the composer band changed ${CHANGED} pixels across the planning turn, under the ${CHIP_MIN_PIXELS} the chip inks, so the frame is of a footer the board never reached"
fi
