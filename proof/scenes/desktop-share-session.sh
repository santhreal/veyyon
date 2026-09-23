#!/usr/bin/env bash
# Share a live session from the native GPUI window, put a real guest on the
# other end of the relay, and photograph what the window draws for it.
#
# Records visual evidence for:
#   1. palette-share  (the palette with `/collab` typed into it)
#   2. share-idle     (what a press of that row opens, with nothing shared)
#   3. share-hosting  (the same card once the share is running)
#   4. share-guest    (the same card with a guest on the relay)
#
# THE PAIR IS TWO BINARIES AND TWO HOSTS. `/collab` reached nothing on the
# window: no palette row offered it, so the word was typed and answered by
# nobody, and a session on this front end could not be put in front of anybody.
# Both arms type the same word into the same palette and press Return on it.
#
#   SCENE_MOTION_FLOOR=5 SCENE_SETTINGS='collab.relayUrl: ws://127.0.0.1:7466' \
#     proof/docker/record-native.sh proof/scenes/desktop-share-session.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=bc300a571b SCENE_MOTION_FLOOR=5 \
#     SCENE_SETTINGS='collab.relayUrl: ws://127.0.0.1:7466' \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/proof-bins/share-before \
#     proof/docker/record-native.sh proof/scenes/desktop-share-session.sh
#
# The take is a still one: a palette opens over a session and a card replaces
# it, so both arms are recorded at the 5 fps floor rather than the 12 fps
# default.
#
# THE RELAY IS THIS CONTAINER'S OWN. `clients/web/scripts/local-relay.ts`
# speaks the relay contract and is started here on the loopback address, so the
# take reaches no network and the link the window draws resolves inside the
# recording session. The relay is named to the host through the
# `collab.relayUrl` setting, seeded before the session starts, because a take
# that typed a relay into a field would photograph the field rather than the
# share.
#
# THE GUEST IS A REAL ONE. `proof/lib/collab-guest.ts` joins with the link the
# host minted, sealing its greeting with the room key, so the participant row
# in the last frame is a party the host admitted rather than a row this scene
# drew. The link is read from the host's own `Share` section over a second
# socket: it never reaches the relay, which is the point of sealing it.
#
# WHAT IS MEASURED, in the card's own body rather than the whole frame, whose
# queue rail states an elapsed time that ticks between any two shots:
#
#   * The body a started share changed, against the body the card drew with
#     nothing shared. Four links, their copy controls and a participant row ink
#     far more than the two controls they replace.
#   * The body a guest changed, against the body drawn while hosting alone.
#   * What the host holds, in its own vocabulary over a second socket, so a
#     body that drew no link is the window's doing rather than a share that
#     never started.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
RELAY_PORT="${SCENE_RELAY_PORT:-7466}"
RELAY_URL="ws://127.0.0.1:${RELAY_PORT}"

# ─── The Relay This Take Runs On ─────────────────────────────────────────────
# Started here rather than in the recorder, because it is this scene's own
# fixture: a take of any other surface has no relay in it at all.
RELAY_LOG="${TMPDIR}/local-relay.log"
bun /repo/clients/web/scripts/local-relay.ts --port="${RELAY_PORT}" >"${RELAY_LOG}" 2>&1 &
RELAY_PID=$!
# No exit trap: the scene is sourced by the session driver, so a trap set here
# is the driver's for the rest of the take. The relay and the guest are killed
# where they are finished with, and the container ends either of them that a
# take abandons before it gets there.
RELAY_UP=0
for _ in $(seq 1 40); do
	if grep -q "listening on" "${RELAY_LOG}" 2>/dev/null; then
		RELAY_UP=1
		break
	fi
	sleep 0.25
done
if [ "${RELAY_UP}" != "1" ]; then
	abandon_take "the-relay-is-up" \
		"the offline relay did not report a listener within 10s, so no share in this take could have reached one: $(tail -3 "${RELAY_LOG}" 2>/dev/null)"
fi
echo "scene: the offline relay is listening on ${RELAY_URL}" >&2

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

