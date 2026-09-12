#!/usr/bin/env bash
# Read back whether the desktop states the model a submitted prompt would run
# on, before any model is chosen in the window.
#
# Records visual evidence for:
#   1. chip-at-rest      (the composer's model chip as the window launched it)
#   2. name-ink          (a model's name typed into the editor, the measured
#                         scale every later reading is judged against)
#   3. picker-first-row  (the model picker open on its first row)
#   4. chip-after-pick   (the chip after that first row was chosen)
#
# THE CLAIM. The chip states the model the next turn will run on. The host
# answered it from the legacy `modelRoles.default` slot alone, which the
# recorder's profile never writes and which no path but the CLI `--model` flag
# writes either, so the window drew `Select model` while a submitted prompt ran
# on a model it had never named -- the session resolves its own model through
# the credential store and the `enabledModels` scope, and published that answer
# nowhere. A session now publishes the model it resolved as soon as it exists,
# and the no-session answer mirrors that same resolution.
#
# WHAT IS MEASURED. The picker lists the model in effect first, marked `in
# effect`, so choosing its first row is a no-op in a window that already states
# its model and a replacement in a window that states nothing. The reading is
# the ink that changes in the chip's own row between the frame before the pick
# and the frame after it: nothing when the chip already named that model, a
# whole label when it read `Select model`.
#
# The floor is measured rather than asserted: the same model name is typed into
# the editor first and the ink it draws is the scale. A label replaced draws a
# large fraction of it; a label unchanged draws a small one.
#
# The change is inside the host the window talks to, not the executable, so
# both arms share one build and the before arm holds the source:
#
#   proof/docker/record-native.sh proof/scenes/desktop-stated-model.sh
#   SCENE_ARM=before PROOF_BASE_REF=<fix>^ \
#     proof/docker/record-native.sh proof/scenes/desktop-stated-model.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Chip Is Read ──────────────────────────────────────────────────
# The chip is the leading control of the composer card's footer row. The strip
# is that row's own band across the card's leading half, which holds the chip
# and the controls beside it and excludes the trailing send control, whose
# enabled state follows the draft rather than the model.
CHIP_STRIP_X="${COMPOSER_CARD_LEFT}"
CHIP_STRIP_W=$(( COMPOSER_CARD_W / 2 ))
CHIP_STRIP_Y=$(( MODEL_CHIP_Y - 2 * GUTTER_PX ))
CHIP_STRIP_H=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - CHIP_STRIP_Y ))
if [ "${CHIP_STRIP_H}" -lt 16 ] || [ "${CHIP_STRIP_W}" -lt 120 ]; then
	abandon_take "the-chip-has-a-row" \
		"the footer row resolved to ${CHIP_STRIP_W}x${CHIP_STRIP_H}px, too small to hold a label"
fi
chip_strip_region() {
	use_crop "${CHIP_STRIP_X}" "${CHIP_STRIP_Y}" "${CHIP_STRIP_W}" "${CHIP_STRIP_H}"
}
echo "scene: the chip is read over ${CHIP_STRIP_W}x${CHIP_STRIP_H}+${CHIP_STRIP_X}+${CHIP_STRIP_Y}" >&2

# ─── The Composer At Rest ────────────────────────────────────────────────────
# The preamble left a slash in the composer and the palette dismissed. The
# draft is cleared first, so the frame the pick is measured against is the
# window as it launched rather than the window holding a leftover character.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
pause 0.3
k "ctrl+a"
k "BackSpace"
pause 0.6
shot chip-at-rest

# ─── The Scale ───────────────────────────────────────────────────────────────
# A model's name typed into the editor, drawn by the same font stack in the
# same window. Its ink is the scale both arms are judged against, so neither
# floor is a number this scene decided.
t "Qwen2.5 1.5B (local)"
pause 1.0
shot name-ink
composer_band_region
NAME_PX="$(shots_differ_pixels chip-at-rest name-ink)"
if [ "${NAME_PX}" -lt 150 ]; then
	abandon_take "a-name-has-a-scale" \
		"typing a model name drew ${NAME_PX}px, so the keystrokes never reached the editor"
fi
k "ctrl+a"
k "BackSpace"
pause 0.8

# ─── The Picker's First Row ──────────────────────────────────────────────────
k "ctrl+shift+m"
pause 1.2
shot picker-first-row
transcript_region
PICKER_OPEN="$(shots_differ_per_mille chip-at-rest picker-first-row)"
if [ "${PICKER_OPEN}" -lt 40 ]; then
	abandon_take "the-picker-opened" \
		"the picker drew ${PICKER_OPEN}/1000 of the surface, so no overlay opened over it"
fi

# Enter runs the selected row, which is the first one the list drew.
k "Return"
pause 1.5
shot chip-after-pick
transcript_region
PICKER_GONE="$(shots_differ_per_mille chip-at-rest chip-after-pick)"
if [ "${PICKER_GONE}" -ge "$(( PICKER_OPEN / 4 ))" ]; then
	abandon_take "the-row-was-chosen" \
		"the surface still differs by ${PICKER_GONE}/1000 against ${PICKER_OPEN}/1000 open, so the row never ran"
fi

chip_strip_region
CHIP_PX="$(shots_differ_pixels chip-at-rest chip-after-pick)"

ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	# The chip named no model, so choosing one replaces the whole label.
	if [ "${CHIP_PX}" -lt "$(( NAME_PX / 4 ))" ]; then
		abandon_take "the-chip-named-nothing" \
			"the before arm's chip changed by ${CHIP_PX}px against a ${NAME_PX}px name, so it already stated a model"
	fi
else
	# The chip already named the model in effect, which is the row that was
	# chosen, so the pick leaves the label where it was.
	if [ "${CHIP_PX}" -gt "$(( NAME_PX / 20 ))" ]; then
		abandon_take "the-chip-stated-the-model" \
			"the after arm's chip changed by ${CHIP_PX}px against a ${NAME_PX}px name, so it stated a different model"
	fi
fi

echo "scene: ${ARM} arm -- choosing the first row moved ${CHIP_PX}px of a ${NAME_PX}px name" >&2
