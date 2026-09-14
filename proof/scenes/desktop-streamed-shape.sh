#!/usr/bin/env bash
# Open a session whose reply carries a pipe table and photograph the
# transcript drawing it.
#
# Records visual evidence for:
#   1. table-empty     (the created session, holding nothing)
#   2. table-grid      (the seeded session, holding a reply with a table)
#
# Both arms use current navigation, protocol and tokens. The Before build
# removes the table_at dispatch in the kit's Markdown block reader and draws
# streaming_document as one unchanged selectable document, without mend or a
# settled/arriving split. No navigation code is held back.
#
#   proof/docker/record-native.sh proof/scenes/desktop-streamed-shape.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<current-chrome-build-without-reader> \
#     proof/docker/record-native.sh proof/scenes/desktop-streamed-shape.sh
#
# WHY THE REPLY IS SEEDED. The frame is a claim about how a table is set,
# which means both arms have to draw the same table. A model asked for one
# writes a different one each take -- a dropped delimiter, a reordered row --
# and the pair then differs by the reply. The table is a committed fixture
# instead (`proof/docker/seed-sessions/`), placed in the session store by
# `proof/docker/seed-demo.sh` for this scene alone, and reached the way an
# operator reaches yesterday's session: the rail's own search.
#
# WHAT IS MEASURED. Three readings, none of which is the frame's own name. The
# search overlay opened, the filter reached its field, and the transcript
# column came to ink where an empty session had none. Then the host is asked,
# on a second connection, what the session it opened actually holds: the raw
# pipes and dashes the fixture carries. A window that drew a grid over a host
# that had already made one is a pass on the pixels and proves nothing, so
# both ends are read.
#
# The `[role] hairline` fill inside the transcript column is the reading that
# carries the frame: the rule under a grid's header is the only thing this
# reply can draw in it, so the count separates a grid from the pipes it is
# written as. The after arm requires the rule; the before arm requires its
# absence, which is the same reading read the other way.
#
# NOT RECORDED HERE: that a reply still arriving is drawn as the shape it is
# becoming, which is a sweep rather than a photograph and is asserted by
# `crates/veyyon-desktop-model/tests/streamed-markdown-is-closed-at-the-shape-it-is-becoming.rs`
# and `crates/veyyon-desktop-surface/tests/a-reply-still-arriving-draws-the-shape-it-is-becoming.rs`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where The Rail Puts Its Search ──────────────────────────────────────────
# The titlebar, space row and session-tab row precede the rail. The search
# header is a 32px row inside the rail's content inset. Both arms must use
# this navigation layout; an older rail is not a matched Before surface.
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
SEARCH_Y=$(( WIN_Y + 3 * TITLEBAR_H + CONTENT_INSET + 16 ))
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( WIN_H - 3 * TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + 3 * TITLEBAR_H ))"
# The table expands upward from the live edge. The shared composer band is a
# minimum; reserve three authored gutters beyond it to exclude the taller
# empty card and its border from the table-rule measurement.
REPLY_CROP="${SESSION_REGION_W}x$(( WIN_H - 3 * TITLEBAR_H - COMPOSER_BAND_H - 3 * GUTTER_PX ))+${SESSION_REGION_X}+$(( WIN_Y + 3 * TITLEBAR_H ))"
PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The overlay a palette of session rows draws, the ink a typed filter adds, and
# the ink a page of prose brings to a column that was empty. The last is the
# reading that carries the frame: an empty session draws its own empty state
# and nothing else, so a settled reply is thousands of pixels away from it.
OVERLAY_MIN_PIXELS=20000
FILTER_MIN_PIXELS=800
PROSE_MIN_PIXELS=3000
PROSE_INK_MIN=120

# The rule under a grid's header runs the width of the column it is drawn in.
# A transcript of prose draws none of this ink at all, so the floor only has to
# clear what a frame of text measures at this fuzz.
RULE_MIN_FILL=200
RULE_ABSENT_MAX=0
# The color mask excludes the ground; erosion below excludes short text-edge
# matches. The crop ends above the composer's own border.

