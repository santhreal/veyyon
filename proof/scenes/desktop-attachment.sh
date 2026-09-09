#!/usr/bin/env bash
# Paste an image into the composer, send the prompt that carries it, and read
# back what the host received (§5.4).
#
# Records visual evidence for:
#   1. attachment-none    (the composer holding a draft and nothing else)
#   2. attachment-tray    (the pasted image as a card above the footer)
#   3. attachment-sent    (the tray emptied, the image on the prompt it went with)
#
# WHY A PASTE AND NOT THE PICKER. Three routes reach `ShellView::attach`: the
# platform's file chooser, a drag from outside the window, and a paste. On Linux
# the chooser is the XDG desktop portal (`ashpd`), which no container runs and
# many bare X sessions do not either; a drag needs a source outside the window,
# which nothing here can be. The paste is the one route a display can be driven
# through, and it ends in the same `attach` as the other two, so what the frames
# state about the tray, the ceilings and the submission holds for all three.
#
# WHAT IS MEASURED, none of it the frame's own name:
#   * the clipboard offers `image/png` before the chord is sent, so a tray that
#     failed to draw is not read as a clipboard that held nothing;
#   * the composer band inks a card where an empty tray drew nothing;
#   * the band comes back to where it was once the prompt is away, which is the
#     tray being emptied by the send rather than by a reload;
#   * the host is then asked, on a connection of its own, what the session
#     holds: an image block of exactly the bytes that were pasted. A window that
#     drew a card over a host that received no attachment is a pass on the
#     pixels and proves nothing, so both ends are read.
#
# NOT RECORDED HERE: the per-model refusal ("Not accepted by <model>"), which
# depends on the catalogue entry for whichever model the take runs, and the
# ceilings, which are asserted in-process.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Image That Is Pasted ────────────────────────────────────────────────
# Generated rather than committed, and generated once: the same command every
# take, so the card, its caption and the byte count the host is asked for all
# agree without a binary in the tree. A plasma at a fixed seed is deterministic
# and it is not a flat field, so the thumbnail is visibly an image.
PASTE_DIR="${SCENE_RUNTIME_DIR}/attachment"
PASTE_PNG="${PASTE_DIR}/pasted.png"
mkdir -p "${PASTE_DIR}"
magick -seed 7 -size 240x160 plasma:fractal -depth 8 "${PASTE_PNG}"
if [ ! -s "${PASTE_PNG}" ]; then
	abandon_take "the-image-exists" "no image was generated to paste"
fi
PASTE_BYTES="$(stat -c%s "${PASTE_PNG}")"

# xclip forks and keeps the selection; without an owner the window's read
# returns nothing and the chord below would be a paste of an empty clipboard.
xclip -selection clipboard -t image/png -i "${PASTE_PNG}"
CLIP_TARGETS="$(xclip -selection clipboard -o -t TARGETS 2>/dev/null || true)"
case "${CLIP_TARGETS}" in
	*image/png*) ;;
	*)
		abandon_take "the-clipboard-holds-an-image" \
			"the clipboard offers '${CLIP_TARGETS:-nothing}', so a paste carries no image and the tray would be empty for a reason that is not the window's"
		;;
esac
echo "scene: the clipboard holds ${PASTE_BYTES} bytes of image/png" >&2

# ─── What The Tray Has To Ink ────────────────────────────────────────────────
# A card is a thumbnail beside two lines of text inside a hairline box, so it
# is thousands of pixels of the band. The floor is a fraction of that: enough
# that a stray caret or a hover wash cannot reach it, low enough that a retuned
# card height does not fail a take that drew one.
TRAY_MIN_PIXELS=1200
# Once the prompt is away the editor line holds the composer it started as,
# read against the frame taken while the composer was empty rather than
# against a number: the placeholder is back where it was and the card is gone
# from the row it took. The allowance is a caret, which blinks and so lands in
# either phase in either frame.
CLEARED_MAX_PIXELS=200
# The prompt reaches the transcript with its image under it, which is a page of
# the column rather than a control on it.
PROMPT_MIN_PIXELS=4000

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# The transcript column, in root coordinates: the session surface less the
# titlebar above it and the composer band below it, both of which the preamble
# read from the token files this checkout ships.
TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"

# The editor's own line, in root coordinates. The composer is bottom-anchored
# and the tray sits between the editor and the footer row, so an attachment
# pushes the editor up and takes this row for itself: a reading of this row is
# a reading of the tray and of nothing else. The band as a whole is not, since
# it also carries the run bar and the primary action, and both of those state
# something different while a turn runs than they do at rest -- which is what
# a take reading the whole band against the composer before the paste reported
# as a card that never left.
EDITOR_ROW_CROP="${COMPOSER_CARD_W}x24+${COMPOSER_CARD_LEFT}+$(( COMPOSER_EDITOR_Y - 12 ))"

# ─── 1. The Composer Before Anything Is Attached ─────────────────────────────
# The prelude left a session it created and a dismissed palette in the
# composer, so the editor is cleared and read empty before the draft is
# retyped. Two references come out of it: the empty composer, which is the
# editor row the send has to give back, and the frame holding the draft alone,
# which is what the paste is read against. Both are taken with the pointer
# parked on the editor line, off every row that reveals on hover.
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.5
PRISTINE_BAND="${PROBE_DIR}/attachment-pristine.png"
probe_frame "${PRISTINE_BAND}"

type_prompt "Describe what this frame shows."
pause 0.6
shot attachment-none
EMPTY_BAND="${PROBE_DIR}/attachment-none.png"
probe_frame "${EMPTY_BAND}"

