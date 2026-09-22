#!/usr/bin/env bash
# Spawn agents into a live session from the window's own control, open
# `/agents` from the native GPUI window's palette, and photograph what the
# window draws for them.
#
# Records visual evidence for:
#   1. palette-agents (the palette with `/agents` typed into it)
#   2. agents-empty   (what a press of that row opens, on a session running
#      no agent)
#   3. agents-running (the same surface, reopened once two agents are in the
#      session)
#   4. agents-comms   (the second view, opened from the surface's own control)
#
# THE PAIR IS TWO BINARIES AND TWO HOSTS. `/agents` resolved to
# `SettingsPage::Extensions`, which draws extensions, and nothing on the window
# read the roster the host sends; the roster the host sent was empty in any
# case, because the section was scoped by the project directory where the
# registry holds a conversation. Both arms spawn the same two agents through
# the same field, type the same word into the same palette and press the same
# row.
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-agent-roster.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=13b76ce91f SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/proof-bins/before \
#     proof/docker/record-native.sh proof/scenes/desktop-agent-roster.sh
#
# The take is a still one: a palette opens over a session and a card replaces
# it, so both arms are recorded at the 5 fps floor rather than the 12 fps
# default.
#
# WHERE THE AGENTS COME FROM. The settings sheet's task field, which is the
# window's own way of running one and is drawn by both arms. A spawn sent over
# a second socket would belong to a session of its own, and a roster scoped to
# the session the window is attached to is right to draw nothing for it.
#
# WHAT IS MEASURED, in the card's own body and header rather than in the whole
# frame, whose queue rail states an elapsed time that ticks between any two
# shots:
#
#   * The body the spawns changed. Two agents enter a session while the card
#     is closed; the card is reopened and its body is compared with the body
#     it drew before them. The after arm requires that band to change by more
#     than a roster of two rows can be drawn in; the before arm requires it to
#     stay under that, since the page it opens reads no roster.
#   * The choice of view the card offers, read as the hairline-edged control in
#     its header. The after arm requires one, presses its trailing segment and
#     requires the body to change; the before arm requires the header to carry
#     no such control at all.
#   * What the host holds, in its own vocabulary over a second socket, so a
#     body that drew no roster is the window's doing rather than a session that
#     has no agents in it.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── The Agents The Session Runs ─────────────────────────────────────────────
# One short assignment, run twice. The field names no agent, so the host names
# each spawn itself, and this take reads how many the session runs rather than
# what they are called.
PROBE_TASK="Reply with the word ready"

# The page that field is on. The after arm's palette names it; the before arm
# reaches the same page through `/agents`, which is the word that opened it
# before this window had a dashboard.
SPAWN_ROUTE="/extensions"
if [ "${ARM}" = before ]; then SPAWN_ROUTE="/agents"; fi

host_call() { # <action-json> <section> <seconds> [<word>] -> the section's JSON, or ""
python3 - "$1" "$2" "$3" "${4-}" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

action, section, seconds, word = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
deadline = time.monotonic() + seconds
# One connection and one send, and no session created on it: a client the host
# has opened no session for is told the whole process roster, which is how this
# take reads the session the window is driving from outside it.
#
# A section is read for the word this call is waiting on, and whatever came
# back instead is reported, so a take that reads nothing states the host's own
# answer rather than a timeout.
seen = []
try:
	with socket.socket(socket.AF_UNIX) as connection:
		connection.settimeout(seconds)
		connection.connect(str(endpoint))
		connection.sendall(action.encode("utf-8") + b"\n")
		with connection.makefile("rb") as stream:
			while time.monotonic() < deadline:
				line = stream.readline(8 * 1024 * 1024 + 1)
				if not line or len(line) > 8 * 1024 * 1024:
					seen.append("the host closed the connection")
					break
				frame = json.loads(line)
				snapshot = frame.get("Snapshot")
				if isinstance(snapshot, dict) and section in snapshot:
					answer = json.dumps(snapshot[section])
					if not word or word in answer:
						print(answer)
						sys.exit(0)
					seen.append(f"{section} without {word}: {answer[:200]}")
					continue
				seen.append(line[:300].decode("utf-8", "replace").strip())
except Exception as refusal:  # reported below: a take says why it read nothing
	seen.append(repr(refusal))
for note in seen[-4:]:
	print("scene: the host answered", note, file=sys.stderr)
print("")
PY
}

# How many agents the host holds beyond the one every session has. `main` is
# the conversation itself; a spawn is any other kind.
spawned_count() { # <seconds> -> a count
	host_call '{"id":2,"action":"RefreshAgents"}' Agents "$1" |
		python3 -c 'import json,sys; rows=json.loads(sys.stdin.read().strip() or "[]"); print(sum(1 for r in rows if r.get("kind") != "main"))'
}

