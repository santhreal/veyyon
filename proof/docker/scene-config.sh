#!/usr/bin/env bash
# The single definition of every SCENE_* knob, and the backdrop both display
# servers draw.
#
#   source proof/docker/scene-config.sh
#
# WHY THIS FILE EXISTS. The same knob had up to four homes and they disagreed.
# SCENE_FPS defaulted to 30 in xsession.sh, 30 in record-x11.sh, 60 in
# wlsession.sh and 60 in record-wl.sh, so the rate a take was captured at
# depended on which of the four a caller happened to go through, and the hero
# ran at 60 for months because one of the four said so. SCENE_WIDTH disagreed the
# same way: 1600 on the X path, 2560 on the Wayland path. A default that is
# written down twice is not a default, it is two, and the one a run uses is
# whichever file it entered through.
#
# The backdrop was worse: the thirteen-line ImageMagick recipe was copied whole
# into xsession.sh and wlsession.sh. Two copies of an image pipeline drift into
# two different images, and nothing compares them, so the Wayland take and the X
# take would have stopped looking like the same product without one line of the
# diff saying so.
#
# So every default is assigned here with `:=`, which means an exported value from
# the host still wins and a caller that sets nothing gets one answer. Sourcing
# this file runs no container and needs no ImageMagick: the recipe is a function,
# called only where it is drawn.
#
# ONE DEFAULT PER KNOB, and where the two paths disagreed the X value wins,
# because more scenes go through it. The hero states its own geometry in
# scripts/demos/record-hd-demo.sh and is unaffected by the choice.

# ─── Geometry and capture ───────────────────────────────────────────────────
: "${SCENE_WIDTH:=1600}"
: "${SCENE_HEIGHT:=1000}"
: "${SCENE_FONT_SIZE:=15}"
# 30, because 30 is what the pipeline delivers whole. Measured at 2560x1440 with
# the hero's chrome and a payload repainting every cell as fast as the terminal
# accepts it: 240 unique frames of 240 grabbed. Capturing at 60 does not add
# motion the session never had -- it doubles the encoder's cores and the file and
# writes a 60 fps header over slower content, which is how a stuttering take came
# to read as smooth to ffprobe. Judge a take with proof/motion-gate.sh.
: "${SCENE_FPS:=30}"
: "${SCENE_TERMINAL:=kitty}"
: "${SCENE_BG:=#1e2127}"
: "${SCENE_FG:=#d7dae0}"
: "${SCENE_PADDING:=8}"

# ─── Chrome ─────────────────────────────────────────────────────────────────
: "${SCENE_THEME:=plain}"
: "${SCENE_MARGIN:=128}"
: "${SCENE_RADIUS:=26}"
: "${SCENE_OPACITY:=0.72}"
: "${SCENE_SHADOW_RADIUS:=44}"
: "${SCENE_SHADOW_OPACITY:=0.55}"
: "${SCENE_SHADOW_OFFSET_X:=-22}"
: "${SCENE_SHADOW_OFFSET_Y:=-12}"

# WHERE THE CHROME IS DRAWN. `post` records the terminal alone and composites the
# backdrop, the rounding, the shadow and the opacity afterwards from stills.
# `live` runs a compositor over the session while it records.
#
# `post` is the default because the backdrop does not move. It is generated once
# from a fixed recipe and never changes for the length of a take, so compositing
# it 30 times a second is the same picture computed 4500 times. Live compositing
# is also what cost the frames: with picom's blur on, ffmpeg could grab only 69
# of 360 frames, because the X server had nothing left to answer a capture with.
# Nothing downstream recovers a frame that was never drawn.
: "${SCENE_CHROME:=post}"
: "${SCENE_CHROME_BACKEND:=xrender}"
# Kept only so the claim that the blur was free to delete stays falsifiable.
# Measured at 0.001/255 RMSE against the unblurred arm -- the backdrop is a
# smooth gradient already blurred to 0x26, and blurring a smooth gradient returns
# the same gradient. It is not a quality knob.
: "${SCENE_CHROME_BLUR:=0}"
: "${SCENE_BLUR_KERN:=5x5gaussian}"
: "${SCENE_BLUR_STRENGTH:=10}"
: "${SCENE_BLUR_PASSES:=3}"
: "${SCENE_BLUR_RADIUS:=5}"
: "${SCENE_BLUR_NOISE:=0.02}"
# swayfx spells the same two effects differently from picom, so the Wayland twin
# reads these three where the X path reads SCENE_SHADOW_RADIUS/OPACITY.
: "${SCENE_BLUR_BRIGHTNESS:=1.02}"
: "${SCENE_SHADOW_BLUR:=44}"
: "${SCENE_SHADOW_COLOR:=#00000099}"

# ─── Backdrop ───────────────────────────────────────────────────────────────
: "${SCENE_BACKDROP_BASE:=#1a1e26}"
: "${SCENE_BACKDROP_WARM:=#f8fafc}"
: "${SCENE_BACKDROP_COOL:=#a5c8ff}"
: "${SCENE_BACKDROP_BLUR:=26}"

# ─── Session ────────────────────────────────────────────────────────────────
: "${SCENE_CWD:=/sandbox/home/demo}"
: "${SCENE_SETTLE_SCALE:=1}"
: "${SCENE_GIF:=1}"
: "${SCENE_GIF_FPS:=20}"
: "${SCENE_GIF_WIDTH:=1200}"
: "${SCENE_SETTINGS:=}"
: "${SCENE_SIGNING_NUMBER:=}"
: "${SCENE_HIDE_THINKING:=}"
: "${SCENE_COMMAND:=bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b}"
: "${SCENE_HOLD:=120}"
: "${SCENE_TYPING_REPEAT:=off}"
: "${SCENE_MARK_LEAD_MIN_MS:=1200}"

