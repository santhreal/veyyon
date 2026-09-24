#!/usr/bin/env bash
# Move the command a native GPUI window's turn is waiting on to a background
# job, and photograph the composer before and after the press.
#
# Records visual evidence for:
#   1. background-command-waiting (the composer while the turn waits on a command)
#   2. background-command-moved   (the same composer a press of the chord later)
#
# THE PAIR IS TWO BINARIES, not two settings. Before this change a window had
# no way to release a command its turn was waiting on: no control was drawn in
# the composer, no command opened one and the chord reached no action, so the
# turn held until the command finished or the wall-clock threshold moved it.
# Both arms run this same scene against the same prompt and the same command,
# and the window is the differential.
#
#   SCENE_MOTION_FLOOR=5 SCENE_SETTINGS='bash.stallDetection.enabled: false' \
#     proof/docker/record-native.sh proof/scenes/desktop-background-command.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=02d9c63be1^ SCENE_MOTION_FLOOR=5 \
#     SCENE_SETTINGS='bash.stallDetection.enabled: false' \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/bin/veyyon-desktop-background-before \
#     proof/docker/record-native.sh proof/scenes/desktop-background-command.sh
#
# The before arm holds the host at the same ref as the binary, not at HEAD. The
# wire carries a capability, an action and a snapshot section this change adds,
# and a base binary that receives them closes the socket, so a run with
# PROOF_BASE_REF=HEAD photographs a reconnect banner instead of a composer.
#
# The take is a still one: a control appears in a footer and leaves it, which
# is under the 12 fps default floor, so both arms are recorded at 5.
#
# WHAT IS MEASURED. Two readings, and a frame is not one of them on its own.
# The composer band has to change across the press, which is the control
# leaving the footer; and the session's own transcript has to record the bash
# result that states the command was backgrounded at the request rather than at
# a threshold, which is the product path the press reached. The before arm
# requires the band to hold still and that result to be absent, with the turn
# still running as its positive control: the command is waited on there too, so
# the nothing that arm records belongs to the window rather than to a session
# that never ran anything.
#
# THE COMMAND OUTLIVES THE TAKE, AND NOTHING ELSE MOVES IT. `sleep 240` is
# longer than the take and shorter than the 300s wall-clock threshold that
# backgrounds a command on its own. It also prints nothing, and the stall
# watcher moves a silent command after 30s with a result that reads like the
# press's, so both arms run with `bash.stallDetection.enabled: false`: with it
# on, the after arm passes on a mover it never pressed and the before arm
# records a control that left the footer by itself. A backgrounded result
# inside the take then has no cause but the press, which is what the reading
# below requires by the sentence the manual path writes.
#
# NOT RECORDED HERE: the control's own press, which
# `crates/veyyon-desktop-surface/tests/a-command-the-turn-waits-on-is-moved-from-the-composer.rs`
# drives through the surface and asserts dispatches `BackgroundCommand` for the
# session the composer is on; that the chord falls through to the editor while
# nothing waits, held by the same suite; and which window a wait belongs to,
# swept over concurrent sessions by
# `packages/coding-agent/test/gui-host/a-command-a-window-waits-on-is-moved-to-the-background.test.ts`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# The command the turn waits on. It is named in the prompt so the tool call is
# the one this scene reads for rather than whatever a turn chose to run, and
# the sentence is the plainest one the local model follows into its bash tool,
# which is the same wording `desktop-tool-view.sh` drives a tool call with.
WAIT_COMMAND="sleep 240"
PROMPT_TEXT="run this shell command for me with your bash tool: ${WAIT_COMMAND}"

# The session runs with the stall watcher off, and the take says so before it
# spends four minutes proving it: the watcher moves a silent command after 30s
# with a result that reads like the press's, which grades a window that did
# nothing as green. The seed the recorder wrote is what is read, since that is
# the file the session ahead is about to load.
SEEDED_CONFIG="${HOME}/.veyyon/profiles/${VEYYON_PROFILE:-default}/agent/config.yml"
if ! grep -qs '^bash.stallDetection.enabled: false' "${SEEDED_CONFIG}"; then
	abandon_take "the-stall-watcher-is-off" \
		"the session was seeded without 'bash.stallDetection.enabled: false', so a silent command moves itself after 30s and neither arm reads the press; pass it in SCENE_SETTINGS"
fi

# The control is an icon and a cut command line in a 28px footer row. Two
# settled frames of one state measured well under this on this renderer.
CONTROL_MIN_PIXELS=120
# What the band is allowed to change by while nothing is drawn or removed: the
# caret the chord moves in the before arm inks a column of a text cursor.
STILL_MAX_PIXELS=60