# ─── Where The Dashboard Card Draws ──────────────────────────────────────────
# A card the window centres in the room under the titlebar, at the measures its
# own token file states, clamped by the margin every float keeps. Read from the
# tokens this checkout ships, so a retheme moves the crops with the surface.
read -r CARD_W CARD_H TITLEBAR_H MARGIN PADDING HEAD_LINE STEP \
	SHEET_W COLUMN_W BODY_INSET ROW_H SHEET_H < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

print(
	token_px.value_of("surface/agents.toml", "layout.card_width_px"),
	token_px.value_of("surface/agents.toml", "layout.card_height_px"),
	token_px.value_of("surface/shell.toml", "titlebar.height_px"),
	token_px.value_of("scale.toml", "spacing.s4"),
	token_px.value_of("surface/agents.toml", "layout.padding"),
	int(token_px.load("scale.toml")["type"]["size"]["head"]["line_height"]),
	token_px.value_of("scale.toml", "spacing.s4"),
	token_px.value_of("surface/settings.toml", "layout.group_width_px"),
	token_px.value_of("surface/settings.toml", "layout.control_column_width_px"),
	token_px.value_of("scale.toml", "spacing.s6"),
	token_px.value_of("surface/settings.toml", "layout.row_height_px"),
	token_px.value_of("surface/settings.toml", "layout.sheet_height_px"),
)
PY
)
ROOM_H=$(( WIN_H - TITLEBAR_H ))
if (( CARD_W > WIN_W - 2 * MARGIN )); then CARD_W=$(( WIN_W - 2 * MARGIN )); fi
if (( CARD_H > ROOM_H - 2 * MARGIN )); then CARD_H=$(( ROOM_H - 2 * MARGIN )); fi
CARD_LEFT=$(( WIN_X + (WIN_W - CARD_W) / 2 ))
CARD_TOP=$(( WIN_Y + TITLEBAR_H + (ROOM_H - CARD_H) / 2 ))

# The header row is the card's own padding, the head line the title is set on,
# and the step under it. The body starts one step below that, so a crop of the
# body takes none of the header and the reading is of the rows alone.
HEADER_TOP=$(( CARD_TOP + PADDING ))
HEADER_H=$(( HEAD_LINE + STEP ))
BODY_TOP=$(( HEADER_TOP + HEADER_H + STEP ))
BODY_LEFT=$(( CARD_LEFT + PADDING ))
BODY_W=$(( CARD_W - 2 * PADDING ))
BODY_H=$(( CARD_TOP + CARD_H - PADDING - BODY_TOP ))
if (( BODY_H < 200 )); then
	abandon_take "the-dashboard-has-a-body" \
		"the card leaves ${BODY_H}px under its header, too little to hold the rows this scene reads"
fi
echo "scene: the dashboard card is ${CARD_W}x${CARD_H} at +${CARD_LEFT}+${CARD_TOP}," \
	"its body ${BODY_W}x${BODY_H} at +${BODY_LEFT}+${BODY_TOP}" >&2

# ─── Where The Task Field Draws ──────────────────────────────────────────────
# The settings sheet the window centres in the same room, at the measures the
# settings tokens state. The row the field is on is not counted down from the
# sheet's top: a page states a title and a description above its rows, and a
# count of lines is a second copy of a composition the surface already decides.
# The strip below the sheet's header is read for the first row that holds ink
# in its control column, which is that field and the button beside it.
SHEET_LEFT=$(( WIN_X + (WIN_W - SHEET_W) / 2 ))
SHEET_ROOM_H=$(( WIN_H - TITLEBAR_H ))
SHEET_ACTUAL_H=$(( SHEET_ROOM_H - 2 * MARGIN ))
if (( SHEET_ACTUAL_H > SHEET_H )); then SHEET_ACTUAL_H=${SHEET_H}; fi
SHEET_TOP=$(( WIN_Y + TITLEBAR_H + (SHEET_ROOM_H - SHEET_ACTUAL_H) / 2 ))
COLUMN_RIGHT=$(( SHEET_LEFT + SHEET_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))
# The header the strip starts under: the sheet's own padding, the head line its
# title is set on, and the description line under it, which is where a page's
# rows begin. The control column carries the sheet's Close control on that head
# line, so a strip that started higher would read that as the first row.
STRIP_TOP=$(( SHEET_TOP + PADDING + HEAD_LINE + ROW_H ))
STRIP_H=$(( 3 * ROW_H ))

