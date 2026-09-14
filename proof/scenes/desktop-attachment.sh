#!/usr/bin/env bash
# Paste an image into the composer, send the prompt that carries it, and read
# back what the host received (§5.4).
#
# Records visual evidence for:
#   1. attachment-none    (the composer holding a draft and nothing else)
#   2. attachment-tray    (the pasted image as a card above the footer)
#   3. attachment-sent    (the tray emptied, the image on the prompt it went with)
#   4. attachment-refused (the same paste under a model that takes no image)
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
# THE REFUSAL IS RECORDED, THE CEILINGS ARE NOT. A card states
# `Not accepted by <model>` where the size goes, which needs a model selected:
# the host reports a session with none until one is picked, so section 5 picks
# one and pastes again. The submission ceilings are asserted in-process.
#
#     proof/docker/record-native.sh proof/scenes/desktop-attachment.sh
#
#     SCENE_ARM=before PROOF_BASE_REF=HEAD \
#       PROOF_NATIVE_BEFORE_BINARY=.internal/captures/attachment/veyyon-desktop \
#       proof/docker/record-native.sh proof/scenes/desktop-attachment.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── The Image That Is Pasted ────────────────────────────────────────────────
# Generated rather than committed, and generated once: the same command every
# take, so the card, its caption and what the host is asked for all agree
# without a binary in the tree. A plasma at a fixed seed is deterministic and
# it is not a flat field, so the thumbnail is visibly an image.
PASTE_DIR="${TMPDIR}/attachment"
PASTE_PNG="${PASTE_DIR}/pasted.png"
PASTE_WIDTH=240
PASTE_HEIGHT=160
mkdir -p "${PASTE_DIR}"
magick -seed 7 -size "${PASTE_WIDTH}x${PASTE_HEIGHT}" plasma:fractal -depth 8 "${PASTE_PNG}"
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

PROBE_DIR="${TMPDIR}/frame-compare"
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

CLEARED="$(frames_differ_pixels_at "${PRISTINE_BAND}" "${SCENE_OUT}/${SCENE_NAME}-attachment-sent.png" "${EDITOR_ROW_CROP}")"
if [ "${CLEARED}" -gt "${CLEARED_MAX_PIXELS}" ]; then
	abandon_take "the-tray-emptied-with-the-prompt" \
		"the editor's own line still differs by ${CLEARED} pixels from the empty composer, over the ${CLEARED_MAX_PIXELS} a caret accounts for, so the card the prompt carried is still in the row it took"
fi
TRAY_ROW="$(frames_differ_pixels_at "${PRISTINE_BAND}" "${SCENE_OUT}/${SCENE_NAME}-attachment-tray.png" "${EDITOR_ROW_CROP}")"
if [ "${TRAY_ROW}" -le "${CLEARED}" ]; then
	abandon_take "the-card-took-the-editor-row" \
		"the editor's own line differs by ${TRAY_ROW} pixels with the card attached and ${CLEARED} without it, so the reading below is not reading the tray"
fi
echo "scene: the tray drew ${TRAY_DREW}px, the prompt drew ${PROMPT_DREW}px," \
	"the editor row held ${TRAY_ROW}px of card and came back within ${CLEARED}px" >&2

