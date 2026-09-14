#!/usr/bin/env bash
# Photograph the queue rail's footer in the native GPUI window and drive the
# one control it holds: the settings gear.
#
# Records visual evidence for:
#   1. rail-footer-gear-at-rest   (the footer band with the gear drawn in it)
#   2. rail-footer-settings-open  (the settings overlay the gear opened)
#   3. rail-footer-after-escape   (the surface Escape left the window on)
#
# WHAT IS MEASURED. §5.2 gives the rail a 36px footer holding one 16px gear,
# inset at the bottom-left, with no ground and no edge. Each frame is reduced
# to the inked bounding box inside the footer band crop, and the scene asserts
# the band holds ink, that the ink is one control's worth of it rather than a
# strip, that it starts on the authored inset and centres on the band, that
# pressing it opens the settings overlay, and that Escape returns the window to
# the frame it was photographed in.
#
# THE TWO PAIRS. The glyph the footer draws is one differential: both arms hold
# every assertion above, so the pair is read from the frames rather than from a
# pixel count -- at the drawn size the two glyphs differ by fewer than twenty
# lit pixels out of 256, and no count threshold separates them from rasteriser
# variance. Where Escape lands is the other: an executable that ascends through
# the route table opens the command palette instead of closing the surface the
# gear opened, which the third frame shows and the printed distance from the
# at-rest frame states.
#
# NOT RECORDED HERE: that the gear survives the rail's narrow widths, which
# `crates/veyyon-desktop-surface/tests/the-rail-footer-gear-is-reachable-at-every-width-that-draws-a-rail.rs`
# asserts across the breakpoint rows; and that no other command destination
# reaches the rail, which
# `crates/veyyon-desktop-surface/tests/the-only-rail-shortcut-to-a-command-destination-is-the-gear.rs`
# asserts against the command table.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-rail-footer.sh
#
# and its other arm, whose executable is a build of this tree carrying the
# glyph the footer drew before:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/gear.patch gear
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/gear/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-rail-footer.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Footer And Its Gear Are ───────────────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crop with
# the footer instead of leaving the scene measuring the rows above it.
read -r FOOTER_H FOOTER_INSET GEAR_PX < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())
footer = queue["footer"]

print(
    int(footer["height_px"]),
    int(scale["spacing"][footer["inset"]]),
    int(footer["gear_size_px"]),
)
PY
)
if [ -z "${GEAR_PX:-}" ]; then
	abandon_take "tokens-resolved" "could not read queue footer tokens"
fi

