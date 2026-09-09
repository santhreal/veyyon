#!/usr/bin/env bash
# Run one turn in each of two sessions in the native GPUI window, switch
# between them, and photograph the transcript each session is holding.
#
# Records visual evidence for:
#   1. the-transcript-of-the-session-on-screen  (session A, holding its own turn)
#   2. the-transcript-of-the-other-session      (session B, holding a different turn)
#   3. the-transcript-came-back-with-its-session (session A again, holding turn A)
#
# THIS IS NOT A BEFORE AND AFTER. Frames 1 and 2 are two states of one surface
# and frame 3 is the first state reached a second time; the whole set comes from
# one driver and one executable. The reducer's session agreement -- a header
# ahead of the transcript it introduces, a created session in hand before it is
# listed, a delisted session taking its transcript with it -- is asserted by
# `crates/veyyon-desktop-model/tests/a-session-created-or-branched-is-the-one-in-hand-before-it-is-listed.rs`,
# `a-session-the-host-stopped-listing-is-not-still-the-one-in-hand.rs` and, on
# the host side, by
# `packages/coding-agent/test/gui-host/a-transcript-arrives-behind-the-header-that-says-whose-it-is.test.ts`.
# What no suite can show is the window on two sessions: this scene is that, and
# it claims nothing about a commit before it.
#
# WHAT IS MEASURED. Three readings, and the third is the one that matters. The
# two sessions run prompts of different shape -- one line of prose against
# twelve lines of digits -- so the transcript column differs between frames 1
# and 2 by pages of ink. Frame 3 is then read against frame 1 over the same
# column: a switch that brought back the right transcript leaves them within a
# fraction of that difference, and one that left session B's turn under session
# A's row, or dropped the transcript and drew an empty session, lands nowhere
# near it. The rail states its own side of it: the selected card is read out of
# each frame, and the card frame 3 selects is the card frame 1 selected.
#
# The host is asked last, and separately: session A's transcript holds A's
# prompt and not B's, and session B's holds B's and not A's. A window drawing
# the right frames over a host that put both turns in one session is a pass on
# the pixels and a defect, so both are read.
#
# WHERE THE CARDS ARE IS READ, NOT COUNTED. The selected card is found by its
# own fill, and the other session's row is the card next to it, because the rail
# draws whatever sections its sessions come to and a card counted down from the
# rail's top lands a section out.
#
# NOT RECORDED HERE: a session deleted while it is on screen, which is the
# third agreement above and is a rail with one fewer row rather than a
# transcript; and the tree a branch makes, which the queue rail draws as
# placement rather than as transcript.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-session-transcript.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── What A Card Measures ────────────────────────────────────────────────────
# Read from the tokens this checkout ships rather than restated as literals, so
# a retuned row height moves the rectangles the frames are read over.
read -r CARD_PX FOOTER_PX CONTENT_INSET NAV_HEADER_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())

gap_below = scale["spacing"][queue["section_layout"]["gap_below"]]
content_inset = scale["spacing"][queue["insets"]["content_inset"]]

