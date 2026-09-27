#!/usr/bin/env bash
# Open a session holding every recorded message that is neither a prompt nor a
# model reply, and photograph the desktop transcript drawing them.
#
# Records visual evidence for:
#   1. side-empty      (the created session, holding nothing)
#   2. side-messages   (the seeded session, holding all eight side messages)
#
# THIS IS THE AFTER ARM OF A PAIR. The before arm is the same driver against a
# build of this tree without the typed card, where the eight messages reach the
# window as their own text and set as one undifferentiated column:
#
#   proof/docker/record-native.sh proof/scenes/desktop-side-messages.sh
#   SCENE_ARM=before PROOF_BASE_REF=<commit before the card> \
#     PROOF_NATIVE_BEFORE_BINARY=<build without the card> \
#     proof/docker/record-native.sh proof/scenes/desktop-side-messages.sh
#
# WHY THE SESSION IS SEEDED. Eight of these messages cannot be produced on
# demand: a guest has to connect, a second agent has to send, an advisor has to
# run, a language server has to answer late. `proof/docker/seed-side-messages.ts`
# writes one of each in the shape its producer writes, through the product's own
# session storage, and fails closed on a variant it does not cover. The scene
# reaches the result the way an operator reaches yesterday's session: the rail's
# own search.
#
# WHAT IS MEASURED. Three readings from the frames, none of which is the frame's
# own name: the search overlay opened, the filter reached its field, and the
# transcript column came to ink where an empty session had none. Then the host is
# asked, on a connection of its own, which typed cards the transcript it handed
# the window actually carries. The after arm requires one card per variant the
# seed wrote, so a ninth variant that reaches the window as prose fails here
# rather than passing unnoticed; the before arm requires none, and both arms
# require the seeded text, so an arm that opened the wrong session is not read as
# a renderer result.
#
# NOT RECORDED HERE: which view each variant projects to, which
# `packages/coding-agent/test/gui-host/a-message-that-is-not-the-conversation-says-what-it-is.test.ts`
# sweeps over the whole union, and the spans a report block offers, which
# `crates/veyyon-desktop-surface/tests/every-block-states-its-spans-or-records-that-it-offers-none.rs`
# pins.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
if [ "${ARM}" != "after" ] && [ "${ARM}" != "before" ]; then
	abandon_take "the-arm-is-named" "SCENE_ARM is '${ARM}', which is neither arm"
fi

# ─── Where The Rail Puts Its Search ──────────────────────────────────────────
# Read from the tokens this checkout ships, so a retuned rail moves the aim with
# it rather than leaving the press to land on a row.
read -r CONTENT_INSET ROW_INSET < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

print(
    token_px.value_of("surface/queue.toml", "geometry.insets.content_inset"),
    token_px.value_of("surface/queue.toml", "geometry.insets.row_inset"),
)
PY
)
if [ -z "${ROW_INSET:-}" ]; then
	abandon_take "tokens-resolved" "could not read the queue layout tokens"