if [ "${WIN_W}" -le 800 ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px has no queue rail"
fi

# The footer band: the rail's own width less its trailing hairline, and the
# window's last FOOTER_H rows, which is where the footer is pinned.
BAND_X="${WIN_X}"
BAND_Y=$(( WIN_Y + WIN_H - FOOTER_H ))
BAND_W=$(( RAIL_W - 2 ))
BAND_H="${FOOTER_H}"
BAND_CROP="${BAND_W}x${BAND_H}+${BAND_X}+${BAND_Y}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# The gear's own press point. The button is the footer row's leading child, so
# its box starts one inset in; half a glyph past that is inside the button at
# any padding the kit gives it.
GEAR_X=$(( WIN_X + FOOTER_INSET + GEAR_PX / 2 ))
GEAR_Y=$(( BAND_Y + FOOTER_H / 2 ))

# A control's worth of ink, not a strip: one glyph plus the padding a ghost
# icon button is entitled to on each side of it.
GEAR_BOX_MAX=$(( GEAR_PX * 3 ))
SETTINGS_MIN_PIXELS=2000
RETURN_MAX_PIXELS=400

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

footer_ink_box() { # <shot> -> WxH+X+Y of the inked bounding box in the footer band
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local box
	# `%@` is the box the image would trim to, in the image's own coordinates,
	# so it is read off the crop rather than after `-trim`: trimming first
	# leaves the ink at the origin of what remains and reports every frame at
	# +0+0, which no placement can fail.
	box="$(magick "${png}" -crop "${BAND_CROP}" +repage \
		-fuzz 12% -format '%@' info: 2>/dev/null || true)"
	if [ -z "${box}" ]; then
		abandon_take "footer-band-inked" "no inked pixels in the rail footer band for $1"
	fi
	echo "${box}"
}

# ─── 1. Empty The Composer And Photograph The Footer At Rest ─────────────────
# The shared prelude leaves a draft in the composer and the pointer parked on
# the editor. Clearing the draft is what makes this frame a state of its own,
# and it leaves the window holding nothing but its chrome, which is the frame
# the footer is read from. The pointer stays off the gear, so the control is
# photographed at rest rather than under the ghost button's hover ground.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.3
click
pause 0.3
k "End"
for _ in $(seq 1 80); do
	k "BackSpace"
done
pause 0.8
shot rail-footer-gear-at-rest

BOX="$(footer_ink_box rail-footer-gear-at-rest)"
IFS='x+' read -r INK_W INK_H INK_X INK_Y <<<"${BOX}"
if [ -z "${INK_Y:-}" ]; then
	abandon_take "footer-band-measured" "could not read the footer ink box (got '${BOX}')"
fi
if [ "${INK_W}" -gt "${GEAR_BOX_MAX}" ] || [ "${INK_H}" -gt "${GEAR_BOX_MAX}" ]; then
	abandon_take "footer-holds-one-control" \
		"footer ink measures ${INK_W}x${INK_H}px, wider than one ${GEAR_PX}px control with its padding (${GEAR_BOX_MAX}px)"
fi
# §5.2 insets the control at the footer's leading edge and centres it in the
# band, both read from the tokens rather than from a remembered pixel: the ink
# starts no earlier than the authored inset and no later than one glyph past
# it, and its centre sits on the band's own centre line.
if [ "${INK_X}" -lt "${FOOTER_INSET}" ] || [ "${INK_X}" -gt $(( FOOTER_INSET + GEAR_PX )) ]; then
	abandon_take "footer-gear-is-inset" \
		"footer ink starts ${INK_X}px into the band, off the authored ${FOOTER_INSET}px inset"
fi
INK_MID=$(( INK_Y + INK_H / 2 ))
BAND_MID=$(( BAND_H / 2 ))
if [ $(( INK_MID > BAND_MID ? INK_MID - BAND_MID : BAND_MID - INK_MID )) -gt 3 ]; then
	abandon_take "footer-gear-is-centred" \
		"footer ink centres on row ${INK_MID} of a ${BAND_H}px band, off its ${BAND_MID}px centre"
fi
echo "scene: rail footer ink ${INK_W}x${INK_H} at +${INK_X}+${INK_Y} in a ${BAND_W}x${BAND_H} band" >&2

# ─── 2. Press The Gear And Prove The Settings Overlay Opened ─────────────────
AT_REST="${PROBE_DIR}/rail-footer-at-rest.png"
probe_frame "${AT_REST}"
move_px "${GEAR_X}" "${GEAR_Y}"
pause 0.3
click
pause 1.0
OPENED="$(screen_differs_from_frame_pixels_at "${AT_REST}" "${WINDOW_CROP}")"
if [ "${OPENED}" -lt "${SETTINGS_MIN_PIXELS}" ]; then
	abandon_take "footer-gear-opens-settings" \
		"pressing the rail footer gear changed ${OPENED} pixels, under the ${SETTINGS_MIN_PIXELS} an overlay draws"
fi
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
shot rail-footer-settings-open

# ─── 3. Escape Returns The Window To The Frame It Was Photographed In ────────
# The gear opens the settings surface with nothing above it, so Escape closes
# it (§5.8). The frame is photographed rather than only measured, because the
# surface an ascent lands on is the other pair this scene records: an arm whose
# executable ascends through the route table instead lands on the command
# palette, and the distance printed below is the difference between the two.
k "Escape"
pause 1.0
RETURNED="$(screen_differs_from_frame_pixels_at "${AT_REST}" "${WINDOW_CROP}")"
shot rail-footer-after-escape
if [ "${SCENE_ARM:-after}" = "before" ]; then
	# A baseline that ascends elsewhere would abandon every before take on the
	# assertion below, so this arm records where it landed and states it.
	echo "scene: the baseline left ${RETURNED}px differing from the at-rest frame after Escape" >&2
	return 0
fi
if [ "${RETURNED}" -gt "${RETURN_MAX_PIXELS}" ]; then
	abandon_take "escape-returns-from-settings" \
		"Escape left ${RETURNED} pixels differing from the at-rest frame, over the ${RETURN_MAX_PIXELS} a settled window allows"
fi
echo "scene: gear opened settings (${OPENED}px changed) and Escape returned to rest (${RETURNED}px differ)" >&2