print(
    int(queue["row_heights"]["card_px"]),
    int(queue["footer"]["height_px"]),
    int(content_inset),
    int(content_inset + 32 + gap_below),
)
PY
)
if [ -z "${NAV_HEADER_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read queue layout tokens"
fi

if [ "${WIN_W}" -le 800 ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px has no queue rail"
fi

RAIL_LEFT=$(( WIN_X + CONTENT_INSET ))
RAIL_LIST_TOP=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
RAIL_LIST_BOTTOM=$(( WIN_Y + WIN_H - FOOTER_PX ))
CARD_X=$(( WIN_X + RAIL_W / 2 ))
TRANSCRIPT_CROP="$(( WIN_W - RAIL_W ))x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+$(( WIN_X + RAIL_W ))+$(( WIN_Y + TITLEBAR_H ))"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The ink two transcripts of different shape differ by, and the share of it a
# transcript that came back is allowed to differ from the one it came back to.
# A settled transcript of one session measures a few dozen pixels against
# itself, so an eighth of a page of prose is far above the renderer's noise and
# far below a different session's turn.
TRANSCRIPT_SWITCH_MIN=1500
RETURN_SHARE=8
SWITCH_MIN_PIXELS=100
# How tall the ink in the transcript column stands when a session is holding a
# settled turn. A session holding nothing draws its empty state and little
# else, so this is what separates the two sessions that ran a turn from the
# seeded session sitting under them: a card position alone cannot, and this
# scene claims no identity from where a card is.
TURN_INK_MIN=120

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

selected_card() { # <frame> -> <top> <left>
	python3 "${MEASURE}" selected-card "$1" "${RAIL_LEFT}" "${RAIL_LIST_TOP}" \
		"$(( RAIL_W - 2 * CONTENT_INSET ))" "$(( RAIL_LIST_BOTTOM - RAIL_LIST_TOP ))" "${CARD_PX}"
}

# How tall the ink stands inside the transcript column, from the frame itself.
transcript_ink_height() { # <frame> -> <height in pixels>
	local box height
	box="$(magick "$1" -crop "${TRANSCRIPT_CROP}" +repage -fuzz 8% -trim -format '%h' info: 2>/dev/null || true)"
	height="${box%%[!0-9]*}"
	echo "${height:-0}"
}

# ─── What The Host Holds For One Session ─────────────────────────────────────
# The window's own connection is left alone: this asks on a second one, after
# every frame is taken, so a `LoadTranscript` here cannot be what put a
# transcript on screen.
session_settled() { # <session-id> <seconds>
python3 - "$1" "${2:-180}" <<'PY'
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
last = "no host frame"


def provider_error(row):
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
                    row = next((r for r in sessions["value"] if r["id"] == wanted), None)
                    if row is None:
                        last = f"session {wanted} missing from the host snapshot"
                        break
                    last = f"status={row.get('status')}, messages={row.get('message_count', 0)}"
                    if row.get("status") in {"Error", "Aborted"}:
                        raise SystemExit(f"the turn ended {row['status']} ({last}): {provider_error(row)}")
                    if row.get("status") == "Complete" and row.get("message_count", 0) >= 2:
                        print(f"the turn settled ({last})")
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"the turn never settled ({last})")
PY
}

transcript_agrees() { # <session-id> <text-it-holds> <text-it-does-not>
python3 - "$1" "$2" "$3" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
session, held, absent = sys.argv[1], sys.argv[2], sys.argv[3]
request = json.dumps({"id": 1, "action": {"LoadTranscript": {"session": session, "before": None}}})
deadline = time.monotonic() + 30
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
                    text = list(strings(snapshot["Transcript"]))
                    if any(absent in line for line in text):
                        raise SystemExit(f"session {session} holds the other session's prompt {absent!r}")
                    if any(held in line for line in text):
                        print(f"session {session} holds its own prompt among {len(text)} strings")
                        raise SystemExit(0)
                    last = f"{len(text)} strings, none carrying {held!r}"
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"session {session} does not hold its own prompt ({last})")
PY
}

# ─── 1. The Model Both Turns Run On ──────────────────────────────────────────
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

# ─── 2. Session A Runs Its Turn ──────────────────────────────────────────────
# Session A is the one the shared prelude created, and its id is what the
# prelude wrote. One line of prose, asked for as the whole reply, so the
# transcript it comes to is a different shape from session B's.
SESSION_A="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])))' "${SCENE_RUNTIME_DIR}/created-session.json")"
MARKER_A="alpha-one-session"
MARKER_B="Count from 1 to 12"
submit_prompt "Reply with the words ${MARKER_A} and nothing else. Do not use tools."
if ! session_settled "${SESSION_A}" 180; then
	abandon_take "the-first-session-ran-its-turn" \
		"session A never settled a turn, so its transcript states nothing to compare"
fi

# ─── 3. Session B Runs A Turn Of Another Shape ───────────────────────────────
# The baseline is retaken before the creation, so the id the probe reports is
# session B alone rather than either of the two sessions created since the take
# began.
if ! native_session_ready before; then
	abandon_take "the-host-listed-its-sessions" "the host returned no session snapshot before session B was created"
fi
k "ctrl+n"
if ! native_session_ready created; then
	abandon_take "the-second-session-was-created" "the session-creation chord produced no session within 10s"