# Wait until the host's own transcript records the bash call this scene reads
# for, or until <state> is what that call settled at.
#
# Bounded: a call that never arrives ends this at the deadline and abandons the
# take naming what the transcript held.
#
#   bash_call_state waiting     -> the call is recorded and has no result yet
#   bash_call_state backgrounded -> its result states the request that moved it
bash_call_state() { # <waiting|backgrounded> <seconds>
	WANT="$1" BUDGET="$2" COMMAND="${WAIT_COMMAND}" python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

want = os.environ["WANT"]
budget = float(os.environ["BUDGET"])
command = os.environ["COMMAND"]
# The wording the bash tool writes when a request moved the command, rather
# than the wall clock or a stall. `execution-messages.ts` states it.
REQUESTED = "at the operator's request"
profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text())
deadline = time.monotonic() + budget
last = "no session snapshot"


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
	"""(calls naming the command, results that state the request moved it)."""
	calls = 0
	requested = 0
	with Path(path).open() as transcript:
		for entry_line in transcript:
			message = json.loads(entry_line).get("message", {})
			content = message.get("content")
			if isinstance(content, list):
				for block in content:
					if not isinstance(block, dict):
						continue
					if block.get("type") == "toolCall" and command in json.dumps(block):
						calls += 1
			if message.get("role") == "toolResult" and REQUESTED in json.dumps(message):
				requested += 1
	return calls, requested


def tail(path, rows=6):
	"""The last few messages, as role and the opening of their text.

	A take that ends here ended because the transcript never carried what the
	press should have written, and the next question is always which sentence
	it carried instead. Printing it costs one read of a file already open.
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


held = "no transcript"
while time.monotonic() < deadline:
	try:
		path, status = transcript_path()
		calls, requested = reading(path)
		last = f"status={status}, calls={calls}, backgrounded={requested}"
		held = tail(path)
		if want == "waiting" and calls and status not in {"Complete", "Error", "Aborted"}:
			print(f"the turn is waiting on {command}")
			raise SystemExit(0)
		if want == "backgrounded" and requested:
			print(f"the bash result states {command} was moved at the request")
			raise SystemExit(0)
	except (OSError, ValueError, RuntimeError) as error:
		last = str(error)
	time.sleep(0.5)
raise SystemExit(f"the transcript never reached '{want}' within {budget:.0f}s ({last}); it held {held}")
PY
}

# ─── 1. Put A Command In Front Of The Turn ───────────────────────────────────
# The prompt is typed into the real composer and submitted through the real
# host, so the wait the frames are read against is one the product opened.
submit_prompt "${PROMPT_TEXT}"
if ! bash_call_state waiting 240; then
	abandon_take "the-turn-waits-on-a-command" \
		"no bash call for ${WAIT_COMMAND} was running within 240s, so there was no wait to photograph"
fi
pause 1.5
measure_composer_card
shot background-command-waiting

# ─── 2. Release It From The Composer ─────────────────────────────────────────
# `primary-shift-b` is the chord the composer binds while a command waits. At
# the base it reaches no action at all, and the same keystroke is pressed there
# so the arms differ by the window rather than by what was typed.
#
# The aim is the editor line the measure above just found, not the one the
# session was opened at: a turn that has drawn a prompt and a tool call has
# moved the card down the window, and a press at the opening position lands in
# the transcript, which takes the keyboard off the composer and leaves the
# chord resolving against nothing.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
pause 0.3
k "ctrl+shift+b"
pause 2.0
measure_composer_card
shot background-command-moved

# ─── 3. What The Press Left ──────────────────────────────────────────────────
composer_band_region
CHANGED="$(shots_differ_pixels background-command-waiting background-command-moved)"
echo "scene: the composer band changed ${CHANGED} pixels across the press" >&2

if [ "${ARM}" = "before" ]; then
	if [ "${CHANGED}" -gt "${STILL_MAX_PIXELS}" ]; then
		abandon_take "the-base-composer-holds-still" \
			"the base composer band changed ${CHANGED} pixels across a chord it binds to nothing, over the ${STILL_MAX_PIXELS} a caret inks"
	fi
	if bash_call_state backgrounded 20; then
		abandon_take "the-base-moves-nothing" \
			"the base recorded a bash result stating the command was moved at the request, which no surface there can ask for"
	fi
	# The positive control: the turn is still waiting, so this arm photographed
	# a session that had something to release and did not release it.
	if ! bash_call_state waiting 20; then
		abandon_take "the-base-turn-still-waits" \
			"the base turn stopped waiting on ${WAIT_COMMAND}, so the still band reports a settled turn rather than a window that offers nothing"
	fi
	exit 0
fi

if [ "${CHANGED}" -lt "${CONTROL_MIN_PIXELS}" ]; then
	abandon_take "the-control-left-the-footer" \
		"the composer band changed ${CHANGED} pixels across the press, under the ${CONTROL_MIN_PIXELS} the control inks, so the frame is of a footer that still carries it"
fi
if ! bash_call_state backgrounded 60; then
	abandon_take "the-command-moved" \
		"the press changed the footer but the transcript records no bash result stating the command was moved at the request, so the window drew a release the tool never performed"
fi