# The link the host minted, read from its own section rather than from the
# frame: a link is 80 characters of base64url and no reading of pixels recovers
# it, which is why the guest is given the host's answer instead.
share_link() { # <seconds> -> the full link, or ""
	host_call '{"id":3,"action":"RefreshShare"}' Share "$1" '"link"' |
		python3 -c 'import json,sys; body=sys.stdin.read().strip(); print((json.loads(body).get("link") or "") if body else "")'
}

share_participants() { # <seconds> -> a count
	host_call '{"id":4,"action":"RefreshShare"}' Share "$1" |
		python3 -c 'import json,sys; body=sys.stdin.read().strip(); print(len(json.loads(body).get("participants") or []) if body else 0)'
}

# ─── Where The Share Card Draws ──────────────────────────────────────────────
# A card the window centres in the room under the titlebar, at the measures its
# own token file states, clamped by the margin every float keeps. Read from the
# tokens this checkout ships, so a retheme moves the crops with the surface.
read -r CARD_W CARD_H TITLEBAR_H MARGIN PADDING HEAD_LINE STEP < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

print(
	token_px.value_of("surface/share.toml", "layout.card_width_px"),
	token_px.value_of("surface/share.toml", "layout.card_height_px"),
	token_px.value_of("surface/shell.toml", "titlebar.height_px"),
	token_px.value_of("scale.toml", "spacing.s4"),
	token_px.value_of("surface/share.toml", "layout.padding"),
	int(token_px.load("scale.toml")["type"]["size"]["head"]["line_height"]),
	token_px.value_of("scale.toml", "spacing.s4"),
)
PY
)
ROOM_H=$(( WIN_H - TITLEBAR_H ))
if (( CARD_W > WIN_W - 2 * MARGIN )); then CARD_W=$(( WIN_W - 2 * MARGIN )); fi
if (( CARD_H > ROOM_H - 2 * MARGIN )); then CARD_H=$(( ROOM_H - 2 * MARGIN )); fi
CARD_LEFT=$(( WIN_X + (WIN_W - CARD_W) / 2 ))
CARD_TOP=$(( WIN_Y + TITLEBAR_H + (ROOM_H - CARD_H) / 2 ))

HEADER_TOP=$(( CARD_TOP + PADDING ))
HEADER_H=$(( HEAD_LINE + STEP ))
BODY_TOP=$(( HEADER_TOP + HEADER_H + STEP ))
BODY_LEFT=$(( CARD_LEFT + PADDING ))
BODY_W=$(( CARD_W - 2 * PADDING ))
BODY_H=$(( CARD_TOP + CARD_H - PADDING - BODY_TOP ))
if (( BODY_H < 160 )); then
	abandon_take "the-card-has-a-body" \
		"the card leaves ${BODY_H}px under its header, too little to hold the links this scene reads"
fi
echo "scene: the share card is ${CARD_W}x${CARD_H} at +${CARD_LEFT}+${CARD_TOP}," \
	"its body ${BODY_W}x${BODY_H} at +${BODY_LEFT}+${BODY_TOP}" >&2

# How much of the card's body a running share may draw in. Four links, their
# copy controls and a participant row ink thousands of pixels; a card that only
# swapped a word moves a few hundred.
HOSTING_PX=1200
# A participant row is one line of text and a capability beside it, so it is
# held to less than a whole share's worth of ink.
GUEST_PX=120

# ─── The Composer, Which Is How Every Surface Here Is Reached ────────────────
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

use_crop "${BODY_LEFT}" "${BODY_TOP}" "${BODY_W}" "${BODY_H}"

type_command "/collab"
shot palette-share
k "Return"
settle 1.5
shot share-idle

# ─── The Share Is Started From The Card's Own Control ────────────────────────
# The control is found by the role it is drawn in rather than by a count of
# rows: the card composes its own body, and a scene that counted lines would
# carry a second copy of that composition. A control that starts something is
# filled in the accent role, so the fill is a region rather than a glyph and
# its centroid is inside the control whatever label it carries.
ACCENT="$(theme_colour role.accent)"
start_control_point() { # <png> -> "<x> <y>" to press, or "" for a body with no control
	local dump="${TMPDIR}/frame-compare/share-control.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${BODY_W}x${BODY_H}+${BODY_LEFT}+${BODY_TOP}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${ACCENT#\#}" "${BODY_LEFT}" "${BODY_TOP}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")
