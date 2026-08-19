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

# COMPOSITE and RENDER are what a compositor needs; Xvfb offers them only when
# they are asked for, and picom without them starts, stays alive, and never
# claims the manager selection, which reads exactly like a theme that did not
# apply.
Xvfb "${DISPLAY}" -screen 0 "${W}x${H}x24" -nolisten tcp \
	+extension COMPOSITE +extension RENDER +extension DAMAGE \
	>/tmp/xvfb.log 2>&1 &
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

# A themed capture: a lit backdrop behind the window, a compositor to round its
# corners, blur what shows through it and cast a shadow, and an inset window so
# all of that is visible. `plain` keeps the flat full-screen capture every
# existing scene was recorded against, so a scene that says nothing about a theme
# records exactly the bytes it did before.
#
# The backdrop is generated rather than shipped: an image in the tree would be a
# binary blob nobody can diff, and two lights over a near-black base is what the
# look needs anyway. A flat gradient behind an opaque window is a rim of colour
# and nothing else; a tight light in one corner and a colder one in the opposite
# corner puts the colour where the window edge crosses it, which is the whole
# effect.
#
# Translucency here is the COMPOSITOR's, not the client's. kitty cannot do it on
# this display and the reason is worth keeping: Xvfb offers depth-32 visuals,
# picom redirects the screen, and kitty still logs "Failed to enable
# transparency", because the GLX configs this display exposes carry no alpha
# channel, so the terminal cannot pick an ARGB visual to blend into. Window
# opacity is applied by picom to a window that knows nothing about it, needs no
# alpha from the client, and blends the same way -- as do the rounding, the blur
# and the shadow.
MARGIN=0
if [ "${SCENE_THEME:-plain}" != "plain" ]; then
	MARGIN="${SCENE_MARGIN:-96}"
	magick -size "${W}x${H}" xc:"${SCENE_BACKDROP_BASE:-#0b0b12}" \
		\( -size "${W}x${H}" radial-gradient:"${SCENE_BACKDROP_WARM:-#7c3aed}"-"#000000" \
		-resize 130% -gravity northwest -crop "${W}x${H}+0+0" -evaluate multiply 0.75 \) \
		-compose screen -composite \
		\( -size "${W}x${H}" radial-gradient:"${SCENE_BACKDROP_COOL:-#06b6d4}"-"#000000" \
		-resize 150% -gravity southeast -crop "${W}x${H}+0+0" -evaluate multiply 0.6 \) \
		-compose screen -composite \
		-blur 0x45 /tmp/backdrop.png
	xwallpaper --stretch /tmp/backdrop.png >/tmp/wallpaper.log 2>&1 || true
	# xrender, not glx: this display has no accelerated GL, and glx fails at
	# backend init rather than degrading. kernel is the one blur method xrender
	# implements; the others are backend-gated and picom refuses to start on them.
	picom --backend xrender --no-fading-openclose --config /dev/null \
		--corner-radius "${SCENE_RADIUS:-22}" \
		--active-opacity "${SCENE_OPACITY:-0.92}" \
		--inactive-opacity "${SCENE_OPACITY:-0.92}" \
		--blur-background --blur-method kernel --blur-kern "11x11gaussian" \
		--shadow --shadow-radius 36 --shadow-opacity 0.6 \
		--shadow-offset-x -18 --shadow-offset-y -10 \
		--log-level=debug --log-file=/tmp/picom.log >/tmp/picom.out 2>&1 &
	PICOM_PID=$!
	# `xprop -root _NET_WM_CM_S0` cannot answer this: the compositing manager owns
	# a SELECTION, not a root property, and xprop exits 0 while printing "not
	# found". Waiting on that exit code is no wait at all, which is how the
	# terminal came up before the compositor. "Screen redirected." is picom's own
	# statement that it is now drawing the screen, and it is the fact the rounding
	# and the shadow depend on.
	COMPOSITED=0
	for _ in $(seq 1 100); do
		if grep -q "Screen redirected" /tmp/picom.log 2>/dev/null; then
			COMPOSITED=1
			break
		fi
		kill -0 "${PICOM_PID}" 2>/dev/null || break
		sleep 0.2
	done
	[ "${COMPOSITED}" = "1" ] || {
		echo "picom never redirected the screen; the capture would be unthemed" >&2
		tail -20 /tmp/picom.log /tmp/picom.out >&2 2>/dev/null
		exit 1
	}
