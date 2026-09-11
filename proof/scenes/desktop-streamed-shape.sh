#!/usr/bin/env bash
# Ask a model for a markdown table and photograph the transcript while the
# table is still arriving, then once it has settled.
#
# Records visual evidence for:
#   1. grid-arriving   (the table drawn while the reply is still streaming)
#   2. grid-settled    (the same table once the turn ended)
#
# THIS IS THE AFTER ARM OF A PAIR. The before arm is the same driver against a
# build of the commit before the table reader and the stream mend, so the two
# frames differ by what the window makes of the same bytes and by nothing else:
#
#   proof/docker/record-native.sh proof/scenes/desktop-streamed-shape.sh
#
#   SCENE_ARM=before PROOF_BASE_REF=<the commit before the reader> \
#     proof/docker/record-native.sh proof/scenes/desktop-streamed-shape.sh
#
# WHAT THE ARMS DIFFER BY. The before arm reads no pipe table, so the reply is
# drawn as the lines it is written in: `| tool | when |` with its pipes, and a
# delimiter row of dashes among them. The after arm draws a grid -- columns set
# against the edge the delimiter row states, the header apart under a hairline
# rule -- and draws it while the reply is still arriving, because a block that
# has not finished is closed at the shape it is becoming before it is drawn.
#
# WHY THE TURN IS REAL. The claim is about a reply arriving one delta at a
# time, which a seeded transcript cannot make: a finished file has no arriving
# block in it. So the table is asked for, from the local model, and the first
# frame is taken while the row count is still climbing.
#
# WHAT IS MEASURED. Three readings, none of which is the frame's own name.
#   * The queue's `Working` chip, so the arriving frame is a frame of a turn
#     that is genuinely running rather than one taken after it ended.
#   * The `[role] hairline` fill inside the transcript column. The rule under a
#     grid's header is the only thing this reply can draw in it -- there is no
#     fence in it and no tool card under it -- so the count separates a grid
#     from the pipes it is written as. The after arm requires the rule; the
#     before arm requires its absence, which is the same reading read the other
#     way.
#   * What the host handed the window, asked last, on a connection of its own:
#     the reply's own text, which has to carry the raw pipes and the dashes and
#     no fence at all. A window that drew a grid over a host that had already
#     made one is a pass on the pixels and proves nothing about the reader, and
#     a reply the model fenced would draw a code pane's border in the same ink
#     the rule is counted in.
#
# NOT RECORDED HERE: which shapes the mend closes and what each one draws,
# which is a sweep rather than a photograph and is asserted by
# `crates/veyyon-desktop-model/tests/streamed-markdown-is-closed-at-the-shape-it-is-becoming.rs`
# and `crates/veyyon-desktop-surface/tests/a-reply-still-arriving-draws-the-shape-it-is-becoming.rs`;
# and that the settled words stay selectable while the arriving block offers
# nothing, which the same surface suite drives in a live window.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── Where The Readings Are Taken ────────────────────────────────────────────
# The queue is beside the transcript at this width, and collapses below it,
# where the chip this scene reads is not on screen at all.
if [ "${WIN_W}" -le 800 ]; then
	abandon_take "queue-beside-transcript" \
		"the queue is collapsed at ${WIN_W}px, so no running-turn chip is on screen to read"
fi
QUEUE_CROP="${RAIL_W}x$(( WIN_H - TITLEBAR_H ))+${WIN_X}+$(( WIN_Y + TITLEBAR_H ))"
TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"
PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# A chip is a 20px pill: measured at about a thousand pixels of tint over this
# crop while a turn ran, and at a couple of hundred over a rail of prose with
# no chip in it, so the floor sits between the two.
CHIP_MIN_FILL=600
# The rule under a grid's header runs the width of the column it is drawn in.
# A transcript of prose draws none of this ink at all, so the floor only has to
# clear what a frame of text measures at this fuzz.
RULE_MIN_FILL=200
RULE_ABSENT_MAX=60

