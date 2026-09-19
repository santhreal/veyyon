#!/usr/bin/env bash
# Photograph the two sentences the rail draws when a filter matches no session.
#
# Records visual evidence for:
#   1. empty-copy-listed    (the rail listing every session)
#   2. empty-copy-filtered  (a filter nothing matches, and what the rail states)
#
# THE CLAIM. A surface with nothing on it states the condition it is in and the
# step out of it. The rail stated the condition twice: "No matching sessions"
# over `No sessions match "<query>"`, which says the same thing in other words
# and leaves the step to a button label, where an operator reading the prose
# never finds it. The second line is now the step itself.
#
# WHAT IS MEASURED. The inked bounding box of each horizontal band inside the
# rail list crop: one band per line of prose, one for the button under them.
# The rail at rest is read by the height of that crop's ink instead, since a
# list draws its rows with no blank row between them and inks as one band.
# The claim is about what the line under the condition SAYS, and no take can
# read text, so the reading is the shape a restatement and a step have:
#
#   * A restatement of the condition is about as wide as the condition, because
#     it is the same sentence again in other words, at a smaller size.
#   * A step is a different sentence, and this one is wider than the condition
#     it follows.
#
# So no line the before arm draws under its condition is wider than that
# condition, and the after arm draws one wider by at least a fifth of the
# list. The frames carry the words themselves; the bands are what makes the
# pair a measurement rather than two pictures.
#
# The filter is typed into the rail's own search and the overlay is closed
# before the shot, so the prose is photographed unscrimmed: the palette blurs
# what it draws over, and a blurred glyph is not a glyph to measure.
#
# NOT RECORDED HERE: the settings sheet's share of the same change, which
# reordered six pages so each opens on the step and names the capability that
# reported nothing after it. Every one of those pages is empty only when the
# host reports nothing at all, which the recording host never does, so that
# side is proven by
# crates/veyyon-desktop-surface/tests/a-settings-page-with-nothing-on-it-states-the-condition-and-the-step.rs
# rather than by a frame.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The take is three still frames, so it
# declares its own motion floor. Record the after arm with:
#
#   SCENE_MOTION_FLOOR=2 \
#     proof/docker/record-native.sh proof/scenes/desktop-empty-copy.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and names a build whose rail restates its own condition:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/empty-copy.patch empty-copy
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=2 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/empty-copy/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-empty-copy.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Rail, Its Header And Its List Are ─────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crop and the
# click with the surface.
read -r CONTENT_INSET ROW_INSET GAP_BELOW LINE_PX FOOTER_PX HEADER_PX < <(
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
    token_px.value_of("surface/queue.toml", "geometry.section_layout.gap_below"),
    token_px.value_of("surface/queue.toml", "geometry.row_heights.line_px"),
    token_px.value_of("surface/queue.toml", "geometry.footer.height_px"),
    token_px.px("s11"),
)
PY
)
if [ -z "${HEADER_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read the queue layout tokens"
fi

if [ "${QUEUE_MODE}" != "inline" ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px draws no inline queue rail"
fi

NAV_HEADER_PX=$(( CONTENT_INSET + HEADER_PX + GAP_BELOW ))
CROP_X="${WIN_X}"
CROP_Y=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
CROP_W=$(( RAIL_W - 2 ))
CROP_H=$(( WIN_H - TITLEBAR_H - NAV_HEADER_PX - FOOTER_PX ))
RAIL_CROP="${CROP_W}x${CROP_H}+${CROP_X}+${CROP_Y}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The header's search control fills the row left of the new-session button.
SEARCH_X=$(( WIN_X + ROW_INSET + (RAIL_W - 2 * ROW_INSET - HEADER_PX) / 2 ))
SEARCH_Y=$(( WIN_Y + TITLEBAR_H + CONTENT_INSET + HEADER_PX / 2 ))

# No title and no workspace path in this store carries `zzz`.
QUERY="zzz"
OVERLAY_MIN_PIXELS=4000
# A glyph stands this far off the rail's own ground, and a band is a row with
# at least this many of them: one stray antialiased pixel is not a line of text.
INK_DELTA=10
INK_PIXELS=2
ARM="${SCENE_ARM:-after}"

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# One `<top>:<height>:<left>:<width>` line per inked band, in crop coordinates.
# The ground is the crop's own most common tone, so a retheme moves the reading
# with the surface instead of leaving a floor on brightness behind.
BANDS_PY="${TMPDIR}/empty-copy-bands.py"
cat >"${BANDS_PY}" <<'PY'
import sys
from collections import Counter

width, height, delta, minimum = (int(argument) for argument in sys.argv[1:5])
pixels = sys.stdin.buffer.read()
if len(pixels) < width * height:
    raise SystemExit(f"the crop read {len(pixels)} bytes, short of {width * height}")

ground = Counter(pixels[: width * height]).most_common(1)[0][0]
rows = []
for row in range(height):
    line = pixels[row * width : (row + 1) * width]
    lit = [column for column, value in enumerate(line) if abs(value - ground) >= delta]
    rows.append(lit if len(lit) >= minimum else [])

bands: list[tuple[int, int, int, int]] = []
start = None
for row in range(height + 1):
    lit = rows[row] if row < height else []
    if lit and start is None:
        start = row
    elif not lit and start is not None:
        columns = [column for inner in rows[start:row] for column in inner]
        bands.append((start, row - start, min(columns), max(columns) - min(columns) + 1))
        start = None
for top, band_height, left, band_width in bands:
    print(f"{top}:{band_height}:{left}:{band_width}")
PY

rail_bands() { # <shot> -> one band line per row of ink in the rail list
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		-crop "${RAIL_CROP}" +repage -colorspace Gray -depth 8 gray:- |
		python3 "${BANDS_PY}" "${CROP_W}" "${CROP_H}" "${INK_DELTA}" "${INK_PIXELS}"
}

band_field() { # <bands> <index> <field> -> one number out of the band table
	echo "$1" | sed -n "$2p" | cut -d: -f"$3"
}

rail_ink_height() { # <shot> -> height of the inked bounding box in the rail list
	local box
	box="$(magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" -crop "${RAIL_CROP}" +repage \
		-fuzz 5% -trim -format '%h' info: 2>/dev/null || true)"
	if [ -z "${box}" ]; then
		abandon_take "rail-list-trimmed" "no inked pixels in the rail list crop of $1"
	fi
	echo "${box}"
}

# ─── 1. The Rail Listing Every Session ───────────────────────────────────────
# The pointer is parked off the rail for every frame, so no row carries hover
# styling in one frame and not in another.
if ! native_session_ready before; then
	abandon_take "native-host-ready" "the native host returned no session snapshot within 10s"
fi
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.8
shot empty-copy-listed

# A list of sessions inks its rows without a blank row between them, so it is
# read by height rather than by bands: three rows of ink is a list there is
# something to empty.
LISTED_PX="$(rail_ink_height empty-copy-listed)"
if [ "${LISTED_PX}" -lt $(( LINE_PX * 3 )) ]; then
	abandon_take "rail-lists-sessions" \
		"the rail inked ${LISTED_PX}px of rows at rest, under the ${LINE_PX}px x 3 a list of sessions takes"
fi

# ─── 2. A Filter No Session Matches ──────────────────────────────────────────
RAIL_AT_REST="${PROBE_DIR}/rail-at-rest.png"
probe_frame "${RAIL_AT_REST}"
move_px "${SEARCH_X}" "${SEARCH_Y}"
pause 0.3
click
pause 0.8
OPENED="$(screen_differs_from_frame_pixels_at "${RAIL_AT_REST}" "${WINDOW_CROP}")"
if [ "${OPENED}" -lt "${OVERLAY_MIN_PIXELS}" ]; then
	abandon_take "search-opened" \
		"clicking the rail's search control moved ${OPENED} pixels, so no search surface opened"
fi
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
t "${QUERY}"
pause 1.2

# The overlay closes before the shot: the filter outlives it, and the prose is
# photographed on the rail's own ground rather than through a blur.
k "Escape"
pause 1.0
shot empty-copy-filtered

BANDS="$(rail_bands empty-copy-filtered)"
BAND_COUNT="$(echo "${BANDS}" | grep -c ':' || true)"
if [ "${BAND_COUNT}" -lt 2 ]; then
	abandon_take "empty-state-drawn" \
		"the filtered rail inked ${BAND_COUNT} bands, so it drew no pair of sentences"
fi

# The condition is the first line the block draws. What the reading turns on is
# whether anything under it is a wider sentence, so the widest band is taken
# rather than the second one: the button under the prose is narrower than
# either line, and an extra band from a wrapped step is still the step.
CONDITION_W="$(band_field "${BANDS}" 1 4)"
WIDEST_W="$(echo "${BANDS}" | cut -d: -f4 | sort -n | tail -1)"
WIDEST_H="$(echo "${BANDS}" | sort -t: -k4 -n | tail -1 | cut -d: -f2)"
WIDER=$(( WIDEST_W - CONDITION_W ))
# A fifth of the list's width: enough that a different sentence is what moved
# the reading, not a wider glyph or a trailing space.
STEP_MARGIN=$(( CROP_W / 5 ))

# ─── 3. What The Arms Are Judged On ──────────────────────────────────────────
printf 'scene: the filtered rail inked these bands (top:height:left:width)\n'
echo "${BANDS}" | sed 's/^/scene:   /'

if [ "${ARM}" = "before" ]; then
	if [ "${WIDER}" -ge "${STEP_MARGIN}" ]; then
		abandon_take "before-restates-the-condition" \
			"the before arm draws a line ${WIDER}px wider than its condition, so this build already states a step"
	fi
	printf 'scene: before arm -- %s bands, the condition %spx wide and nothing under it wider than %spx\n' \
		"${BAND_COUNT}" "${CONDITION_W}" "${WIDEST_W}"
else
	if [ "${WIDER}" -lt "${STEP_MARGIN}" ]; then
		abandon_take "the-step-is-stated" \
			"the widest line is ${WIDER}px wider than the condition, under the ${STEP_MARGIN}px a step rather than a restatement takes"
	fi
	if [ "${WIDEST_H}" -lt 6 ]; then
		abandon_take "the-step-is-stated" \
			"the widest line inked ${WIDEST_H}px of height, too little to be a line of prose"
	fi
	printf 'scene: after arm -- %s bands, the condition %spx wide over a step %spx wide, %spx wider\n' \
		"${BAND_COUNT}" "${CONDITION_W}" "${WIDEST_W}" "${WIDER}"
fi
