#!/usr/bin/env bash
# Freeze every agent from the native GPUI window, read the freeze off the strip
# that states it, and end the freeze from the strip's own control.
#
# Records visual evidence for:
#   1. freeze-running  (the window at rest, no strip, agents running)
#   2. freeze-held     (the same window frozen, the strip above the session)
#   3. freeze-released (the same window after the strip's control was pressed)
#
# THE CLAIM. `/pause` engages the host's process-global freeze, which parks
# every agent in the process at its next action boundary. That is state the
# window is in until somebody releases it, not a notice about something that
# already happened, so it draws as a strip across the top of the window for as
# long as it holds, carrying how long it has held and the control that ends it.
# Pressing that control releases the freeze and the strip goes with it.
#
# The differential is live against released, which is the shape of a one-shot
# toggle: frame 1 and frame 3 are the running window, frame 2 is the frozen one.
# All three readings are taken with the pointer parked off every control, which
# is eleven frames a second of change against the twelve the recorder requires,
# so the take declares its own floor:
#
#   SCENE_MOTION_FLOOR=9 proof/docker/record-native.sh \
#     proof/scenes/desktop-agent-freeze.sh
#
# That is not a waiver. The floor stops a stuttering capture being published as
# a clip; a window holding still under a parked pointer is not one, and the
# three frames assert their own pixel counts, which a dropped-frame take could
# not produce.
#
# The freeze crosses the socket as a snapshot section the host emits, so the
# change is in the executable and in the host at once. The other arm holds the
# host source at the commit before the freeze existed and runs a build of that
# same tree, where the query brings up no row that freezes anything and the
# band is empty in all three frames:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     8e983da1b1 freeze-before
#   SCENE_ARM=before PROOF_BASE_REF=8e983da1b1^ SCENE_MOTION_FLOOR=9 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/freeze-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-agent-freeze.sh
#
# WHAT IS MEASURED. One authored colour over one authored rectangle.
#   * The strip's ground is `[tint.attention] fill`, and at rest nothing in the
#     band under the titlebar paints it -- frame 1 is the reading that says so,
#     and the take is abandoned when it does not. So an exact-enough count of
#     that fill in the band is a reading of whether the strip is up.
#   * The band is the strip's own height, which is two S2 insets around one
#     micro line, read from `scale.toml` rather than restated here, so a
#     retuned ramp moves the rectangle with it instead of leaving it reading
#     the transcript below.
#
# The colour comes from the theme this checkout ships, so a retheme moves the
# reading with it.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

# ─── The Band The Strip Takes Off The Top ────────────────────────────────────
# §4.1 gives the strip the attention strip's geometry: one micro line between
# two S2 insets, full width, directly under the titlebar. Both measures are
# authored, so they are read rather than written down again here.
read -r STRIP_H STRIP_PAD_X < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

line = token_px.value_of("scale.toml", "type.size.micro.line_height")
print(2 * token_px.value_of("scale.toml", "spacing.s2") + line,
      token_px.value_of("scale.toml", "spacing.s4"))
PY
)
case "${STRIP_H}" in
	'' | *[!0-9]*)
		abandon_take "the-strip-is-measured" \
			"the strip's height resolved to '${STRIP_H}' instead of a measure"
		;;
esac
STRIP_TOP=$(( WIN_Y + TITLEBAR_H ))
STRIP_CROP="${WIN_W}x${STRIP_H}+${WIN_X}+${STRIP_TOP}"
echo "scene: the freeze states itself in ${STRIP_CROP}" >&2

# The strip is a full-width band of one fill: at this width it is thousands of
# pixels of ground once the line of text and the control are taken out of it.
# The floor is a fraction of that, and far above the nothing an unfrozen window
# paints in the same band.
STRIP_PIXELS_MIN=1200
# What the band may carry with no freeze up. The reading at rest is taken first
# and asserted under this, so the two frames below are read against a band that
# was empty of the colour rather than against an assumption.
STRIP_PIXELS_MAX=200

# The control that ends the freeze sits at the strip's trailing edge, inside
# the band's own horizontal inset. Its centre is derived from that inset and
# the width of the word it carries at the micro ramp, so it follows a retuned
# ramp instead of being a point that used to be right.
RESUME_HALF_W=24
RESUME_X=$(( WIN_X + WIN_W - STRIP_PAD_X - RESUME_HALF_W ))
RESUME_Y=$(( STRIP_TOP + STRIP_H / 2 ))