# Wayland-only. The X twin has no equivalent: there is one Xvfb screen and one
# core pointer, and neither is named.
: "${SCENE_OUTPUT:=HEADLESS-1}"
: "${SCENE_SEAT:=seat0}"

# ─── Motion gate ────────────────────────────────────────────────────────────
: "${SCENE_MOTION_GATE:=1}"
: "${SCENE_MOTION_FLOOR:=12}"
: "${SCENE_MOTION_GATE_BIN:=/repo/proof/motion-gate.sh}"

# Every knob a session reads, in one list, so a recorder forwards the set rather
# than a hand-maintained copy of it. A knob added above and forwarded nowhere is
# the failure this replaces: the value existed, the container never saw it, and
# the take came out at the default with nothing saying so.
SCENE_ENV_VARS="
SCENE_WIDTH SCENE_HEIGHT SCENE_FONT_SIZE SCENE_FPS SCENE_TERMINAL SCENE_BG
SCENE_FG SCENE_PADDING SCENE_THEME SCENE_MARGIN SCENE_RADIUS SCENE_OPACITY
SCENE_SHADOW_RADIUS SCENE_SHADOW_OPACITY SCENE_SHADOW_OFFSET_X
SCENE_SHADOW_OFFSET_Y SCENE_CHROME SCENE_CHROME_BACKEND SCENE_CHROME_BLUR
SCENE_BLUR_KERN SCENE_BLUR_STRENGTH SCENE_BLUR_PASSES SCENE_BLUR_RADIUS
SCENE_BLUR_NOISE SCENE_BLUR_BRIGHTNESS SCENE_SHADOW_BLUR SCENE_SHADOW_COLOR
SCENE_BACKDROP_BASE SCENE_BACKDROP_WARM SCENE_BACKDROP_COOL
SCENE_BACKDROP_BLUR SCENE_CWD SCENE_SETTLE_SCALE SCENE_GIF SCENE_GIF_FPS
SCENE_GIF_WIDTH SCENE_SETTINGS
SCENE_SIGNING_NUMBER SCENE_HIDE_THINKING SCENE_COMMAND SCENE_MOTION_GATE
SCENE_MOTION_FLOOR SCENE_MOTION_GATE_BIN SCENE_OUTPUT SCENE_SEAT SCENE_HOLD SCENE_TYPING_REPEAT SCENE_MARK_LEAD_MIN_MS
"

# Exported, not merely set. A session writes a bootstrap script and hands it to a
# terminal, so a value that is only a shell variable in the session's own process
# does not reach the program the take is of.
# shellcheck disable=SC2086
export ${SCENE_ENV_VARS}

# Fills SCENE_DOCKER_ENV with the `-e NAME=value` pairs a recorder passes on.
scene_docker_env_args() {
	SCENE_DOCKER_ENV=()
	local name
	for name in ${SCENE_ENV_VARS}; do
		SCENE_DOCKER_ENV+=(-e "${name}=${!name}")
	done
}

# Fills SCENE_ENV_PAIRS with bare `NAME=value` pairs, for env(1) and setpriv(1),
# which take no -e. Same list, so the Wayland session hands the unprivileged user
# the identical set the container was given rather than a subset someone typed.
scene_env_pairs() {
	SCENE_ENV_PAIRS=()
	local name
	for name in ${SCENE_ENV_VARS}; do
		SCENE_ENV_PAIRS+=("${name}=${!name}")
	done
}

# The field the window sits on: neutral but NOT featureless, and that distinction
# is the whole frost. An earlier version blurred to 0x70, which is past the point
# where anything is left to blur, so the glass had nothing to refract and the
# treatment cost real work to look like flat opacity. Structure survives at 0x26
# -- two broad lights and one wide diagonal sheen -- while saturation stays under
# a tenth, so an edge catches a WHITE highlight rather than the violet-and-cyan
# rim that made an earlier take look like decoration competing with the terminal.
#
#   scene_backdrop <width> <height> <out.png>
scene_backdrop() {
	local w="$1" h="$2" out="$3"
	magick -size "${w}x${h}" xc:"${SCENE_BACKDROP_BASE}" \
		\( -size "${w}x${h}" radial-gradient:"${SCENE_BACKDROP_WARM}"-"#000000" \
		-resize 165% -gravity northwest -crop "${w}x${h}+0+0" -evaluate multiply 0.44 \) \
		-compose screen -composite \
		\( -size "${w}x${h}" radial-gradient:"${SCENE_BACKDROP_COOL}"-"#000000" \
		-resize 190% -gravity southeast -crop "${w}x${h}+0+0" -evaluate multiply 0.20 \) \
		-compose screen -composite \
		\( -size "${w}x${h}" gradient:"#ffffff"-"#000000" -rotate -28 \
		-gravity center -crop "${w}x${h}+0+0" -evaluate multiply 0.13 \) \
		-compose screen -composite \
		\( -size "${w}x${h}" gradient:"#00000000"-"#000000" -evaluate multiply 0.22 \) \
		-compose over -composite \
		-blur "0x${SCENE_BACKDROP_BLUR}" -modulate 100,55,100 "${out}"
}