# ─── 4. What The Host Received ───────────────────────────────────────────────
# Read off what the host wrote, not over the socket it answers on. A host that
# recorded the prompt and dropped its attachment leaves a transcript with text
# and no image, and the card photographed above would then be a claim about the
# window alone.
#
# WHAT SURVIVES THE WAY IN, AND WHAT DOES NOT. An image is decoded, scaled to
# the floor the host sends at and re-encoded in whichever format comes out
# smallest, then externalized on persist: the session line keeps
# `blob:sha256:<hash>` and the store holds that payload. So none of the digest,
# the length, the format or the pixel size of the file that was put on the
# clipboard appears anywhere -- a probe that looked for the digest read the
# reference itself as 57 bytes of image, and one that looked for 240x160 read a
# 300x200 WebP. What survives is the picture's shape: the scale is uniform, so
# a blob whose sides are 3:2 and no smaller than the paste is the plasma that
# was pasted and not another image the session happened to hold.
#
# WHY THE FILE AND NOT A SECOND CONNECTION. A 72KB image is close to 20k tokens
# of this model's 32k context, so the turn that carries it crosses the
# compaction threshold, and the host spends the minute after it summarizing and
# accepts no new connection while it does: takes were abandoned on a socket
# that answered no frame in 60s while the image was already on disk. The
# session file is the host's own record, written when the prompt is accepted,
# and reading it asks the host for nothing.
if ! python3 - "${PASTE_WIDTH}" "${PASTE_HEIGHT}" <<'PY'
import json
from pathlib import Path
import subprocess
import sys
import time

width, height = int(sys.argv[1]), int(sys.argv[2])
shape = width / height
deadline = time.monotonic() + 30
found = []


def picture(blob):
    """The size a decoder reads off the blob, whatever it was encoded as.

    The re-encode picks the smallest format it can write, so the payload is not
    the PNG that was pasted and its own header is the only thing that states
    what it is.
    """
    read = subprocess.run(
        ["magick", "identify", "-format", "%w %h", str(blob)],
        capture_output=True,
        text=True,
        check=False,
    )
    if read.returncode != 0:
        return None
    try:
        drawn_width, drawn_height = (int(part) for part in read.stdout.split())
    except ValueError:
        return None
    return drawn_width, drawn_height


def image_data(content):
    """What every image block in one message's content carries in `data`."""
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "image":
                data = item.get("data")
                if isinstance(data, str):
                    yield data


while time.monotonic() < deadline:
    found = []
    for transcript in Path.home().rglob("*.jsonl"):
        try:
            with transcript.open() as entries:
                for entry_line in entries:
                    try:
                        message = json.loads(entry_line).get("message", {})
                    except ValueError:
                        continue
                    if not isinstance(message, dict) or message.get("role") != "user":
                        continue
                    for data in image_data(message.get("content")):
                        if not data.startswith("blob:sha256:"):
                            found.append(f"{transcript.name} carries {data[:32]}")
                            continue
                        digest = data.removeprefix("blob:sha256:")
                        for blob in Path.home().rglob(digest):
                            if not blob.is_file():
                                continue
                            size = picture(blob)
                            if (
                                size
                                and size[0] >= width
                                and size[1] >= height
                                and abs(size[0] / size[1] - shape) < 0.01
                            ):
                                print(
                                    f"{transcript.name} names a {size[0]}x{size[1]} image of "
                                    f"{blob.stat().st_size} bytes as the prompt's picture"
                                )
                                raise SystemExit(0)
                            found.append(f"{blob.name[:12]} is {size or 'no image'}")
        except OSError:
            continue
    time.sleep(0.3)
raise SystemExit(
    f"no prompt on disk names an image {width}x{height} or larger at {shape:.3f} ({found or ['no image block']})"
)
PY
then
	# The probe reads what the host wrote, so a miss says nothing about why.
	# The host's own log is on this filesystem and the tmpfs it sits on goes
	# with the container, so the tail of it goes to the take's report.
	echo "scene: the host's own log at the miss" >&2
	tail -40 "${HOME}/.veyyon/profiles/${VEYYON_PROFILE:-default}/logs/"*.log >&2 2>/dev/null || true
	abandon_take "the-host-received-the-image" \
		"no prompt the host wrote names an image of the pasted picture's own size, so the card the frames photograph reached the window and not the prompt"
fi