# ─── 2. The Paste ────────────────────────────────────────────────────────────
# ctrl+v with the editor focused. The clipboard holds no text, so the editor
# hands the item to the composer instead of inserting it, and the draft typed
# above has to survive that: a paste that replaced the draft is a defect the
# band reading below would not catch on its own, so the send that follows
# depends on the draft still being there.
k "ctrl+v"
TRAY_DREW=0
for _ in $(seq 1 40); do
	TRAY_DREW="$(screen_differs_from_frame_pixels_at "${EMPTY_BAND}" "${COMPOSER_BAND_CROP}")"
	if [ "${TRAY_DREW}" -ge "${TRAY_MIN_PIXELS}" ]; then
		break
	fi
	pause 0.25
done
if [ "${TRAY_DREW}" -lt "${TRAY_MIN_PIXELS}" ]; then
	abandon_take "the-paste-reached-the-tray" \
		"the composer band changed ${TRAY_DREW} pixels after the paste, under the ${TRAY_MIN_PIXELS} an attachment card inks, so the clipboard image reached no tray"
fi
pause 0.8
shot attachment-tray

# ─── 3. The Prompt It Went With ──────────────────────────────────────────────
# Sent from the keyboard, since that is the route a prompt with an attachment
# takes: the send control and the chord are the same intent, and the chord needs
# no aim that a tray of cards can move.
BEFORE_SEND="${PROBE_DIR}/attachment-before-send.png"
probe_frame "${BEFORE_SEND}"
k "Return"
PROMPT_DREW=0
for _ in $(seq 1 60); do
	PROMPT_DREW="$(screen_differs_from_frame_pixels_at "${BEFORE_SEND}" "${TRANSCRIPT_CROP}")"
	if [ "${PROMPT_DREW}" -ge "${PROMPT_MIN_PIXELS}" ]; then
		break
	fi
	pause 0.5
done
if [ "${PROMPT_DREW}" -lt "${PROMPT_MIN_PIXELS}" ]; then
	abandon_take "the-prompt-reached-the-transcript" \
		"the transcript changed ${PROMPT_DREW} pixels after the send, under the ${PROMPT_MIN_PIXELS} a prompt carrying an image inks, so the submission did not land"
fi
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 1.0
shot attachment-sent

CLEARED="$(frames_differ_pixels_at "${EMPTY_BAND}" "${SCENE_OUT}/${SCENE_NAME}-attachment-sent.png" "${COMPOSER_BAND_CROP}")"
if [ "${CLEARED}" -gt "${CLEARED_MAX_PIXELS}" ]; then
	abandon_take "the-tray-emptied-with-the-prompt" \
		"the composer band still differs by ${CLEARED} pixels from the one before the paste, over the ${CLEARED_MAX_PIXELS} a placeholder and a caret account for, so the card the prompt carried is still in the tray"
fi
echo "scene: the tray drew ${TRAY_DREW}px, the prompt drew ${PROMPT_DREW}px" \
	"and the band came back within ${CLEARED}px" >&2

# ─── 4. What The Host Received ───────────────────────────────────────────────
# Asked last, on a connection of its own. The bytes are the reading: a host
# that recorded the prompt and dropped its attachment leaves a transcript with
# text and no image, and the card photographed above would then be a claim
# about the window alone.
if ! python3 - "${PASTE_BYTES}" <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
want = int(sys.argv[1])
deadline = time.monotonic() + 60
last = "no host frame"


def images(value):
    """Every image block in a host snapshot, however it is nested."""
    if isinstance(value, dict):
        image = value.get("Image")
        if isinstance(image, dict) and isinstance(image.get("data"), list):
            yield image
        for item in value.values():
            yield from images(item)
    elif isinstance(value, list):
        for item in value:
            yield from images(item)


def sessions(snapshot):
    listing = snapshot.get("Sessions")
    if isinstance(listing, dict):
        for section in listing.values():
            if isinstance(section, list):
                for row in section:
                    if isinstance(row, dict) and isinstance(row.get("id"), str):
                        yield row["id"]


while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(
                json.dumps({"id": 1, "action": "ListSessions"}).encode() + b"\n"
            )
            found = []
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("Missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    found = list(sessions(snapshot))
                    if found:
                        break
            if not found:
                last = "the host listed no session"
                raise RuntimeError(last)
            for session in found:
                with socket.socket(socket.AF_UNIX) as transcript:
                    transcript.settimeout(max(0.01, deadline - time.monotonic()))
                    transcript.connect(str(endpoint))
                    transcript.sendall(
                        json.dumps(
                            {
                                "id": 2,
                                "action": {
                                    "LoadTranscript": {"session": session, "before": None}
                                },
                            }
                        ).encode()
                        + b"\n"
                    )
                    with transcript.makefile("rb") as stream:
                        for _ in range(32):
                            transcript.settimeout(max(0.01, deadline - time.monotonic()))
                            line = stream.readline(8 * 1024 * 1024 + 1)
                            if not line or len(line) > 8 * 1024 * 1024:
                                raise RuntimeError("Missing or oversized host frame")
                            snapshot = json.loads(line).get("Snapshot", {})
                            if "Transcript" not in snapshot:
                                continue
                            sizes = [
                                len(image["data"]) for image in images(snapshot["Transcript"])
                            ]
                            if want in sizes:
                                print(
                                    f"session {session} holds the {want} bytes that were pasted"
                                )
                                raise SystemExit(0)
                            last = f"session {session} holds image blocks of {sizes or 'no'} bytes"
                            break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.3)
raise SystemExit(f"no session holds the pasted image ({last})")
PY
then
	abandon_take "the-host-received-the-image" \
		"no session the host lists holds an image block of the bytes that were pasted, so the card the frames photograph reached the window and not the prompt"
fi