fi

# The terminal is sized to the inset once and never resized, because the grid the
# scene aims at comes from `stty size` inside the shell the terminal started.
TW=$((W - 2 * MARGIN))
TH=$((H - 2 * MARGIN))

case "${SCENE_TERMINAL:-kitty}" in
xterm)
	# xterm answers XTEST motion with SGR 1006 reports without a window manager,
	# which is the whole point of this path. directColor keeps 24-bit colour.
	xterm \
		-geometry "$((TW / 12))x$((TH / 27))+${MARGIN}+${MARGIN}" \
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
		--override "background=${SCENE_BG:-#1e2127}" \
		--override "foreground=${SCENE_FG:-#d7dae0}" \
		--override "cursor_blink_interval=0" \
		--override "window_padding_width=${SCENE_PADDING:-8}" \
		--override "remember_window_size=no" \
		--override "initial_window_width=${TW}" \
		--override "initial_window_height=${TH}" \
		--override "hide_window_decorations=yes" \
		--override "confirm_os_window_close=0" \
		--override "scrollback_lines=20000" \
		--override "enable_audio_bell=no" \
		--override "focus_follows_mouse=yes" \
		/tmp/bootstrap.sh >/tmp/term.log 2>&1 &
	;;
esac
KITTY_PID=$!

# Wait for a window that can actually be configured, not for the first id the
# search returns. kitty creates and destroys a window before the one it keeps, and
# taking the first id raced it: `windowmove` and `getwindowgeometry` both failed
# with BadWindow on 0x600007, the inset never applied, and the scene helpers read
# an origin of 0,0 -- a themed capture that silently came out full-screen. A
# geometry query is the fact this depends on, so that is what it waits for.
WINDOW=""
for _ in $(seq 1 100); do
	for candidate in $(xdotool search --class "kitty|XTerm" 2>/dev/null); do
		if xdotool getwindowgeometry "${candidate}" 2>/dev/null | grep -qE "Geometry: [1-9][0-9]*x[1-9]"; then
			WINDOW="${candidate}"
		fi
	done
	[ -n "${WINDOW}" ] && break
	sleep 0.2
done
: "${WINDOW:?no terminal window with a geometry appeared}"
xdotool windowmove "${WINDOW}" "${MARGIN}" "${MARGIN}" || true
xdotool windowsize "${WINDOW}" "${TW}" "${TH}" || true
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
xdotool mousemove --sync $((MARGIN + TW / 2)) $((MARGIN + TH / 2))
sleep 1

ffmpeg -loglevel error -y -f x11grab -draw_mouse 1 -framerate "${FPS}" \
	-video_size "${W}x${H}" -i "${DISPLAY}" \
	-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
	"${OUT}/${NAME}.mp4" >/tmp/ffmpeg.log 2>&1 &
FFMPEG_PID=$!
# The recording's own zero, in milliseconds, so a still can name the second of the
# video it belongs to. ffmpeg's first frame lands a moment after the fork, and that
# moment is smaller than the lead a cut keeps around a mark.
rm -f "${OUT}/${NAME}-marks.tsv"
export SCENE_T0="$(date +%s%3N)"

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

# A GIF of the same recording, for a page that has to open in a browser without a
# video codec argument. The palette pass is what keeps the terminal's greys from
# banding.
#
# Off for a long take. A 22-minute 1920x1080 session is a two-frame-per-second GIF
# of several gigabytes that nothing will ever open, and the encode of one took the
# whole container down with it after the recording had already succeeded: the take
# was on disk and the run still reported failure. A caller that publishes a WebP
# and an mp4 does not need it.
if [ "${SCENE_GIF:-1}" = "1" ]; then
	ffmpeg -loglevel error -y -i "${OUT}/${NAME}.mp4" \
		-vf "fps=${SCENE_GIF_FPS:-20},scale=${SCENE_GIF_WIDTH:-1200}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
		"${OUT}/${NAME}.gif"
fi
ls -la "${OUT}/${NAME}.mp4"