hairline_run() { # <png> <crop> -> the longest run of hairline pixels in the crop
	local png="$1" crop="$2" theme fill counted
	theme="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"
	fill="$(sed -n '/^\[role\]/,/^\[/ s/^hairline = "\(#[0-9a-fA-F]\{6\}\)".*/\1/p' \
		"${theme}" | head -1)"
	if [ -z "${fill}" ]; then
		abandon_take "hairline-known" "no [role] hairline in ${theme}"
	fi
	# A rule is a run of consecutive hairline pixels; text anti-aliasing is a
	# run of a dozen at most. Erode the mask with a 200x1 rectangle so only a
	# run of 200 or more survives, then count what is left: a rule reads as
	# hundreds of pixels, text edges read as zero.
	counted="$(magick "${png}" -crop "${crop}" +repage \
		-fuzz 6% -fill white -opaque "${fill}" -fill black +opaque white \
		-morphology Erode 'Rectangle:200x1' \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "hairline-countable" \
				"counting the hairline in ${png} reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

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
read -r TABLE_SESSION TABLE_TITLE < <(
	python3 - <<'PY'
import json
from pathlib import Path

seed = sorted(Path("/repo/proof/docker/seed-sessions").glob("*table*.jsonl"))
if not seed:
    seed = sorted(Path("/repo/proof/docker/seed-sessions").glob("*.jsonl"))
    seed = [p for p in seed if "table" in p.read_text().lower()]
if not seed:
    raise SystemExit("no seeded table fixture")
row = json.loads(seed[0].read_text().splitlines()[0])
print(row["id"], row["title"])
PY
)
if [ -z "${TABLE_TITLE:-}" ]; then
	abandon_take "the-fixture-names-its-session" "the seeded session fixture states no title to search for"
fi

# ─── 1. The Session Holding Nothing ──────────────────────────────────────────
# The prelude left a session it created and a composer holding a dismissed
# palette. The pointer is parked on the rail's search pill rather than the
# composer: its hover fill is the one deterministic difference this frame has
# from the palette-dismissed shot, since a palette that finished fading inside
# the pause leaves the two byte-identical. The transcript column itself is
# photographed before anything is opened over it.
move_px "${SEARCH_X}" "${SEARCH_Y}"
pause 0.5
shot table-empty
EMPTY_FRAME="${PROBE_DIR}/table-empty.png"
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
SEARCH_OPEN="${PROBE_DIR}/table-search-open.png"
probe_frame "${SEARCH_OPEN}"

t "${TABLE_TITLE}"
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
# The reply is below the fold: the transcript opens at the top of the session,
# and the table is the last thing in it. `End` moves to the live edge.
k "End"
TABLE_DREW=0
for _ in $(seq 1 40); do
	pause 0.5
	TABLE_DREW="$(screen_differs_from_frame_pixels_at "${EMPTY_FRAME}" "${TRANSCRIPT_CROP}")"
	if [ "${TABLE_DREW}" -ge "${PROSE_MIN_PIXELS}" ]; then
		break
	fi
done
if [ "${TABLE_DREW}" -lt "${PROSE_MIN_PIXELS}" ]; then
	abandon_take "the-reply-reached-the-column" \
		"the transcript column is ${TABLE_DREW} pixels from the empty session it opened over, under the \
${PROSE_MIN_PIXELS} a page of prose inks, so the session never opened or its transcript never arrived"
fi
pause 1.0
shot table-grid

TABLE_INK="$(transcript_ink_height "${SCENE_OUT}/${SCENE_NAME}-table-grid.png")"
if [ "${TABLE_INK}" -lt "${PROSE_INK_MIN}" ]; then
	abandon_take "the-column-holds-a-turn" \
		"the ink in the transcript column stands ${TABLE_INK}px, under the ${PROSE_INK_MIN} a settled \
turn stands, so the frame is an empty session under another session's row"
fi

TABLE_RULE="$(hairline_run "${SCENE_OUT}/${SCENE_NAME}-table-grid.png" "${REPLY_CROP}")"
echo "scene: the search opened ${OPENED}px, the filter drew ${FILTERED}px," \
	"the reply drew ${TABLE_DREW}px and stands ${TABLE_INK}px tall," \
	"with ${TABLE_RULE}px of hairline" >&2

# Each arm requires the reading its own build makes. The before arm draws the
# reply as the pipes it is written in, which inks none of this role at all; the
# after arm draws the rule under the header.
if [ "${ARM}" = "before" ]; then
	if [ "${TABLE_RULE}" -gt "${RULE_ABSENT_MAX}" ]; then
		abandon_take "no-grid-before-the-reader" \
			"the frame drew ${TABLE_RULE} pixels of hairline over the ${RULE_ABSENT_MAX} a transcript of prose measures, so this build already rules a grid and the pair states nothing"
	fi
else
	if [ "${TABLE_RULE}" -lt "${RULE_MIN_FILL}" ]; then
		abandon_take "the-table-is-a-grid" \
			"the frame drew ${TABLE_RULE} pixels of hairline, under the ${RULE_MIN_FILL} the rule under a header runs, so the reply was drawn as its pipes"
	fi
fi

# ─── 4. What The Host Handed The Window ──────────────────────────────────────
# Asked last, on a connection of its own, so this cannot be what put the
# transcript on screen. The pipes and the dashes are what the reply carries: a
# host that had already made a grid would leave the window nothing to set, and
# the frame above would prove nothing about the reader under test.
if ! python3 - "${TABLE_SESSION}" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
session = sys.argv[1]
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
                    piped = [held for held in text if held.count("|") >= 4 and "---" in held]
                    if not piped:
                        last = f"{len(text)} strings, none of them a pipe table"
                        break
                    print(f"the reply carries its pipes and dashes among {len(text)} strings")
                    raise SystemExit(0)
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"session {session} holds no pipe table ({last})")
PY
then
	abandon_take "the-reply-carries-its-pipes" \
		"the host's transcript for ${TABLE_SESSION} holds no pipe table, so the frame states nothing about the reader that sets one"
fi
