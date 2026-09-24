#!/usr/bin/env bash
# Recall a prompt submitted earlier from the native GPUI window's prompt
# history, and photograph the listing and the draft it restores.
#
# Records visual evidence for:
#   1. prompt-history-listed   (the mode open on an empty query, the prompt listed)
#   2. prompt-history-no-match (a query no prompt holds, the rows gone)
#   3. prompt-history-recalled (the row entered, the prompt back in the composer unsent)
#
# Frames 1 and 2 are the differential of the listing, and frames 1 and 3 the
# differential of the recall. Prompt history is a lookup rather than a setting,
# so one frame of it proves nothing: a mode that lists the wrong domain looks
# exactly like one that lists the right one, and a palette that closes on a row
# looks exactly like one dismissed. Frame 1 is the host's answer for the prompt
# this take submitted, frame 2 is that the rows follow the query, and frame 3 is
# that the row put the prompt back in the draft instead of sending it.
#
# Nothing here seeds a row. The prompt in the listing is the one this take typed
# into the real composer and submitted through the real host.
#
# WHAT IS MEASURED. The rows are read below the untyped palette's own field, so
# a placeholder giving way to a query is outside every comparison: a lookup that
# answered with nothing inks the field and leaves that region at the ground it
# had. The recall is read in the composer band instead, where a restored draft
# is the only thing that inks.
#
# NOT RECORDED HERE: which prompts are recorded at all, which is swept over
# every action that delivers one by
# `packages/coding-agent/test/gui-host/a-prompt-a-window-submitted-is-recalled-from-its-history.test.ts`,
# and the keyboard the mode answers, held by
# `crates/veyyon-desktop-surface/tests/a-palette-row-runs-from-the-keyboard-that-selected-it.rs`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-prompt-history.sh
#
# and its other arm against a build of the base ref, which has no such lookup:
# no command opens one and no mode lists a prompt, so that arm carries the three
# marks as the base draws them and asserts the absence in that direction. The
# change is entirely inside the executable, so the arm holds no source, and the
# base's own token and theme files come with the build that reads them:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<base-build> \
#     PROOF_TOKENS_DIR=/repo/.internal/before-tokens/<name>/tokens \
#     PROOF_THEMES_DIR=/repo/.internal/before-tokens/<name>/themes \
#     proof/docker/record-native.sh proof/scenes/desktop-prompt-history.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
PROMPT_TEXT="recall this prompt from the window history"
# A word no command, no session title and no prompt in this take carries, so a
# listing narrowed by it is a listing with nothing in it.
NO_MATCH_QUERY="zzqwx"
PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# A row of the palette is two lines of text in a 36px band, and this scene
# expects at least one: far above the noise two settled frames of one state show
# on this renderer.
ROWS_MIN_PIXELS=400
# A restored draft is a line of 13px prose in a 110px band, which rounds to
# nothing per mille and reads in pixels.
DRAFT_MIN_PIXELS=300

CROP_X=$(( WIN_X + RAIL_W ))
CROP_Y=$(( WIN_Y + TITLEBAR_H ))
CROP_W=$(( WIN_W - RAIL_W ))
CROP_H=$(( WIN_H - TITLEBAR_H ))

# The comparison excludes the field itself, for the reason the header states.
# The palette centres in the height under the titlebar and grows in both
# directions as rows arrive, so everything below the untyped palette's own field
# is a region only rows reach.
FIELD_BOTTOM=$(( CROP_Y + CROP_H / 2 - 14 ))
ROWS_CROP="${CROP_W}x$(( WIN_Y + WIN_H - FIELD_BOTTOM ))+${CROP_X}+${FIELD_BOTTOM}"

differing_pixels() { # <shot-a> <shot-b> [<crop>]
	frames_differ_pixels_at \
		"${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		"${SCENE_OUT}/${SCENE_NAME}-$2.png" \
		"${3:-${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}}"
}

# Wait until the host's own history holds the prompt. The row is written after
# the turn is accepted and the store batches its inserts, so a palette opened
# the instant the turn settles is opened before the write, and the take then
# photographs an empty listing under the name of a listed one.
#
# Bounded: a prompt that never reaches the store ends this at the deadline and
# abandons the take naming what the host answered.
prompt_recorded() { # <text>
python3 - "$1" <<'PY'
import json
import os
from pathlib import Path
import socket
import time
import sys

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
wanted = sys.argv[1]
deadline = time.monotonic() + 30
last = "no prompt history answer"
request = json.dumps({"id": 1, "action": {"SearchPromptHistory": {"query": ""}}}) + "\n"
while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(request.encode())
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "PromptHistory" not in snapshot:
                        continue
                    prompts = [
                        entry["prompt"] for entry in snapshot["PromptHistory"]["entries"]
                    ]
                    last = f"{len(prompts)} prompt(s) listed"
                    if wanted in prompts:
                        print(f"the host recorded the prompt among {len(prompts)}")
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"the prompt never reached the host's history within 30s ({last})")
PY
}

