#!/usr/bin/env bash
# Photograph the box the settings page is drawn in and the edge it inks.
#
# Records visual evidence for:
#   1. settings-chrome-sheet  (the settings page an operator routes to)
#
# THE CLAIM. Every path to settings routes a page: the palette's settings row
# and `primary-,` both open the list of pages, and a row there routes the page.
# That page was drawn in the command palette's box -- 576px, the width authored
# for a command list -- so a page of label, description and control column was
# truncated in it, and it drew no boundary of its own, leaving a rounded fill
# running into whatever the scrim left showing behind it. The page is now the
# box `surface/settings.toml` authors for it, inking its own boundary in the
# theme's hairline role.
#
# WHAT IS MEASURED. The box is found in the frame rather than computed for it,
# so each arm measures the box it drew. The page stands on the theme's float
# role, so the tallest unbroken block of rows carrying a run of that ground is
# the page, and its ends are the page's top and bottom. On every fourth row of
# it, less a corner's worth at each end, the walk starts at the ground and
# steps outward through any hairline beside it. Where it stops is the box's
# own edge.
#
# That gives each arm two readings taken inside one frame: how wide the box is,
# and on how many rows its edge is inked rather than meeting the scrim. A box
# drawn without a border is its ground and nothing else, so the walk stops at
# once and reads the palette's width with no inked row on it.
#
# A hairline is a whisper by design -- six levels of blue from the ground it
# edges -- so the reading is the role's own colour out of the theme file rather
# than a contrast threshold no hairline could clear.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The take is one still frame, so it declares
# its own motion floor. Record the after arm with:
#
#   SCENE_MOTION_FLOOR=2 \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-chrome.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and names a build that draws the page in the palette's box:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/settings-chrome.patch settings-chrome
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=2 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/settings-chrome/veyyon-desktop \
#     DESKTOP_BINARY=.internal/captures/settings-chrome/veyyon-desktop-after \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-chrome.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── What The Tokens Author ──────────────────────────────────────────────────
# Read from the tokens this checkout ships, so a window too small for the sheet
# is reported as that rather than measured as a page in the wrong box.
read -r SHEET_H SHEET_AUTHORED_W PALETTE_W MARGIN < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
	scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

print(
	token_px.value_of("surface/settings.toml", "layout.sheet_height_px"),
	token_px.value_of("surface/settings.toml", "layout.group_width_px"),
	token_px.value_of("surface/palette.toml", "geometry.width_px"),
	token_px.value_of("scale.toml", "spacing.s4"),
)
PY
)
if [ -z "${MARGIN:-}" ]; then
	abandon_take "tokens-resolved" "could not read the settings, palette and scale tokens"
fi

COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
SHEET_DRAWN_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( SHEET_DRAWN_H > SHEET_H )); then SHEET_DRAWN_H=$SHEET_H; fi
if (( SHEET_DRAWN_H < 480 )); then
	abandon_take "sheet-room" \
		"the window leaves ${SHEET_DRAWN_H}px for a sheet its tokens author at ${SHEET_H}px"
fi

# A hairline runs the whole edge, so a quarter of the rows state the same fact
# at a quarter of the pixels read. The corner inset keeps the walk off the
# rounded ends, where a row is ground on one column and scrim on the next
# whatever colour the border is.
CORNER=40
ROW_STEP=4
ARM="${SCENE_ARM:-after}"