# ─── 5. A Card The Model Will Not Take ───────────────────────────────────────
# The frames above ran with no model on the session, which is the state the
# host reports one in until a model is picked, and a card cannot state a
# refusal without a model to name. So a model is selected here -- every row
# seeded for these takes is a local text model, none of which declares an image
# input -- and the same clipboard is pasted again. The card then says
# `Not accepted by <model>` where the size goes, in the accent, and keeps the
# attachment: a refusal is a statement about the model, not a rejection of the
# file.
#
# WHY A SESSION OF ITS OWN. The turn above wrote a transcript, and that
# transcript moves the composer: the band grows a run bar and the editor sits
# higher than the coordinates the preamble read off the token files. A caption
# read at those coordinates then reads a row the composer no longer draws
# there, which is what a take measuring 668 pixels of the draft leaving the row
# reported as a card that never arrived. A new session empties the transcript
# and puts the composer back where the accepted card was photographed, and the
# reading below is against that frame, so the take proves the band came back
# rather than assuming it.
#
# WHY THE MODEL IS TYPED AND NOT TAKEN OFF THE TOP OF THE LIST. The picker
# opens on the whole catalog, whose first row is a provider this container has
# no key for, and confirming it is refused by the host with
# `No API key for the requested model` -- a take doing that photographed the
# error under a composer still reading `Select model`. The id is typed, and
# what the host stored is read back off its own settings before the card is
# asked to name it.
REFUSING_MODEL_FILTER="1.5b-q8"
REFUSING_MODEL_ID="qwen2.5-1.5b-q8"
# The refusal is the longer of the two captions, drawn beside a warning icon,
# inside a box whose edge takes the accent: a card that swapped one caption for
# the other differs across most of the text column.
REFUSED_MIN_PIXELS=300
# The band the new session draws is the band the accepted card was
# photographed in, less a caret. A number over this says the composer stands
# somewhere else and the caption reading is comparing two different rows.
PRISTINE_BAND_MAX_PIXELS=400
CHIP_ROW_CROP="${COMPOSER_CARD_W}x24+${COMPOSER_CARD_LEFT}+$(( MODEL_CHIP_Y - 12 ))"

k "ctrl+n"
NEW_TRANSCRIPT=0
for _ in $(seq 1 60); do
	NEW_TRANSCRIPT="$(screen_differs_from_frame_pixels_at "${SCENE_OUT}/${SCENE_NAME}-attachment-sent.png" "${TRANSCRIPT_CROP}")"
	if [ "${NEW_TRANSCRIPT}" -ge "${PROMPT_MIN_PIXELS}" ]; then
		break
	fi
	pause 0.5
done
if [ "${NEW_TRANSCRIPT}" -lt "${PROMPT_MIN_PIXELS}" ]; then
	abandon_take "the-new-session-emptied-the-transcript" \
		"the transcript column differs by ${NEW_TRANSCRIPT} pixels from the one the sent prompt filled, under the ${PROMPT_MIN_PIXELS} a page of prose inks, so the session the refusal is read in still holds the turn above"
fi
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
pause 0.8
BAND_CAME_BACK="$(screen_differs_from_frame_pixels_at "${PRISTINE_BAND}" "${COMPOSER_BAND_CROP}")"
if [ "${BAND_CAME_BACK}" -gt "${PRISTINE_BAND_MAX_PIXELS}" ]; then
	abandon_take "the-composer-stands-where-it-did" \
		"the composer band differs by ${BAND_CAME_BACK} pixels from the empty one the accepted card was photographed against, over the ${PRISTINE_BAND_MAX_PIXELS} a caret accounts for, so the row the caption is read in is not the row the size caption was read in"
fi

NEW_BAND="${PROBE_DIR}/attachment-new-session.png"
probe_frame "${NEW_BAND}"
k "ctrl+shift+m"
pause 0.5
t "${REFUSING_MODEL_FILTER}"
pause 0.6
k "Return"
if ! python3 - "${REFUSING_MODEL_ID}" <<'PY'
from pathlib import Path
import sys
import time

