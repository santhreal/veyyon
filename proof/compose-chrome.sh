#!/usr/bin/env bash
# Draw the window chrome after the take instead of during it.
#
#   compose-chrome.sh <input.mp4|input.png> <output>
#
# WHY THIS IS NOT DONE WHILE RECORDING. The backdrop does not move. It is drawn
# once from a fixed recipe and is the same picture for the length of a take, so a
# compositor blending it under the window every frame recomputes one image
# thousands of times. That cost is not theoretical: measured in the recorder
# image at 2560x1440, with picom's blur on, ffmpeg could GRAB only 69 of 360
# frames, because the X server had nothing left to answer a screen capture with.
# Opacity alone, without blur, still cost a third of the frame rate. Removing the
# compositor from the capture path took the same scene to 240 unique frames of
# 240 grabbed.
#
# WHAT THIS DOES NOT DO. It cannot recover a frame the capture never drew. It is
# a cosmetic pass over frames that already exist, so a take that stuttered while
# it was recorded still stutters after it, and proof/motion-gate.sh is what says
# so. Compositing afterwards buys the frames back at capture time; it does not
# repair a capture that was already starved.
#
# WHAT THE INPUT LOOKS LIKE. The full canvas, with the backdrop already behind the
# terminal, because xwallpaper sets a root pixmap and costs nothing per frame. The
# terminal sits inset by SCENE_MARGIN with square corners and no transparency.
# This pass replaces that rectangle with the same pixels rounded, made
# translucent over a freshly drawn backdrop, and given a shadow.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=proof/docker/scene-config.sh
source "${REPO_ROOT}/proof/docker/scene-config.sh"

IN="${1:?usage: compose-chrome.sh <input.mp4|input.png> <output>}"
OUT="${2:?usage: compose-chrome.sh <input.mp4|input.png> <output>}"

# A missing binary must name itself. Left to the shell this exits 127 from inside
# a filter pipeline, which reads as a broken take rather than a missing package.
for bin in ffmpeg ffprobe magick; do
	command -v "${bin}" >/dev/null 2>&1 || {
		echo "compose-chrome.sh: ${bin} is not installed; the chrome pass needs it" >&2
		exit 1
	}
done
[ -s "${IN}" ] || {
	echo "compose-chrome.sh: '${IN}' is missing or empty" >&2
	exit 1
}

W="${SCENE_WIDTH}"
H="${SCENE_HEIGHT}"
MARGIN="${SCENE_MARGIN}"
TW=$((W - 2 * MARGIN))
TH=$((H - 2 * MARGIN))

GOT="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height \
	-of csv=s=x:p=0 "${IN}" 2>/dev/null || true)"
[ "${GOT}" = "${W}x${H}" ] || {
	echo "compose-chrome.sh: '${IN}' is ${GOT:-unreadable}, expected ${W}x${H}. Rescaling here would publish a soft take, so this refuses instead." >&2
	exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

scene_backdrop "${W}" "${H}" "${WORK}/backdrop.png"

# The rounding mask, once. Applied per frame by ffmpeg, never by ImageMagick.
magick -size "${TW}x${TH}" xc:black -fill white \
	-draw "roundrectangle 0,0 $((TW - 1)),$((TH - 1)) ${SCENE_RADIUS},${SCENE_RADIUS}" \
	-alpha off "${WORK}/mask.png"

# The shadow is a full-canvas layer so the offset is baked into where it is drawn
# rather than applied as an overlay coordinate, which keeps a negative offset from
# needing a negative position ffmpeg would clamp to zero.
SX=$((MARGIN + SCENE_SHADOW_OFFSET_X))
SY=$((MARGIN + SCENE_SHADOW_OFFSET_Y))
magick -size "${W}x${H}" xc:none -fill black \
	-draw "roundrectangle ${SX},${SY} $((SX + TW - 1)),$((SY + TH - 1)) ${SCENE_RADIUS},${SCENE_RADIUS}" \
	-blur "0x${SCENE_SHADOW_RADIUS}" \
	-channel A -evaluate multiply "${SCENE_SHADOW_OPACITY}" +channel \
	"${WORK}/shadow.png"

# The backdrop and the shadow never change and neither depends on the take, so
# they are flattened into one still here rather than overlaid per frame.
magick "${WORK}/backdrop.png" "${WORK}/shadow.png" -compose over -composite "${WORK}/bg.png"

# bg <- rounded translucent terminal, which is the order picom drew them in.
#
# EVERY framesync filter in this graph needs shortest=1, and leaving it off one of
# them is why an earlier version never terminated. The stills are `-loop 1`
# inputs, so they are infinite streams; a framesync filter ends when ALL its
# inputs end unless told otherwise, so `alphamerge` fed an infinite mask outlives
# the take even though the take is what carries the picture. `-shortest` does not
# save it: with a filtergraph that option governs muxing, not the graph, and the
# encoder runs until the disk fills. Measured: 90s of encoding on a 1s input
# before, 1.3s after.
GRAPH="[0:v]crop=${TW}:${TH}:${MARGIN}:${MARGIN},format=rgba[t];\
[2:v]format=gray[m];\
[t][m]alphamerge=shortest=1,colorchannelmixer=aa=${SCENE_OPACITY}[ta];\
[1:v][ta]overlay=${MARGIN}:${MARGIN}:format=auto:shortest=1[o]"

case "${IN,,}" in
*.png)
	magick "${IN}" -crop "${TW}x${TH}+${MARGIN}+${MARGIN}" +repage \
		"${WORK}/mask.png" -alpha off -compose CopyOpacity -composite \
		-channel A -evaluate multiply "${SCENE_OPACITY}" +channel "${WORK}/term.png"
	magick "${WORK}/bg.png" "${WORK}/term.png" \
		-geometry "+${MARGIN}+${MARGIN}" -compose over -composite "${OUT}"
	;;
*.mp4 | *.mkv | *.mov)
	# The take's own rate, read rather than assumed: a hardcoded rate here would
	# resample a capture silently and the header would still look right.
	RATE="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate \
		-of csv=p=0 "${IN}" 2>/dev/null || true)"
	[ -n "${RATE}" ] && [ "${RATE}" != "0/0" ] || {
		echo "compose-chrome.sh: '${IN}' declares no frame rate" >&2
		exit 1
	}
	ffmpeg -loglevel error -y -i "${IN}" \
		-loop 1 -i "${WORK}/bg.png" \
		-loop 1 -i "${WORK}/mask.png" \
		-filter_complex "${GRAPH}" -map "[o]" \
		-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r "${RATE}" \
		"${OUT}"
	;;
*)
	echo "compose-chrome.sh: '${IN##*.}' is not a format this pass knows; give it a png, mp4, mkv or mov" >&2
	exit 1
	;;
esac

echo "chrome: composited ${IN##*/} -> ${OUT##*/} at ${W}x${H}, radius ${SCENE_RADIUS}, opacity ${SCENE_OPACITY}" >&2