dump, wanted = sys.argv[1], sys.argv[2].upper()
left, top = int(sys.argv[3]), int(sys.argv[4])
want = tuple(int(wanted[at : at + 2], 16) for at in (0, 2, 4))
fill = []
for line in open(dump, encoding="ascii"):
	found = PIXEL.match(line)
	if not found:
		continue
	colour = found.group(3).upper()
	got = tuple(int(colour[at : at + 2], 16) for at in (0, 2, 4))
	if all(abs(a - b) <= 10 for a, b in zip(got, want)):
		fill.append((int(found.group(1)), int(found.group(2))))
# A control is a filled shape. A handful of accent pixels is a focus ring or an
# underline, and pressing its centre lands between two controls.
if len(fill) < 400:
	raise SystemExit(0)
# The leading control, which is the one that starts a share anybody may prompt
# through: the read-only control sits after it on the same row.
first = min(row for _, row in fill)
band = [(column, row) for column, row in fill if first <= row < first + 64]
print(left + sum(column for column, _ in band) // len(band), top + sum(row for _, row in band) // len(band))
PY
}

START_POINT="$(start_control_point "${SCENE_OUT}/${SCENE_NAME}-share-idle.png")"
HOSTING_PX_SEEN=0
GUEST_PX_SEEN=0
LINK=""
PARTIES=0
if [ -n "${START_POINT}" ]; then
	read -r START_X START_Y <<<"${START_POINT}"
	move_px "${START_X}" "${START_Y}"
	click
	settle 2.5
	shot share-hosting
	HOSTING_PX_SEEN="$(shots_differ_pixels share-idle share-hosting)"
	LINK="$(share_link 20)"
fi

if [ -n "${LINK}" ]; then
	echo "scene: the host minted a link for room ${LINK##*/r/}" >&2
	bun /repo/proof/lib/collab-guest.ts "${LINK}" --name=Wren >"${TMPDIR}/collab-guest.log" 2>&1 &
	GUEST_PID=$!
	settle 3.0
	shot share-guest
	GUEST_PX_SEEN="$(shots_differ_pixels share-hosting share-guest)"
	PARTIES="$(share_participants 15)"
fi

# The readings are taken, so the fixtures go. A share the host still holds
# would keep reconnecting to a relay that is no longer there and write that
# into the window while the session is torn down.
kill "${GUEST_PID:-0}" 2>/dev/null || true
kill "${RELAY_PID}" 2>/dev/null || true

if [ "${ARM}" = before ]; then
	if [ -n "${LINK}" ]; then
		abandon_take "share-hosting" \
			"the baseline started a share and minted ${LINK}, so this arm proves nothing about a window that could not share a session"
	fi
	echo "scene: before arm -- \`/collab\` was typed and pressed, the window answered with" \
		"${HOSTING_PX_SEEN} pixels of change and the host minted no link" >&2
else
	if [ -z "${START_POINT}" ]; then
		abandon_take "share-idle" \
			"the card drew no control in its body, so the share this take starts could not be pressed"
	fi
	if [ "${HOSTING_PX_SEEN}" -lt "${HOSTING_PX}" ]; then
		abandon_take "share-hosting" \
			"the card's body changed ${HOSTING_PX_SEEN} pixels when the share started, under the ${HOSTING_PX} two links and a participant row draw, so the surface did not read the share the host started"
	fi
	if [ -z "${LINK}" ]; then
		abandon_take "share-hosting" \
			"the host answered with no link after the start control was pressed, so this take photographed a card rather than a share"
	fi
	if [ "${GUEST_PX_SEEN}" -lt "${GUEST_PX}" ]; then
		abandon_take "share-guest" \
			"the card's body changed ${GUEST_PX_SEEN} pixels when a guest joined, under the ${GUEST_PX} a participant row draws, so the surface did not read the party the host admitted"
	fi
	if [ "${PARTIES}" -lt 2 ]; then
		abandon_take "share-guest" \
			"the host holds ${PARTIES} parties on the relay after a guest joined: $(tail -3 "${TMPDIR}/collab-guest.log" 2>/dev/null)"
	fi
	echo "scene: after arm -- the share drew ${HOSTING_PX_SEEN} pixels, the guest drew" \
		"${GUEST_PX_SEEN} more, and the host holds ${PARTIES} parties on the relay" >&2
fi