wanted = sys.argv[1]
root = Path.home() / ".veyyon"
deadline = time.monotonic() + 20
seen = []
# The host writes the selection into the settings layer it was asked to
# persist, and which file that is belongs to the product rather than to this
# scene. Every settings file under the profile tree is read instead, less the
# model catalogue, which names every row whether one was ever selected.
while time.monotonic() < deadline:
    for settings in sorted(root.rglob("*.yml")) + sorted(root.rglob("*.json")):
        if settings.name == "models.yml":
            continue
        try:
            written = settings.read_text(errors="replace")
        except OSError:
            continue
        if "modelRoles" not in written:
            continue
        for line in written.splitlines():
            if "qwen" in line and ":" in line and "modelRoles" not in line:
                seen.append(f"{settings.name}: {line.strip()}")
        if wanted in written:
            print(f"the host's own settings name {wanted} as the session's model")
            raise SystemExit(0)
    time.sleep(0.25)
raise SystemExit(f"no settings file names {wanted} under a modelRoles key ({seen or ['no modelRoles written']})")
PY
then
	abandon_take "the-model-was-selected" \
		"the host stored no model for the session after the picker was given ${REFUSING_MODEL_FILTER} and confirmed, so the card below has none to refuse for"
fi
MODEL_DREW=0
for _ in $(seq 1 40); do
	MODEL_DREW="$(screen_differs_from_frame_pixels_at "${NEW_BAND}" "${CHIP_ROW_CROP}")"
	if [ "${MODEL_DREW}" -ge 150 ]; then
		break
	fi
	pause 0.25
done
if [ "${MODEL_DREW}" -lt 150 ]; then
	abandon_take "the-model-reached-the-composer" \
		"the footer's model row changed ${MODEL_DREW} pixels after the host stored ${REFUSING_MODEL_ID}, under the 150 a model's name inks over the words the row holds without one, so the window is still offering to select one"
fi

# The same draft as the accepted card's frame, so the only thing that differs
# in the row read below is the caption the card draws and the edge it takes.
type_prompt "Describe what this frame shows."
pause 0.6
BEFORE_REFUSED="${PROBE_DIR}/attachment-before-refused.png"
probe_frame "${BEFORE_REFUSED}"
k "ctrl+v"
REFUSED_DREW=0
for _ in $(seq 1 40); do
	REFUSED_DREW="$(screen_differs_from_frame_pixels_at "${BEFORE_REFUSED}" "${COMPOSER_BAND_CROP}")"
	if [ "${REFUSED_DREW}" -ge "${TRAY_MIN_PIXELS}" ]; then
		break
	fi
	pause 0.25
done
if [ "${REFUSED_DREW}" -lt "${TRAY_MIN_PIXELS}" ]; then
	abandon_take "the-paste-reached-the-tray-again" \
		"the composer band changed ${REFUSED_DREW} pixels after the second paste, under the ${TRAY_MIN_PIXELS} an attachment card inks, so the clipboard image reached no tray and the model has nothing to refuse"
fi
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.8
shot attachment-refused

# The refusal against the size caption the first card drew: same clipboard,
# same draft, same row, one card each, so what differs is the caption and the
# accent the refused card's edge takes.
REFUSED_SAYS_SO="$(frames_differ_pixels_at "${SCENE_OUT}/${SCENE_NAME}-attachment-tray.png" "${SCENE_OUT}/${SCENE_NAME}-attachment-refused.png" "${EDITOR_ROW_CROP}")"
if [ "${REFUSED_SAYS_SO}" -lt "${REFUSED_MIN_PIXELS}" ]; then
	abandon_take "the-card-states-the-refusal" \
		"the card row differs by ${REFUSED_SAYS_SO} pixels from the one drawn under no model, under the ${REFUSED_MIN_PIXELS} a refusal caption and an accent edge ink, so the card drew a size where it owed a refusal"
fi
echo "scene: the new session came back within ${BAND_CAME_BACK}px of the empty composer," \
	"the model row drew ${MODEL_DREW}px, the refused card drew ${REFUSED_DREW}px" \
	"and states its refusal in ${REFUSED_SAYS_SO}px the accepted card does not" >&2