hairline_pixels() { # <png> <crop> -> pixels of the hairline fill inside the crop
	local png="$1" crop="$2" theme fill counted
	theme="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"
	fill="$(sed -n '/^\[role\]/,/^\[/ s/^hairline = "\(#[0-9a-fA-F]\{6\}\)".*/\1/p' \
		"${theme}" | head -1)"
	if [ -z "${fill}" ]; then
		abandon_take "hairline-known" "no [role] hairline in ${theme}"
	fi
	counted="$(magick "${png}" -crop "${crop}" +repage \
		-fuzz 6% -fill white -opaque "${fill}" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "hairline-countable" \
				"counting the hairline in ${png} reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

# ─── The Session The Turn Runs On ────────────────────────────────────────────
# Created and named by the preamble. The host is asked about this id at the
# end, so the scene cannot read another session's reply back.
TABLE_SESSION="$(python3 - <<'PY'
import json
import os
from pathlib import Path

print(json.loads((Path(os.environ["SCENE_RUNTIME_DIR"]) / "created-session.json").read_text()))
PY
)"
if [ -z "${TABLE_SESSION}" ]; then
	abandon_take "the-session-is-named" \
		"the preamble recorded no created session, so the reply cannot be read back from the host"
fi

# ─── The Model The Turn Runs On ──────────────────────────────────────────────
# Named rather than left at whatever the composer opens on: a prompt submitted
# with no model chosen is ended by the provider as an abort, and there is then
# no arriving block to photograph.
PICKER_CLOSED="${PROBE_DIR}/streamed-picker-closed.png"
probe_frame "${PICKER_CLOSED}"
move_px "${MODEL_CHIP_X}" "${MODEL_CHIP_Y}"
pause 0.3
click
pause 0.8
PICKER="$(screen_differs_from_frame_pixels_at "${PICKER_CLOSED}" "${WINDOW_CROP}")"
if [ "${PICKER}" -lt 20000 ]; then
	abandon_take "model-picker-open" \
		"a press on the model chip changed ${PICKER} pixels of the window, under the 20000 an overlay of model rows draws, so the keys after it would land in the composer"
fi
t "local/qwen2.5-1.5b"
pause 0.6
k "Return"
pause 0.8

# ─── A Table Long Enough To Be Caught Arriving ───────────────────────────────
# The first two lines are dictated, because a 1.5b model asked for "a table"
# writes a delimiter row four ways and one of them is no table at all. The row
# count is what buys the arriving frame: twelve rows of a tool and a sentence
# take this model several seconds, so the frame below is taken over a grid that
# is still growing.
TABLE_PROMPT="Reply with a markdown table and nothing else: no prose, no code fences, no backticks. \
Write the first line exactly as | tool | when | and the second line exactly as |---|---| and then \
twelve rows, each naming one unix tool and one short sentence saying when to reach for it."
submit_prompt "${TABLE_PROMPT}"

# The pointer is parked in the composer for every frame: over a queue row it
# reveals that row's own actions, and over the transcript it would draw a
# hovered turn's controls into the crop being counted.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# A submit the host accepted is not a reply on screen. The observable is the
# transcript column repainting under the prompt as the table arrives.
transcript_region
BEFORE_FIRST_TOKEN="${PROBE_DIR}/streamed-before-first-token.png"
probe_frame "${BEFORE_FIRST_TOKEN}"
STREAMED=0
for _ in $(seq 1 180); do
	if [ "$(screen_differs_from_frame_per_mille "${BEFORE_FIRST_TOKEN}")" -ge 4 ]; then
		STREAMED=1
		break
	fi
	sleep 1
done
if [ "${STREAMED}" -ne 1 ]; then
	abandon_take "the-table-is-arriving" \
		"the host accepted the turn but nothing streamed into the transcript within 180s, so there is no arriving block to photograph"
fi

# ─── 1. The Grid While It Is Still Arriving ──────────────────────────────────
# Two seconds past the first delta: far enough in that the header and a row or
# two are drawn, early enough that the turn is still running, which the chip
# beside the frame is what proves.
pause 2.0
shot grid-arriving
ARRIVING_CHIP="$(working_tint_pixels "${SCENE_OUT}/${SCENE_NAME}-grid-arriving.png" "${QUEUE_CROP}")"
if [ "${ARRIVING_CHIP}" -lt "${CHIP_MIN_FILL}" ]; then
	abandon_take "the-frame-is-of-a-running-turn" \
		"the queue drew ${ARRIVING_CHIP} pixels of working tint in the arriving frame, under the ${CHIP_MIN_FILL} a chip fills, so the turn had already ended and the frame shows no arriving block"