# Somewhere with nothing under the pointer for every reading, so no hover fill
# is in one frame and not another. The transcript's empty top is outside the
# strip and outside the rail.
PARK_X=$(( WIN_X + RAIL_W + GUTTER_PX ))
PARK_Y=$(( STRIP_TOP + 4 * STRIP_H ))

# Pixels of the strip's own ground inside the band.
strip_pixels() { # <png> -> pixels of the attention fill in the strip's band
	tint_fill_pixels "tint.attention" "$1" "${STRIP_CROP}"
}

# Run one command from the list, by the query that names it.
run_command() { # <query>
	k "ctrl+k"
	pause 0.8
	t "$1"
	pause 0.8
	k "Return"
	pause 1.2
}

# ─── The Window With Nothing Frozen ──────────────────────────────────────────
# The preamble leaves a slash in the editor from the palette it opened, and a
# draft moves the composer's own controls, which is outside this band but is
# cleared anyway so the three frames differ in the strip and nowhere else.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.5

move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot freeze-running
RUNNING_PX="$(strip_pixels "${SCENE_OUT}/${SCENE_NAME}-freeze-running.png")"
echo "scene: at rest the band carries ${RUNNING_PX}px of the strip's ground" >&2
if (( RUNNING_PX > STRIP_PIXELS_MAX )); then
	abandon_take "no-freeze-is-stated-at-rest" \
		"the band under the titlebar carries ${RUNNING_PX}px of the attention fill before anything \
was frozen, over the ${STRIP_PIXELS_MAX} it may carry, so the readings below cannot tell a strip \
from the window's own ground"
fi

# ─── Freezing Every Agent ────────────────────────────────────────────────────
run_command "pause"
move_px "${PARK_X}" "${PARK_Y}"
pause 0.8
shot freeze-held
HELD_PX="$(strip_pixels "${SCENE_OUT}/${SCENE_NAME}-freeze-held.png")"
echo "scene: frozen, the band carries ${HELD_PX}px of the strip's ground" >&2

# ─── Ending It From The Strip, Not From The List ─────────────────────────────
# The control on the strip is the way out a window offers, and the freeze is
# exactly the state in which a list of commands may be the harder thing to
# reach. So the release is a press on the strip itself.
if (( HELD_PX >= STRIP_PIXELS_MIN )); then
	move_px "${RESUME_X}" "${RESUME_Y}"
	pause 0.4
	click
	pause 1.2
else
	# No strip was drawn, so there is no control to press. The command is run
	# instead, leaving the window in the state frame 3 is meant to show rather
	# than frozen for whatever comes after this scene.
	run_command "unpause"
fi
move_px "${PARK_X}" "${PARK_Y}"
pause 0.8
shot freeze-released
RELEASED_PX="$(strip_pixels "${SCENE_OUT}/${SCENE_NAME}-freeze-released.png")"
echo "scene: released, the band carries ${RELEASED_PX}px of the strip's ground" >&2

case "${ARM}" in
	after)
		if (( HELD_PX < STRIP_PIXELS_MIN )); then
			abandon_take "the-freeze-is-stated" \
				"the band carries ${HELD_PX}px of the attention fill while every agent is frozen, \
under the ${STRIP_PIXELS_MIN} a full-width strip fills, so the freeze reached no strip"
		fi
		if (( RELEASED_PX > STRIP_PIXELS_MAX )); then
			abandon_take "the-control-ends-the-freeze" \
				"the band still carries ${RELEASED_PX}px of the attention fill after the strip's \
control was pressed, over the ${STRIP_PIXELS_MAX} an unfrozen window carries, so the press did \
not release the freeze"
		fi
		echo "scene: after arm -- strip ground ${RUNNING_PX} -> ${HELD_PX} -> ${RELEASED_PX}," \
			"a strip while the freeze held and none on either side of it" >&2
		;;
	before)
		if (( HELD_PX >= STRIP_PIXELS_MIN )); then
			abandon_take "the-baseline-states-no-freeze" \
				"the baseline drew a strip: ${HELD_PX}px of the attention fill, at or over the \
${STRIP_PIXELS_MIN} a strip fills"
		fi
		echo "scene: before arm -- strip ground ${RUNNING_PX} -> ${HELD_PX} -> ${RELEASED_PX}," \
			"no row froze anything and no strip was drawn" >&2
		;;
	*)
		abandon_take "the-arm-is-named" "SCENE_ARM is '${ARM}', which is neither arm"
		;;
esac
