#!/usr/bin/env bash
# Run one scene on a private X display and record it as video.
#
#   xsession.sh <scene.sh>
#
# Started inside the recording container by record-x11.sh. Xvfb gives the
# container its own display, kitty is a real terminal emulator that speaks SGR
# 1006 mouse reporting, xdotool moves a real pointer over it, and ffmpeg records
# the display continuously, so an animation is captured as motion rather than as
# a frame every few seconds.
set -euo pipefail

SCENE="${1:?usage: xsession.sh <scene.sh>}"
NAME="$(basename "${SCENE}" .sh)"
export DISPLAY="${DISPLAY:-:99}"
W="${SCENE_WIDTH:-1600}"
H="${SCENE_HEIGHT:-1000}"
FPS="${SCENE_FPS:-30}"
OUT="/out"
mkdir -p "${OUT}"

Xvfb "${DISPLAY}" -screen 0 "${W}x${H}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 50); do
	xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
	sleep 0.2
done
xdpyinfo -display "${DISPLAY}" >/dev/null

# The terminal answers CSI 16t with its cell size in pixels and CSI 18t with its
# size in cells. Asking it beats guessing from font metrics, and the scene needs
# both to aim the pointer at a row and column.
cat >/tmp/bootstrap.sh <<'BOOT'
#!/usr/bin/env bash
exec 2>/tmp/boot.err
# xterm does not hand COLORTERM to its child, so the app under test resolved
# terminal id "base" and turned every truecolor-gated surface off -- including
# the overlay unfold, which is one of the things these recordings exist to show.
# The terminal is started with directColor, so declaring it here is a statement
# of what the emulator does, not a widening of it.
export COLORTERM=truecolor
printf 'stty=%s\n' "$(stty size </dev/tty)" >/tmp/geom
cd "${SCENE_CWD:-/sandbox/home/demo}"
exec ${SCENE_COMMAND:?}
BOOT
chmod +x /tmp/bootstrap.sh

case "${SCENE_TERMINAL:-kitty}" in
xterm)
	# xterm answers XTEST motion with SGR 1006 reports without a window manager,
	# which is the whole point of this path. directColor keeps 24-bit colour.
	xterm \
		-geometry "$((W / 12))x$((H / 27))+0+0" \
		-fa "JetBrains Mono" -fs "${SCENE_FONT_SIZE:-15}" \
		-bg "#1e2127" -fg "#d7dae0" \
		-b "${SCENE_PADDING:-8}" \
		-u8 \
		-xrm "XTerm*locale: true" \
		-xrm "XTerm*utf8: 2" \
		-xrm "XTerm*directColor: true" \
		-xrm "XTerm*saveLines: 20000" \
		-e /tmp/bootstrap.sh >/tmp/term.log 2>&1 &
	;;
*)
	kitty \
		--override "font_family=JetBrains Mono" \
		--override "font_size=${SCENE_FONT_SIZE:-15}" \
		--override "background=#1e2127" \
		--override "foreground=#d7dae0" \
		--override "cursor_blink_interval=0" \
		--override "window_padding_width=${SCENE_PADDING:-8}" \
		--override "remember_window_size=no" \
		--override "initial_window_width=${W}" \
		--override "initial_window_height=${H}" \
		--override "hide_window_decorations=yes" \
		--override "confirm_os_window_close=0" \
		--override "scrollback_lines=20000" \
		--override "enable_audio_bell=no" \
		--override "focus_follows_mouse=yes" \
		/tmp/bootstrap.sh >/tmp/term.log 2>&1 &
	;;
esac
KITTY_PID=$!

for _ in $(seq 1 100); do
	xdotool search --class "kitty|XTerm" >/dev/null 2>&1 && break
	sleep 0.2
done
WINDOW="$(xdotool search --class "kitty|XTerm" | head -1)"
xdotool windowmove "${WINDOW}" 0 0 || true
xdotool windowsize "${WINDOW}" "${W}" "${H}" || true
xdotool windowactivate "${WINDOW}" 2>/dev/null || true
# No window manager runs here, so _NET_ACTIVE_WINDOW is unavailable and
# windowactivate fails. XSetInputFocus is what actually gives kitty the focus
# it needs before it will report a pointer at all.
for _ in $(seq 1 50); do
	xwininfo -id "${WINDOW}" 2>/dev/null | grep -q "IsViewable" && break
	sleep 0.2
done
for _ in $(seq 1 25); do
	xdotool windowfocus --sync "${WINDOW}" 2>/dev/null && break
	sleep 0.2
done
xdotool mousemove --sync $((W / 2)) $((H / 2))
sleep 1

ffmpeg -loglevel error -y -f x11grab -draw_mouse 1 -framerate "${FPS}" \
	-video_size "${W}x${H}" -i "${DISPLAY}" \
	-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
	"${OUT}/${NAME}.mp4" >/tmp/ffmpeg.log 2>&1 &
FFMPEG_PID=$!

cleanup() {
	kill -INT "${FFMPEG_PID}" 2>/dev/null || true
	wait "${FFMPEG_PID}" 2>/dev/null || true
	kill "${KITTY_PID}" 2>/dev/null || true
	kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

export SCENE_NAME="${NAME}"
export SCENE_WINDOW="${WINDOW}"
export SCENE_OUT="${OUT}"
# shellcheck disable=SC1090
source "${SCENE_LIB:-/repo/proof/scenes/lib.sh}"
# shellcheck disable=SC1090
source "${SCENE}"

sleep 1
cleanup
trap - EXIT

# A GIF of the same recording, for a page that has to open in a browser without
# a video codec argument. The palette pass is what keeps the terminal's greys
# from banding.
ffmpeg -loglevel error -y -i "${OUT}/${NAME}.mp4" \
	-vf "fps=${SCENE_GIF_FPS:-20},scale=${SCENE_GIF_WIDTH:-1200}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
	"${OUT}/${NAME}.gif"
ls -la "${OUT}/${NAME}.mp4" "${OUT}/${NAME}.gif"
