#!/usr/bin/env bash
# Open a session whose reply carries inline markdown and photograph the
# transcript drawing it.
#
# Records visual evidence for:
#   1. prose-empty      (the created session, holding nothing)
#   2. markdown-prose   (the seeded session, holding a reply with inline markers)
#
# THIS IS THE AFTER ARM OF A PAIR. The before arm is the same driver against a
# build of this tree without the inline reader, so the two frames differ by the
# renderer and by nothing else:
#
#   proof/docker/record-native.sh proof/scenes/desktop-transcript-prose.sh
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<build without the reader> \
#     proof/docker/record-native.sh proof/scenes/desktop-transcript-prose.sh
#
# WHY THE REPLY IS SEEDED. The frame is a claim about how a paragraph is set,
# which means both arms have to draw the same paragraph. A model asked for one
# writes a different one each take -- a dropped delimiter, a reordered clause --
# and the pair then differs by the reply. The paragraph is a committed fixture
# instead (`proof/docker/seed-sessions/`), placed in the session store by
# `proof/docker/seed-demo.sh` for this scene alone, and reached the way an
# operator reaches yesterday's session: the rail's own search.
#
# WHAT IS MEASURED. Three readings, none of which is the frame's own name. The
# search overlay opened, the filter reached its field, and the transcript
# column came to ink where an empty session had none. Then the host is asked,
# on a second connection, what the session it opened actually holds: the raw
# `**` and backticks the fixture carries. A window that drew set prose over a
# host that had already stripped the markers is a pass on the pixels and proves
# nothing, so both ends are read.
#
# NOT RECORDED HERE: that no marker occupies layout width, which is a
# measurement rather than a photograph and is asserted by
# `crates/veyyon-desktop-kit/tests/a-marker-in-prose-is-set-and-not-drawn.rs`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Rail Puts Its Search ──────────────────────────────────────────
# The nav header is a 32px row at the rail's top, inset by the rail's own row
# inset and offset by the rail's top padding. Both numbers are read from the
# tokens this checkout ships, so a retuned rail moves the aim with it.
read -r CONTENT_INSET ROW_INSET FOOTER_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())