# ─── 1. Submit The Prompt The Listing Is Read For ────────────────────────────
# The turn is waited out before the mode opens: a transcript still streaming
# under the palette moves the region every frame below is read through, so the
# rows of one state would differ from the rows of the same state.
submit_prompt "${PROMPT_TEXT}"
if ! native_session_ready finished; then
	abandon_take "the-prompt-ran" "the submitted prompt produced no finished turn"
fi
pause 1.0
if [ "${ARM}" != "before" ] && ! prompt_recorded "${PROMPT_TEXT}"; then
	abandon_take "the-prompt-was-recorded" \
		"the host listed no prompt history holding the prompt this take submitted"
fi

# ─── 2. Reaching The Mode, Or Failing To ─────────────────────────────────────
# `/prompts` is the row that opens the mode; typing the slash command is how it
# is reached, so the scene reaches it that way rather than by a chord no surface
# offers. At the base no command opens a prompt lookup, so that arm never
# presses Return: a `/prompts` the palette does not list is a prompt rather than
# a command. Its own control is the command list that `/` opens and `prompts`
# collapses, which states the palette was live rather than the window blank.
measure_composer_card
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.3

COMMANDS_LISTED="${PROBE_DIR}/prompt-history-commands-listed.png"
if [ "${ARM}" = "before" ]; then
	t "/"
	pause 1.0
	probe_frame "${COMMANDS_LISTED}"
	t "prompts"
	pause 1.2
else
	t "/prompts"
	pause 0.8
	k "Return"
	pause 1.5
fi
shot prompt-history-listed

if [ "${ARM}" = "before" ]; then
	COLLAPSED="$(frames_differ_pixels_at "${COMMANDS_LISTED}" \
		"${SCENE_OUT}/${SCENE_NAME}-prompt-history-listed.png" "${ROWS_CROP}")"
	if [ "${COLLAPSED}" -lt "${ROWS_MIN_PIXELS}" ]; then
		abandon_take "commands-listed" \
			"typing a word no command carries changed ${COLLAPSED} pixels, under the \
${ROWS_MIN_PIXELS} a list of rows inks, so the palette listed nothing to begin with"
	fi
fi

# ─── 3. The Rows Follow The Query ────────────────────────────────────────────
# A query no prompt holds empties the listing, which is the state the rows are
# measured against. The base arm types the same characters into the same field
# and has no listing to empty.
t "${NO_MATCH_QUERY}"
pause 1.5
shot prompt-history-no-match

LISTED="$(differing_pixels prompt-history-listed prompt-history-no-match "${ROWS_CROP}")"
if [ "${ARM}" = "before" ]; then
	if [ "${LISTED}" -ge "${ROWS_MIN_PIXELS}" ]; then
		abandon_take "the-base-lists-no-prompt" \
			"the base shed ${LISTED} pixels of rows on a query no prompt holds, at least the \
${ROWS_MIN_PIXELS} a listing inks, so something did list prompts to narrow"
	fi
elif [ "${LISTED}" -lt "${ROWS_MIN_PIXELS}" ]; then
	abandon_take "the-listing-holds-the-prompt" \
		"the rows changed ${LISTED} pixels between the whole listing and a query no prompt \
holds, under the ${ROWS_MIN_PIXELS} a row inks, so the mode listed nothing to narrow"
fi

# ─── 4. The Row Restores The Prompt Unsent ───────────────────────────────────
# The query is emptied so the prompt is the row under the selection, and Return
# takes it. What that leaves is a closed palette and a composer holding the
# prompt as a draft: the recall restores the text to be edited rather than
# sending it again, so the band inks and the session gains no turn.
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 1.2
if [ "${ARM}" = "before" ]; then
	k "ctrl+a"
	pause 0.2
	k "BackSpace"
	k "Escape"
else
	k "Return"
fi
pause 1.2
measure_composer_card
shot prompt-history-recalled

composer_band_region
RECALLED_PX="$(shots_differ_pixels prompt-history-no-match prompt-history-recalled)"
if [ "${ARM}" = "before" ]; then
	echo "scene: before arm -- ${COLLAPSED} pixels of command rows collapsed, a query no \
prompt holds moved ${LISTED} pixels of rows, and the composer band moved ${RECALLED_PX}" >&2
else
	if [ "${RECALLED_PX}" -lt "${DRAFT_MIN_PIXELS}" ]; then
		abandon_take "the-row-restored-the-draft" \
			"the composer band changed ${RECALLED_PX} pixels when the row was entered, under \
the ${DRAFT_MIN_PIXELS} a line of prose inks, so the prompt did not come back to the draft"
	fi
	CLOSED="$(differing_pixels prompt-history-listed prompt-history-recalled "${ROWS_CROP}")"
	if [ "${CLOSED}" -lt "${ROWS_MIN_PIXELS}" ]; then
		abandon_take "the-palette-closed-on-the-row" \
			"the rows changed ${CLOSED} pixels when the row was entered, under the \
${ROWS_MIN_PIXELS} a listing inks, so the palette is still drawn over the composer"
	fi
	echo "scene: after arm -- the listing narrowed by ${LISTED} pixels, the palette closed \
by ${CLOSED}, and the recalled draft inked ${RECALLED_PX}" >&2
fi