fi
pause 1.5
SESSION_B="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])))' "${SCENE_RUNTIME_DIR}/created-session.json")"
if [ "${SESSION_A}" = "${SESSION_B}" ]; then
	abandon_take "the-two-sessions-are-two" \
		"the host reports one session for both turns (${SESSION_A}), so no switch happens between them"
fi
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
submit_prompt "${MARKER_B} in your reply, one number per line as digits, and nothing else. Do not use tools."
if ! session_settled "${SESSION_B}" 180; then
	abandon_take "the-second-session-ran-its-turn" \
		"session B never settled a turn, so both frames would draw one transcript"
fi

# ─── 4. Switching Is Clicking A Card By Where It Is ──────────────────────────
# The pointer rests on the composer for every frame, so no row carries hover
# styling in any of them and the turn footer stays hidden in all three.
# `SELECTED_TOP` is where the answer goes rather than the function's output: a
# guard that fires inside a command substitution ends the subshell and leaves
# the take running on whatever the substitution came to, so the switch reports
# through a name and abandons in the shell that can end the take.
#
# The two cards are clicked at their own tops rather than walked from the
# selected one, because the rail also lists the seeded session: a walk downward
# reaches a third row on the second step. The click asserts the selection lands
# on the card that was clicked, which is what states a card is there at all.
SELECTED_TOP=0
switch_to_card() { # <named-guard> <card-top> -> sets SELECTED_TOP
	local guard="$1" target="$2" before="${PROBE_DIR}/switch-${1}.png" top left moved after_top after_left
	move_px "${COMPOSER_X}" "${COMPOSER_Y}"
	pause 0.5
	probe_frame "${before}"
	read -r top left < <(selected_card "${before}") || \
		abandon_take "${guard}" "the rail's selected card was not readable before the switch"
	if [ "${top}" = "${target}" ]; then
		abandon_take "${guard}" \
			"the rail already selects the card at ${target}px, so clicking it switches nothing"
	fi
	move_px "${CARD_X}" "$(( target + CARD_PX / 2 ))"
	pause 0.3
	click
	pause 1.5
	move_px "${COMPOSER_X}" "${COMPOSER_Y}"
	pause 1.0
	moved="$(screen_differs_from_frame_pixels_at "${before}" "${WINDOW_CROP}")"
	if [ "${moved}" -lt "${SWITCH_MIN_PIXELS}" ]; then
		abandon_take "${guard}" \
			"the click on the card at ${target}px changed ${moved}px of the window, under the ${SWITCH_MIN_PIXELS} a session switch draws"
	fi
	probe_frame "${PROBE_DIR}/switched-${1}.png"
	read -r after_top after_left < <(selected_card "${PROBE_DIR}/switched-${1}.png") || \
		abandon_take "${guard}" "the rail's selected card was not readable after the switch"
	if [ "${after_top}" != "${target}" ]; then
		abandon_take "${guard}" \
			"the rail selects the card at ${after_top}px after a click on the card at ${target}px, so the click landed on another row"
	fi
	SELECTED_TOP="${after_top}"
	echo "scene: the rail moved its selection from ${top}px to ${after_top}px, and the window changed ${moved}px" >&2
}

# The take stands on the session that ran last, so the selected card is one of
# the two that hold a turn and the card under it is the other.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.5
probe_frame "${PROBE_DIR}/before-the-first-switch.png"
read -r CARD_LAST_RUN CARD_LEFT < <(selected_card "${PROBE_DIR}/before-the-first-switch.png") || \
	abandon_take "the-rail-selects-the-session-that-ran" \
		"the rail's selected card was not readable before any switch"
CARD_UNDER_IT=$(( CARD_LAST_RUN + CARD_PX ))
if [ "$(( CARD_UNDER_IT + CARD_PX ))" -gt "${RAIL_LIST_BOTTOM}" ]; then
	abandon_take "the-rail-lists-a-card-under-the-selected-one" \
		"the card under the selected one would end at $(( CARD_UNDER_IT + CARD_PX ))px, past the ${RAIL_LIST_BOTTOM}px the rail list reaches"
fi