fi
ARRIVING_RULE="$(hairline_pixels "${SCENE_OUT}/${SCENE_NAME}-grid-arriving.png" "${TRANSCRIPT_CROP}")"

# ─── 2. The Same Table, Settled ──────────────────────────────────────────────
# The turn is waited out on the chip clearing, so the settled frame is a frame
# of a finished reply rather than one taken a fixed number of seconds in.
SETTLED_CHIP="${CHIP_MIN_FILL}"
for _ in $(seq 1 120); do
	sleep 1
	probe_frame "${PROBE_DIR}/streamed-chip.png"
	SETTLED_CHIP="$(working_tint_pixels "${PROBE_DIR}/streamed-chip.png" "${QUEUE_CROP}")"
	if [ "${SETTLED_CHIP}" -lt "${CHIP_MIN_FILL}" ]; then
		break
	fi
done
if [ "${SETTLED_CHIP}" -ge "${CHIP_MIN_FILL}" ]; then
	abandon_take "the-turn-ended" \
		"the queue still drew ${SETTLED_CHIP} pixels of working tint after 120s, so the reply never finished and no settled frame can be taken"
fi
settle 2
shot grid-settled
SETTLED_RULE="$(hairline_pixels "${SCENE_OUT}/${SCENE_NAME}-grid-settled.png" "${TRANSCRIPT_CROP}")"

echo "scene: the arriving frame drew ${ARRIVING_CHIP}px of working tint and ${ARRIVING_RULE}px of" \
	"hairline, the settled frame ${SETTLED_RULE}px" >&2

# Each arm requires the reading its own build makes. The before arm draws the
# reply as the pipes it is written in, which inks none of this role at all; the
# after arm draws the rule under the header, in both frames, because a block
# still arriving is closed at the shape it is becoming.
if [ "${ARM}" = "before" ]; then
	if [ "${SETTLED_RULE}" -gt "${RULE_ABSENT_MAX}" ]; then
		abandon_take "no-grid-before-the-reader" \
			"the settled frame drew ${SETTLED_RULE} pixels of hairline over the ${RULE_ABSENT_MAX} a transcript of prose measures, so this build already rules a grid and the pair states nothing"
	fi
else
	if [ "${SETTLED_RULE}" -lt "${RULE_MIN_FILL}" ]; then
		abandon_take "the-settled-table-is-a-grid" \
			"the settled frame drew ${SETTLED_RULE} pixels of hairline, under the ${RULE_MIN_FILL} the rule under a header runs, so the reply was drawn as its pipes"
	fi
	if [ "${ARRIVING_RULE}" -lt "${RULE_MIN_FILL}" ]; then
		abandon_take "the-arriving-table-is-a-grid" \
			"the arriving frame drew ${ARRIVING_RULE} pixels of hairline, under the ${RULE_MIN_FILL} the rule under a header runs, so a block still arriving was drawn as its own markers"
	fi
fi

# ─── What The Host Handed The Window ─────────────────────────────────────────
# Asked last, on a connection of its own, so this cannot be what put the grid
# on screen. The pipes and the dashes are what the reply carries, and a fence
# in it would draw a code pane's border in the ink the rule was counted in.
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
                    fenced = [held for held in piped if "```" in held]
                    if fenced:
                        last = "the reply fenced its table, so a code pane's border is in the count"
                        break
                    print(f"the reply carries its pipes and dashes among {len(text)} strings")
                    raise SystemExit(0)
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"session {session} holds no unfenced pipe table ({last})")
PY
then
	abandon_take "the-reply-carries-its-pipes" \
		"the host's transcript for ${TABLE_SESSION} holds no unfenced pipe table, so the frames state nothing about the reader that sets one"
fi