fi
if [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" \
		"window width ${WIN_W}px draws no inline queue rail, so the search is unreachable"
fi

SEARCH_X=$(( WIN_X + ROW_INSET + 32 ))
SEARCH_Y=$(( WIN_Y + TITLEBAR_H + CONTENT_INSET + 16 ))
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"
PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The overlay a palette of session rows draws, the ink a typed filter adds, and
# the ink eight settled cards bring to a column that was empty.
OVERLAY_MIN_PIXELS=20000
FILTER_MIN_PIXELS=800
CARDS_MIN_PIXELS=3000
CARDS_INK_MIN=120

transcript_ink_height() { # <frame> -> <height in pixels>
	local box height
	box="$(magick "$1" -crop "${TRANSCRIPT_CROP}" +repage -fuzz 8% -trim -format '%h' info: 2>/dev/null || true)"
	height="${box%%[!0-9]*}"
	echo "${height:-0}"
}

# ─── The Session The Seed Wrote ──────────────────────────────────────────────
# Its id, its title and the variants it holds come out of the seed's own
# manifest, so a re-seeded fixture cannot leave the scene searching for a row
# that is no longer in the store or checking for a card it never wrote.
MANIFEST="${HOME}/.veyyon/proof/side-messages.json"
read -r SIDE_SESSION SIDE_TITLE < <(
	python3 - "${MANIFEST}" <<'PY'
import json
import sys
from pathlib import Path

manifest = Path(sys.argv[1])
if not manifest.is_file():
    raise SystemExit("")
seed = json.loads(manifest.read_text())
print(seed["id"], seed["title"])
PY
)
if [ -z "${SIDE_TITLE:-}" ]; then
	abandon_take "the-seed-names-its-session" \
		"${MANIFEST} states no seeded session, so the scene has no row to search for"
fi

# ─── 1. The Session Holding Nothing ──────────────────────────────────────────
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.5
shot side-empty
EMPTY_FRAME="${PROBE_DIR}/side-empty.png"
probe_frame "${EMPTY_FRAME}"

# ─── 2. The Rail's Own Search ────────────────────────────────────────────────
# Opened from the control rather than by the `/` chord: the prelude dismisses a
# palette before this scene starts, and a build whose dismissed overlay does not
# hand the key context back would type the title into the composer and submit it.
move_px "${SEARCH_X}" "${SEARCH_Y}"
pause 0.3
click
pause 0.8
OPENED="$(screen_differs_from_frame_pixels_at "${EMPTY_FRAME}" "${WINDOW_CROP}")"
if [ "${OPENED}" -lt "${OVERLAY_MIN_PIXELS}" ]; then
	abandon_take "the-search-opened" \
		"a press on the rail's search at ${SEARCH_X},${SEARCH_Y} changed ${OPENED} pixels of the window, \
under the ${OVERLAY_MIN_PIXELS} a palette of session rows draws, so the title after it would land in the composer"
fi
SEARCH_OPEN="${PROBE_DIR}/side-search-open.png"
probe_frame "${SEARCH_OPEN}"

t "${SIDE_TITLE}"
pause 0.8
FILTERED="$(screen_differs_from_frame_pixels_at "${SEARCH_OPEN}" "${WINDOW_CROP}")"
if [ "${FILTERED}" -lt "${FILTER_MIN_PIXELS}" ]; then
	abandon_take "the-filter-reached-its-field" \
		"typing the session's title changed ${FILTERED} pixels of the window, under the ${FILTER_MIN_PIXELS} \
a line of prose inks, so the field never took it and the return would open whichever row was highlighted"
fi

# ─── 3. The Transcript It Opened ─────────────────────────────────────────────
k "Return"
# The pointer goes back to the composer for the frame: left over the rail it
# reveals that row's hover actions, which ink the crop on their own.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
CARDS_DREW=0
for _ in $(seq 1 40); do
	pause 0.5
	CARDS_DREW="$(screen_differs_from_frame_pixels_at "${EMPTY_FRAME}" "${TRANSCRIPT_CROP}")"
	if [ "${CARDS_DREW}" -ge "${CARDS_MIN_PIXELS}" ]; then
		break
	fi
done
if [ "${CARDS_DREW}" -lt "${CARDS_MIN_PIXELS}" ]; then
	abandon_take "the-messages-reached-the-column" \
		"the transcript column is ${CARDS_DREW} pixels from the empty session it opened over, under the \
${CARDS_MIN_PIXELS} eight settled messages ink, so the session never opened or its transcript never arrived"
fi
pause 1.0
shot side-messages

CARDS_INK="$(transcript_ink_height "${SCENE_OUT}/${SCENE_NAME}-side-messages.png")"
if [ "${CARDS_INK}" -lt "${CARDS_INK_MIN}" ]; then
	abandon_take "the-column-holds-the-messages" \
		"the ink in the transcript column stands ${CARDS_INK}px, under the ${CARDS_INK_MIN} a settled \
transcript stands, so the frame is an empty session under another session's row"
fi
echo "scene: the search opened ${OPENED}px, the filter drew ${FILTERED}px," \
	"the messages drew ${CARDS_DREW}px and stand ${CARDS_INK}px tall" >&2

# ─── 4. What The Host Handed The Window ──────────────────────────────────────
# Asked last, on a connection of its own, so this cannot be what put the
# transcript on screen. A window that drew cards over a host that sent none
# would be a pass on the pixels and prove nothing, so both ends are read.
if ! python3 - "${SIDE_SESSION}" "${MANIFEST}" "${ARM}" <<'PY'
import json
import os
import socket
import sys
import time
from pathlib import Path

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
session = sys.argv[1]
seeded = sorted(json.loads(Path(sys.argv[2]).read_text())["variants"])
arm = sys.argv[3]
# Written by every one of the eight messages the seed holds, so an arm that
# opened another row is reported as the wrong session rather than as a renderer
# that stopped drawing.
marker = "tan_7"
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


def custom_variants(value, found):
    if isinstance(value, dict):
        card = value.get("Custom")
        if isinstance(card, dict) and isinstance(card.get("variant"), str):
            found.add(card["variant"])
        for item in value.values():
            custom_variants(item, found)
    elif isinstance(value, list):
        for item in value:
            custom_variants(item, found)
    return found


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
                    transcript = snapshot["Transcript"]
                    text = list(strings(transcript))
                    if not any(marker in one for one in text):
                        last = f"{len(text)} strings, none carrying {marker!r}"
                        break
                    drawn = sorted(custom_variants(transcript, set()))
                    if arm == "after" and drawn != seeded:
                        missing = [one for one in seeded if one not in drawn]
                        extra = [one for one in drawn if one not in seeded]
                        last = f"cards {drawn}, missing {missing}, unseeded {extra}"
                        break
                    if arm == "before" and drawn:
                        last = f"cards {drawn}, where a build without the card states none"
                        break
                    print(f"the transcript carries {len(drawn)} typed cards among {len(text)} strings")
                    raise SystemExit(0)
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"session {session} does not hold the cards the {arm} arm requires ({last})")
PY
then
	abandon_take "the-transcript-carries-its-cards" \
		"the host's transcript for ${SIDE_SESSION} does not hold the cards the ${ARM} arm requires, \
so the frame states nothing about the renderer that draws them"
fi