# ─── 5. Frame 1: One Session And Its Own Turn ────────────────────────────────
switch_to_card the-first-session-is-selected "${CARD_UNDER_IT}"
CARD_A="${SELECTED_TOP}"
shot the-transcript-of-the-session-on-screen
FRAME_A="${SCENE_OUT}/${SCENE_NAME}-the-transcript-of-the-session-on-screen.png"

# ─── 6. Frame 2: The Other Session And Another Turn ──────────────────────────
switch_to_card the-second-session-is-selected "${CARD_LAST_RUN}"
CARD_B="${SELECTED_TOP}"
shot the-transcript-of-the-other-session
FRAME_B="${SCENE_OUT}/${SCENE_NAME}-the-transcript-of-the-other-session.png"

# ─── 7. Frame 3: The First Session Again ─────────────────────────────────────
switch_to_card the-first-session-is-selected-again "${CARD_UNDER_IT}"
CARD_A_AGAIN="${SELECTED_TOP}"
shot the-transcript-came-back-with-its-session
FRAME_A_AGAIN="${SCENE_OUT}/${SCENE_NAME}-the-transcript-came-back-with-its-session.png"

# Neither photographed card is the seeded session sitting under the two that
# ran: both frames are shown to hold ink where a settled turn inks.
INK_A="$(transcript_ink_height "${FRAME_A}")"
INK_B="$(transcript_ink_height "${FRAME_B}")"
if [ "${INK_A}" -lt "${TURN_INK_MIN}" ] || [ "${INK_B}" -lt "${TURN_INK_MIN}" ]; then
	abandon_take "both-photographed-sessions-hold-a-turn" \
		"the transcript column inks ${INK_A}px in the first frame and ${INK_B}px in the second, under the ${TURN_INK_MIN}px a settled turn stands, so one card is a session holding nothing"
fi

# ─── 8. What The Three Frames State ─────────────────────────────────────────
if [ "${CARD_A}" != "${CARD_A_AGAIN}" ]; then
	abandon_take "the-rail-came-back-to-the-same-row" \
		"the rail selects the card at ${CARD_A_AGAIN}px after switching back, against the ${CARD_A}px it selected before, so the second switch landed on a third row"
fi
if [ "${CARD_A}" = "${CARD_B}" ]; then
	abandon_take "the-rail-drew-two-rows" \
		"both switches selected the card at ${CARD_A}px, so one row is standing in for two sessions"
fi

SWITCH_PX="$(frames_differ_pixels_at "${FRAME_A}" "${FRAME_B}" "${TRANSCRIPT_CROP}")"
RETURN_PX="$(frames_differ_pixels_at "${FRAME_A}" "${FRAME_A_AGAIN}" "${TRANSCRIPT_CROP}")"
if [ "${SWITCH_PX}" -lt "${TRANSCRIPT_SWITCH_MIN}" ]; then
	abandon_take "the-two-sessions-hold-two-transcripts" \
		"the transcript column differs by ${SWITCH_PX}px between the two sessions, under the ${TRANSCRIPT_SWITCH_MIN} two turns of different shape ink, so both frames may be drawing one transcript"
fi
if [ "${RETURN_PX}" -gt "$(( SWITCH_PX / RETURN_SHARE ))" ]; then
	abandon_take "the-transcript-came-back-with-its-session" \
		"the transcript column differs by ${RETURN_PX}px from the frame of the same session, over the $(( SWITCH_PX / RETURN_SHARE ))px an eighth of the ${SWITCH_PX}px between two sessions allows, so the switch back did not bring session A's turn with it"
fi

# ─── 9. What The Host Holds ─────────────────────────────────────────────────
if ! transcript_agrees "${SESSION_A}" "${MARKER_A}" "${MARKER_B}"; then
	abandon_take "the-first-session-holds-its-own-turn" \
		"the host's transcript for session A does not hold session A's prompt alone"
fi
if ! transcript_agrees "${SESSION_B}" "${MARKER_B}" "${MARKER_A}"; then
	abandon_take "the-second-session-holds-its-own-turn" \
		"the host's transcript for session B does not hold session B's prompt alone"
fi

echo "scene: the transcript column differs ${SWITCH_PX}px between the two sessions and ${RETURN_PX}px" \
	"between two frames of the first; the rail selects ${CARD_A}px, ${CARD_B}px, ${CARD_A}px" >&2