print(
    int(scale["spacing"][queue["insets"]["content_inset"]]),
    int(scale["spacing"][queue["insets"]["row_inset"]]),
    int(queue["footer"]["height_px"]),
)
PY
)
if [ -z "${FOOTER_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read the queue layout tokens"
fi
if [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px draws no inline queue rail, so the search is unreachable"
fi

# Inside the search pill and clear of the new-session control at the row's
# trailing edge: the pill is the row's leading child and takes every column the
# 14px icon beside it leaves.
SEARCH_X=$(( WIN_X + ROW_INSET + 32 ))
SEARCH_Y=$(( WIN_Y + TITLEBAR_H + CONTENT_INSET + 16 ))
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"
PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The overlay a palette of session rows draws, the ink a typed filter adds, and
# the ink a page of prose brings to a column that was empty. The last is the
# reading that carries the frame: an empty session draws its own empty state
# and nothing else, so a settled reply is thousands of pixels away from it.
OVERLAY_MIN_PIXELS=20000
FILTER_MIN_PIXELS=800
PROSE_MIN_PIXELS=3000
PROSE_INK_MIN=120

# How tall the ink stands inside the transcript column, from the frame itself.
transcript_ink_height() { # <frame> -> <height in pixels>
	local box height
	box="$(magick "$1" -crop "${TRANSCRIPT_CROP}" +repage -fuzz 8% -trim -format '%h' info: 2>/dev/null || true)"
	height="${box%%[!0-9]*}"
	echo "${height:-0}"
}

# ─── The Session The Fixture Seeded ──────────────────────────────────────────
# Its id and its title come out of the fixture rather than being restated here,
# so a re-seeded transcript cannot leave the scene searching for a title that
# is no longer in the store.
read -r PROSE_SESSION PROSE_TITLE < <(
	python3 - <<'PY'
import json
from pathlib import Path

seed = sorted(Path("/repo/proof/docker/seed-sessions").glob("*.jsonl"))
if not seed:
    raise SystemExit("no seeded session fixture")
row = json.loads(seed[0].read_text().splitlines()[0])
print(row["id"], row["title"])
PY
)
if [ -z "${PROSE_TITLE:-}" ]; then
	abandon_take "the-fixture-names-its-session" "the seeded session fixture states no title to search for"
fi

# ─── 1. The Session Holding Nothing ──────────────────────────────────────────
# The prelude left a session it created and a composer holding a dismissed
# palette, so the pointer is parked off the rail and the column is photographed
# before anything is opened over it.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.5
shot prose-empty
EMPTY_FRAME="${PROBE_DIR}/prose-empty.png"
probe_frame "${EMPTY_FRAME}"

# ─── 2. The Rail's Own Search ────────────────────────────────────────────────
# Opened from the control rather than by the `/` chord: the prelude dismisses a
# palette before this scene starts, and a build whose dismissed overlay does not
# hand the key context back answers no chord at all, which would type the title
# into the composer and submit it as a prompt.
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
SEARCH_OPEN="${PROBE_DIR}/prose-search-open.png"
probe_frame "${SEARCH_OPEN}"

t "${PROSE_TITLE}"
pause 0.8
FILTERED="$(screen_differs_from_frame_pixels_at "${SEARCH_OPEN}" "${WINDOW_CROP}")"
if [ "${FILTERED}" -lt "${FILTER_MIN_PIXELS}" ]; then
	abandon_take "the-filter-reached-its-field" \
		"typing the session's title changed ${FILTERED} pixels of the window, under the ${FILTER_MIN_PIXELS} \
a line of prose inks, so the field never took it and the return would open whichever row was highlighted"
fi

# ─── 3. The Transcript It Opened ─────────────────────────────────────────────
k "Return"
# The pointer goes back to the composer for the frame: a pointer left over the
# rail reveals that row's hover actions, which ink the crop on their own.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
PROSE_DREW=0
for _ in $(seq 1 40); do
	pause 0.5
	PROSE_DREW="$(screen_differs_from_frame_pixels_at "${EMPTY_FRAME}" "${TRANSCRIPT_CROP}")"
	if [ "${PROSE_DREW}" -ge "${PROSE_MIN_PIXELS}" ]; then
		break
	fi
done
if [ "${PROSE_DREW}" -lt "${PROSE_MIN_PIXELS}" ]; then
	abandon_take "the-reply-reached-the-column" \
		"the transcript column is ${PROSE_DREW} pixels from the empty session it opened over, under the \
${PROSE_MIN_PIXELS} a page of prose inks, so the session never opened or its transcript never arrived"
fi
pause 1.0
shot markdown-prose

PROSE_INK="$(transcript_ink_height "${SCENE_OUT}/${SCENE_NAME}-markdown-prose.png")"
if [ "${PROSE_INK}" -lt "${PROSE_INK_MIN}" ]; then
	abandon_take "the-column-holds-a-turn" \
		"the ink in the transcript column stands ${PROSE_INK}px, under the ${PROSE_INK_MIN} a settled \
turn stands, so the frame is an empty session under another session's row"
fi
echo "scene: the search opened ${OPENED}px, the filter drew ${FILTERED}px," \
	"the reply drew ${PROSE_DREW}px and stands ${PROSE_INK}px tall" >&2

# ─── 4. What The Host Handed The Window ──────────────────────────────────────
# Asked last, on a connection of its own, so this cannot be what put the
# transcript on screen. The markers are what the reply carries: a host that had
# already stripped them would leave the window nothing to set, and the frame
# above would prove nothing about the reader under test.
if ! python3 - "${PROSE_SESSION}" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
session = sys.argv[1]
markers = ("**bold weight**", "`inline_code()`", "[the handbook](https://veyyon.dev/docs)")
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
                    missing = [
                        marker for marker in markers if not any(marker in line for line in text)
                    ]
                    if missing:
                        last = f"{len(text)} strings, none carrying {missing[0]!r}"
                        break
                    print(f"the reply carries its markers among {len(text)} strings")
                    raise SystemExit(0)
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"session {session} does not hold the markers the fixture wrote ({last})")
PY
then
	abandon_take "the-reply-carries-its-markers" \
		"the host's transcript for ${PROSE_SESSION} does not hold the raw markers the fixture wrote, \
so the frame states nothing about the reader that sets them"
fi