task_field_point() { # <png> -> "<x> <y>" to press, or "" for a row with no ink
	local dump="${TMPDIR}/frame-compare/task-field.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${COLUMN_W}x${STRIP_H}+${COLUMN_LEFT}+${STRIP_TOP}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${COLUMN_LEFT}" "${STRIP_TOP}" "${ROW_H}" <<'PY'
import collections
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")
dump, left, top, row_h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
pixels = []
for line in open(dump, encoding="utf-8").read().splitlines():
	found = PIXEL.match(line)
	if found:
		hexed = found.group(3)
		pixels.append((int(found.group(1)), int(found.group(2)), hexed))
if not pixels:
	raise SystemExit(0)
# The ground is whatever most of the strip is; ink is what stands off it. A
# label set in muted ink is a tenth of the way off the ground, so the reading
# takes anything clear of the renderer's own blending rather than full ink.
ground = collections.Counter(hexed for _, _, hexed in pixels).most_common(1)[0][0]
base = tuple(int(ground[at : at + 2], 16) for at in (0, 2, 4))
ink = [
	(x, y)
	for x, y, hexed in pixels
	if max(abs(int(hexed[at : at + 2], 16) - base[at // 2]) for at in (0, 2, 4)) > 40
]
if not ink:
	raise SystemExit(0)
first = min(y for _, y in ink)
band = [(x, y) for x, y in ink if first <= y < first + row_h]
# A press lands inside the field rather than on its first glyph, and the field
# is the leading control of the row: the button beside it is further along.
print(left + min(x for x, _ in band) + 18, top + (first + max(y for _, y in band)) // 2)
PY
}

# How much of the card's body two rows of roster may draw in. A row is a name, a
# kind, a status, a model and a gist, with controls at its trailing edge, so two
# of them ink thousands of pixels; a card that only restated its own counts
# moves a few hundred.
ROSTER_PX=1500

# ─── The Header's Choice Of View ─────────────────────────────────────────────
# The segmented control §6.10 draws for a choice between two views is the one
# hairline-edged box in the header row, so its own edge states where it is. The
# card's own frame is that colour too, so the columns at its edges are left out
# of the reading, and a band that still spans most of the card is a rule rather
# than a control and is reported as no control at all.
HAIRLINE="$(theme_colour role.hairline)"
segment_band() { # <png> -> "<left> <right>" on the screen, or "" for no control
	local dump="${TMPDIR}/frame-compare/header-band.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	# The dump is a file rather than a pipe: the reader's own source arrives on
	# stdin here, so a pipeline would hand it the script instead of the pixels.
	magick "$1" -crop "${CARD_W}x${HEADER_H}+${CARD_LEFT}+${HEADER_TOP}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${HAIRLINE#\#}" "${CARD_LEFT}" "${CARD_W}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),\d+: \([^)]*\)\s+#([0-9A-Fa-f]{6})")
dump, wanted = sys.argv[1], sys.argv[2].upper()
left, width = int(sys.argv[3]), int(sys.argv[4])
EDGE = 8
rows = open(dump, encoding="utf-8").read().splitlines()
columns = [
	column
	for column in (
		int(found.group(1))
		for found in (PIXEL.match(line) for line in rows)
		if found and found.group(2).upper() == wanted
	)
	if EDGE <= column < width - EDGE
]
if not columns:
	raise SystemExit(0)
first, last = min(columns), max(columns)
# A control is a box inside the header; a rule under it runs the card's measure.
if last - first > width * 3 // 5:
	raise SystemExit(0)
print(first + left, last + left)
PY
}

# ─── The Composer, Which Is How Every Surface Here Is Reached ────────────────
# The composer is measured once, with nothing open over it: a reading taken
# while a float is up measures the float, and every press after it lands in the
# wrong surface.
measure_composer_card
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"

type_command() { # <slash-command>
	move_px "${COMPOSER_X}" "${COMPOSER_Y}"
	click
	k "ctrl+a"
	k "BackSpace"
	pause 0.3
	t "$1"
	pause 0.8
}

open_dashboard() { # <shot-name>
	type_command "/agents"
	if [ "$1" = agents-empty ]; then shot palette-agents; fi
	k "Return"
	settle 1.5
	shot "$1"
}

# ─── One Agent, Run From The Window's Own Field ──────────────────────────────
# Each run is photographed at the page it opens, with the task typed into the
# field and once the field has been submitted, so a take that reads no agents
# afterwards states which of the three it got as far as. The field is found in
# the first of those frames and pressed in the same place on every later run:
# the row it is on is the page's first, whatever the page lists under it.
FIELD_POINT=""
spawn_from_window() { # <shot-prefix>
	type_command "${SPAWN_ROUTE}"
	k "Return"
	settle 1.5
	shot "$1-page"
	if [ -z "${FIELD_POINT}" ]; then
		FIELD_POINT="$(task_field_point "${SCENE_OUT}/${SCENE_NAME}-$1-page.png")"
		if [ -z "${FIELD_POINT}" ]; then
			abandon_take "$1-page" \
				"the page at ${SPAWN_ROUTE} drew no ink in the control column under its header, so the task field this take runs an agent from was never found"
		fi
		echo "scene: the task field is at ${FIELD_POINT}" >&2
	fi
	read -r FIELD_X FIELD_Y <<<"${FIELD_POINT}"
	move_px "${FIELD_X}" "${FIELD_Y}"
	click
	pause 0.4
	k "ctrl+a"
	k "BackSpace"
	pause 0.2
	t "${PROBE_TASK}"
	pause 0.6
	shot "$1-typed"
	k "Return"
	settle 2.0
	shot "$1-sent"
	k "Escape"
	pause 0.8
}

use_crop "${BODY_LEFT}" "${BODY_TOP}" "${BODY_W}" "${BODY_H}"
open_dashboard agents-empty
EMPTY_BAND="$(segment_band "${SCENE_OUT}/${SCENE_NAME}-agents-empty.png")"

# ─── Two Agents Enter The Session ────────────────────────────────────────────
# The card is closed while they are spawned, so the frames compared below differ
# by the roster and not by a surface that was drawn over one of them.
k "Escape"
pause 0.8
spawn_from_window first-task
spawn_from_window second-task
SPAWNED=0
if [ "${ARM}" != before ]; then
	SPAWNED="$(spawned_count 30)"
	if [ "${SPAWNED}" -lt 2 ]; then
		abandon_take "the-session-runs-the-agents" \
			"the host holds ${SPAWNED} agents beyond main after two presses of the task field, so this take reads a session that has no agents in it"
	fi
	echo "scene: the host holds ${SPAWNED} agents beyond main" >&2
fi

open_dashboard agents-running
SPAWNED_PX="$(shots_differ_pixels agents-empty agents-running)"

# ─── The Other View, From The Card's Own Control ─────────────────────────────
RUNNING_BAND="$(segment_band "${SCENE_OUT}/${SCENE_NAME}-agents-running.png")"
COMMS_PX=0
if [ -n "${RUNNING_BAND}" ]; then
	read -r SEG_LEFT SEG_RIGHT <<<"${RUNNING_BAND}"
	# The trailing segment, pressed a quarter in from the control's right edge:
	# the two segments are as wide as their own labels, and the quarter point
	# lies inside the trailing one for any pair of labels this card draws.
	move_px $(( SEG_RIGHT - (SEG_RIGHT - SEG_LEFT) / 4 )) $(( HEADER_TOP + HEADER_H / 2 ))
	click
	settle 1.0
	shot agents-comms
	COMMS_PX="$(shots_differ_pixels agents-running agents-comms)"
fi

if [ "${ARM}" = before ]; then
	if [ "${SPAWNED_PX}" -ge "${ROSTER_PX}" ]; then
		abandon_take "agents-running" \
			"the baseline's body changed ${SPAWNED_PX} pixels when two agents entered the session, at or over the ${ROSTER_PX} a roster of two draws, so this arm proves nothing about the surface"
	fi
	if [ -n "${RUNNING_BAND}" ]; then
		abandon_take "agents-running" \
			"the baseline's header carries a hairline-edged control at ${RUNNING_BAND}, so this arm proves nothing about the choice of view"
	fi
	echo "scene: before arm -- the surface \`/agents\` opened moved ${SPAWNED_PX} pixels for two" \
		"agents and offers no choice of view" >&2
else
	if [ "${SPAWNED_PX}" -lt "${ROSTER_PX}" ]; then
		abandon_take "agents-running" \
			"the card's body changed ${SPAWNED_PX} pixels when ${SPAWNED} agents entered the session, under the ${ROSTER_PX} a roster of two draws, so the surface did not read the roster the host answered with"
	fi
	if [ -z "${EMPTY_BAND}" ]; then
		abandon_take "agents-empty" \
			"the card drew no hairline-edged control in its header on an empty session, so it offers no choice of view before an agent runs"
	fi
	if [ -z "${RUNNING_BAND}" ]; then
		abandon_take "agents-running" \
			"the card drew no hairline-edged control in its header, so the view it offers cannot be pressed"
	fi
	if [ "${COMMS_PX}" -lt "${ROSTER_PX}" ]; then
		abandon_take "agents-comms" \
			"the body changed ${COMMS_PX} pixels when the trailing segment at ${SEG_LEFT}..${SEG_RIGHT} was pressed, under the ${ROSTER_PX} a second view draws, so the press reached nothing"
	fi
	echo "scene: after arm -- the roster drew ${SPAWNED_PX} pixels for ${SPAWNED} agents," \
		"the choice of view is at ${RUNNING_BAND}, and the second view drew ${COMMS_PX} pixels" >&2
fi