sheet_box() { # <shot> -> "<leading> <trailing> <sampled> <width>" or a reason
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local scratch="${TMPDIR}/sheet-edge"
	mkdir -p "${scratch}"
	magick "${png}" -depth 8 "${scratch}/frame.ppm" 2>/dev/null || true
	if [ ! -s "${scratch}/frame.ppm" ]; then
		abandon_take "frame-read" "the frame of $1 could not be read as pixels"
	fi
	python3 - "${scratch}/frame.ppm" "${BASH_SOURCE[0]%/*}" "${CORNER}" "${ROW_STEP}" <<'PY'
from collections import Counter
from pathlib import Path
import sys

frame, scenes_dir = sys.argv[1], Path(sys.argv[2]).resolve()
corner, step = int(sys.argv[3]), int(sys.argv[4])
if scenes_dir.is_file():
	scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

# A binary PPM states its magic, width, height and depth as whitespace
# separated fields, and the pixels follow the byte after the depth.
data = Path(frame).read_bytes()
fields, at = [], 2
while len(fields) < 3:
	while at < len(data) and data[at : at + 1].isspace():
		at += 1
	if data[at : at + 1] == b"#":
		while data[at : at + 1] not in (b"\n", b""):
			at += 1
		continue
	start = at
	while at < len(data) and not data[at : at + 1].isspace():
		at += 1
	fields.append(int(data[start:at]))
width, height, depth = fields
pixels = bytes(data[at + 1 :])
if depth != 255 or len(pixels) < width * height * 3:
	print("frame-shape")
	raise SystemExit


def pixel(x, y):
	base = (y * width + x) * 3
	return (pixels[base], pixels[base + 1], pixels[base + 2])


def near(one, other, slack=2):
	return max(abs(p - q) for p, q in zip(one, other)) <= slack


def rgb_of(text):
	digits = text.lstrip("#")
	return tuple(int(digits[index : index + 2], 16) for index in (0, 2, 4))


# The front end starts on the bundled dark theme: float is the ground a page
# floating over the session stands on, and hairline is what a surface that
# edges itself edges itself in.
hairline = rgb_of(token_px.text_of("themes/dark.toml", "role.hairline"))
ground = rgb_of(token_px.text_of("themes/dark.toml", "role.float"))
run = bytes(ground) * 3


def ground_run(row):
	"""Return the first and last pixel of the row's outermost runs of ground."""
	first, at = None, 0
	while first is None:
		hit = row.find(run, at)
		if hit < 0:
			return None
		first, at = (hit // 3, at) if hit % 3 == 0 else (None, hit + 1)
	last, end = None, len(row)
	while last is None:
		hit = row.rfind(run, 0, end)
		if hit < 0:
			return None
		last, end = (hit // 3 + 2, end) if hit % 3 == 0 else (None, hit + 2)
	return first, last


# A row of the page carries ground with a column to spare on both sides of it.
# The page is the tallest unbroken block of such rows, so a card of the same
# ground elsewhere in the frame is read as the shorter block it is.
page_rows, block, longest = {}, [], []
for y in range(height):
	edge = ground_run(pixels[y * width * 3 : (y + 1) * width * 3])
	if edge is None or edge[0] == 0 or edge[1] == width - 1:
		block = []
		continue
	page_rows[y] = edge
	block.append(y)
	if len(block) > len(longest):
		longest = block
if len(longest) < 2 * corner + 4 * step:
	print("no-page")
	raise SystemExit

leading = trailing = sampled = 0
widths = Counter()
for y in longest[corner : len(longest) - corner : step]:
	sampled += 1
	first, last = page_rows[y]
	left, right = first, last
	while left > 0 and near(pixel(left - 1, y), hairline):
		left -= 1
	while right < width - 1 and near(pixel(right + 1, y), hairline):
		right += 1
	leading += 1 if left < first else 0
	trailing += 1 if right > last else 0
	widths[right - left + 1] += 1
print(leading, trailing, sampled, widths.most_common(1)[0][0])
PY
}

# ─── Open The Settings Page ──────────────────────────────────────────────────
# The palette's settings row lists the pages, and the first of them is General:
# the second Return routes that page, which is the box this scene measures.
# One Return short of it photographs the list of pages, which is the palette.
if ! native_session_ready before; then
	abandon_take "native-host-ready" "the native host returned no session snapshot within 10s"
fi
k "ctrl+k"
pause 0.6
t "settings"
pause 0.8
k "Return"
pause 1.6
k "Return"
pause 2.4

# The pointer is parked off the box, so no row carries hover styling.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.8
shot settings-chrome-sheet

read -r LEADING TRAILING SAMPLED BOX_W <<<"$(sheet_box settings-chrome-sheet)"
case "${LEADING}" in
	no-page)
		abandon_take "page-found" \
			"no block of the theme's float ground is tall enough to be the settings page"
		;;
	"")
		abandon_take "theme-known" \
			"the resolver answered no colour for the dark theme's hairline or float role"
		;;
	frame-shape)
		abandon_take "frame-read" "the frame did not decode as 8-bit RGB pixels"
		;;
esac

# An edge that inks is inked on four fifths of the rows at worst, the rest
# being where a selected row's own fill reaches the boundary. An edge that was
# never drawn inks on none, so the before arm is held to a tenth of the rows
# for this renderer's own noise.
INKED_MIN=$(( SAMPLED * 4 / 5 ))
NOISE_MAX=$(( SAMPLED / 10 ))

# ─── What The Arms Are Judged On ─────────────────────────────────────────────
printf 'scene: the settings page is drawn in a %spx box, inking %s of %s sampled rows leading and %s trailing\n' \
	"${BOX_W}" "${LEADING}" "${SAMPLED}" "${TRAILING}"

if [ "${ARM}" = "before" ]; then
	if [ "${BOX_W}" != "${PALETTE_W}" ]; then
		abandon_take "settings-chrome-box" \
			"the baseline draws the settings page in a ${BOX_W}px box where the palette it borrows is ${PALETTE_W}px"
	fi
	if [ "${LEADING}" -gt "${NOISE_MAX}" ] || [ "${TRAILING}" -gt "${NOISE_MAX}" ]; then
		abandon_take "settings-chrome-edge" \
			"the baseline already inks ${LEADING} leading and ${TRAILING} trailing rows of ${SAMPLED}, over the ${NOISE_MAX} this renderer's own noise moves"
	fi
	echo "scene: before arm -- the page is the palette's ${PALETTE_W}px box, meeting the scrim with no edge" >&2
else
	if [ "${BOX_W}" != "${SHEET_AUTHORED_W}" ]; then
		abandon_take "settings-chrome-box" \
			"the settings page is drawn in a ${BOX_W}px box where surface/settings.toml authors ${SHEET_AUTHORED_W}px for it"
	fi
	if [ "${LEADING}" -lt "${INKED_MIN}" ]; then
		abandon_take "settings-chrome-leading" \
			"the sheet inks its leading edge on ${LEADING} of ${SAMPLED} rows, under ${INKED_MIN}"
	fi
	if [ "${TRAILING}" -lt "${INKED_MIN}" ]; then
		abandon_take "settings-chrome-trailing" \
			"the sheet inks its trailing edge on ${TRAILING} of ${SAMPLED} rows, under ${INKED_MIN}"
	fi
	echo "scene: after arm -- the sheet is its own ${SHEET_AUTHORED_W}px box, edged in hairline" >&2
fi
