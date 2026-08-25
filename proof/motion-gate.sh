#!/usr/bin/env bash
# Judge a capture on motion.
#
#   motion-gate.sh <video> [floor-fps]
#
# A take can be a true 60 fps CFR file, encode without dropping a frame, and
# still be three frames a second of actual movement, because the frames were
# never drawn. ffprobe cannot see it: r_frame_rate reads 60/1 and nb_frames
# reads 7415 on exactly such a take. The only number that corresponds to what a
# viewer calls smooth is how often the picture changed.
#
# mpdecimate drops every frame identical to the one before it, so the surviving
# count is the number of moments the screen actually changed. Divided by the
# duration that is motion fps.
#
# Prints one line of measurement and exits non-zero below the floor. The floor
# is deliberately far under the capture rate: this catches a stuttering
# pipeline, not a quiet scene.
set -euo pipefail

VIDEO="${1:?usage: motion-gate.sh <video> [floor-fps]}"
FLOOR="${2:-${SCENE_MOTION_FLOOR:-12}}"

[ -s "${VIDEO}" ] || {
	echo "motion: ${VIDEO} is missing or empty" >&2
	exit 1
}

# Without these the gate cannot answer, and `set -e` would exit 127 — which a
# caller reads as "the gate ran and something odd happened" rather than "nothing
# was measured". An unmeasured take must never look like a passing one.
for tool in ffmpeg ffprobe; do
	command -v "${tool}" >/dev/null 2>&1 || {
		echo "motion: ${tool} is not installed; the take cannot be measured" >&2
		exit 1
	}
done

# `|| true` so a probe that rejects the file leaves an EMPTY result for the check
# below to judge, instead of aborting here under `set -e`. Without it the exit
# code is the probe's and the branch below is unreachable — the gate still fails,
# but for a reason it never states, and the test that claims to cover the
# unmeasurable case passes without ever entering it.
DURATION="$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${VIDEO}" 2>/dev/null | cut -d. -f1 || true)"
UNIQUE="$(ffmpeg -i "${VIDEO}" -vf mpdecimate=hi=64*12:lo=64*5:frac=0.001 \
	-loglevel info -f null - 2>&1 | tail -1 | sed -n 's/^frame=[ ]*\([0-9]*\).*/\1/p' || true)"

# One place decides that a take was not measured, and it fails closed.
if [ -z "${DURATION}" ] || [ -z "${UNIQUE}" ] || ! [ "${DURATION}" -gt 0 ] 2>/dev/null; then
	echo "motion: could not measure ${VIDEO}; refusing to call it good" >&2
	exit 1
fi

FPS=$((UNIQUE / DURATION))
echo "motion: ${UNIQUE} unique frames over ${DURATION}s = ${FPS} fps of real change (floor ${FLOOR})"

if [ "${FPS}" -lt "${FLOOR}" ]; then
	cat >&2 <<-MSG
		motion: THE CAPTURE IS STUTTERING. ${FPS} fps of change is below the ${FLOOR} fps floor.
		motion: a compositor doing a CPU blur is the usual cause. A translucent window makes
		motion: picom re-blur everything behind it every frame; measured in the recorder image
		motion: at 2560x1440 that drops a capture from 49 fps of change to 2, and starves the X
		motion: server so hard that ffmpeg can only grab 69 of 360 frames. SCENE_CHROME_BLUR=1
		motion: turns that blur on and belongs only on a still.
		motion: set SCENE_MOTION_FLOOR to accept a deliberately still take.
	MSG
	exit 1
fi
