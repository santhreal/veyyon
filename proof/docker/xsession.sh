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
# Every SCENE_* knob has one definition, in scene-config.sh. This file reads it
# rather than restating a default, because a default written down in two files is
# two defaults and the one a run gets depends on which file it entered through.
# shellcheck source=proof/docker/scene-config.sh
source /repo/proof/docker/scene-config.sh
W="${SCENE_WIDTH}"
H="${SCENE_HEIGHT}"
FPS="${SCENE_FPS}"
OUT="/out"
mkdir -p "${OUT}"

# kitty/glfw refuse to open a window without a machine-id. Some recorder images
# ship without /etc/machine-id, and the first thing the operator sees is
# "no terminal window with a geometry appeared" plus a dbus error in the log.
if [ ! -s /etc/machine-id ]; then
	if command -v dbus-uuidgen >/dev/null 2>&1; then
		dbus-uuidgen --ensure
	else
		head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' >/etc/machine-id
		mkdir -p /var/lib/dbus
		cp /etc/machine-id /var/lib/dbus/machine-id
	fi
fi

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

# Session bus after the display exists. dbus-launch (which kitty/glfw will
# spawn if this is missing) dies without $DISPLAY, and the window never appears.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "${XDG_RUNTIME_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}" || true
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v dbus-daemon >/dev/null 2>&1; then
	bus="${XDG_RUNTIME_DIR}/bus"
	rm -f "${bus}"
	dbus-daemon --session --address="unix:path=${bus}" --fork
	export DBUS_SESSION_BUS_ADDRESS="unix:path=${bus}"
fi

# AUTOREPEAT IS WHY TYPED COMMANDS DOUBLED THEIR CHARACTERS. xdotool synthesises a
# press and a release per character; when the client is repainting hard -- the composer
# re-renders the whole prompt plus a completion popup on every keystroke -- the release
# is processed late, X decides the key is being held, and repeats it. The recording that
# found this composed "//seccrret frroomm-env RELEASE_SIGNATURE" from a clean submit and
# lost its signing segment. Slowing the typing only lengthens the window; turning
# repeat off removes the mechanism, and nothing in a scene needs a held key.
xset -display "${DISPLAY}" r off || {
	echo "xset could not turn autorepeat off; typed commands would double characters" >&2
	exit 1
}
# Asked twice, because the two switches are not the same switch: `r off` clears the
# core-protocol global flag, and XKB carries its own per-key repeat state that a
# client can put back. A repeat interval longer than any take makes the second one
# unreachable even if something re-enables the first.
xset -display "${DISPLAY}" r rate 60000 60000 >/dev/null 2>&1 || true

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
# One number in the environment, for a scene that stores a credential with
# `/secret from-env` and then asks the model to sign with the placeholder. It is exported
# here rather than typed in the session, which is the point: a credential that reaches the
# vault through the environment never appears in the transcript at all, so what the
# recording shows spending is a placeholder and nothing else.
export RELEASE_SIGNATURE="${SCENE_SIGNING_NUMBER}"
printf 'stty=%s\n' "$(stty size </dev/tty)" >/tmp/geom
cd "${SCENE_CWD}"
exec ${SCENE_COMMAND:?}
BOOT
chmod +x /tmp/bootstrap.sh

# A themed capture: a neutral backdrop behind the window, a compositor to round its
# corners, frost what shows through it and cast a shadow, and an inset window so all of
# that is visible. `plain` keeps the flat full-screen capture every existing scene was
# recorded against, so a scene that says nothing about a theme records exactly the bytes
# it did before.
#
# The backdrop is generated rather than shipped: an image in the tree would be a binary
# blob nobody can diff.
#
# It is deliberately colourless. An earlier version lit it with a violet light in one
# corner and a cyan one in the other, which put a saturated rainbow rim along every
# window edge and read as decoration competing with the terminal. Frosted glass is not a
# colour effect: the window edge has to catch a WHITE highlight, and everything the blur
# picks up behind it has to be near-neutral, or the frost tints and the illusion dies.
MARGIN=0
if [ "${SCENE_THEME}" != "plain" ]; then
	MARGIN="${SCENE_MARGIN}"
	# The recipe and the reasoning behind it live in scene-config.sh, which both
	# display servers read, so the X take and the Wayland take cannot drift into two
	# different pictures. xwallpaper sets a root pixmap, which is drawn once and
	# costs nothing per frame, so the backdrop is in the capture even when no
	# compositor is running.
	scene_backdrop "${W}" "${H}" /tmp/backdrop.png
	xwallpaper --stretch /tmp/backdrop.png >/tmp/wallpaper.log 2>&1 || true

	# `xprop -root _NET_WM_CM_S0` cannot answer whether this worked: the compositing manager
	# owns a SELECTION, not a root property, and xprop exits 0 while printing "not found".
	# Waiting on that exit code is no wait at all, which is how the terminal once came up
	# before the compositor. "Screen redirected." is picom's own statement that it is drawing
	# the screen, and it is the fact the rounding, the frost and the shadow depend on.
	start_compositor() {
		local label="$1"
		shift
		: >/tmp/picom.log
		picom "$@" --log-level=debug --log-file=/tmp/picom.log >/tmp/picom.out 2>&1 &
		PICOM_PID=$!
		for _ in $(seq 1 100); do
			if grep -q "Screen redirected" /tmp/picom.log 2>/dev/null; then
				echo "chrome: ${label} redirected the screen" >&2
				return 0
			fi
			kill -0 "${PICOM_PID}" 2>/dev/null || break
			sleep 0.2
		done
		kill "${PICOM_PID}" 2>/dev/null || true
		wait "${PICOM_PID}" 2>/dev/null || true
		echo "chrome: ${label} never redirected the screen" >&2
		tail -5 /tmp/picom.log /tmp/picom.out >&2 2>/dev/null || true
		return 1
	}

	# Translucency here is the COMPOSITOR's, not the client's. kitty cannot do it on this
	# display and the reason is worth keeping: Xvfb offers depth-32 visuals, picom redirects
	# the screen, and kitty still logs "Failed to enable transparency", because the GLX configs
	# this display exposes carry no alpha channel, so the terminal cannot pick an ARGB visual to
	# blend into. picom's window opacity needs nothing from the client, and neither do the
	# rounding, the frost and the shadow.
	CHROME=(--no-fading-openclose --config /dev/null
		--corner-radius "${SCENE_RADIUS}"
		--active-opacity "${SCENE_OPACITY}"
		--inactive-opacity "${SCENE_OPACITY}"
		--shadow --shadow-radius "${SCENE_SHADOW_RADIUS}" --shadow-opacity "${SCENE_SHADOW_OPACITY}"
		--shadow-offset-x "${SCENE_SHADOW_OFFSET_X}" --shadow-offset-y "${SCENE_SHADOW_OFFSET_Y}")

	# --blur-background IS THE REASON A TAKE COMES OUT AT THREE FRAMES A SECOND, and it
	# stays off unless something can actually accelerate it.
	#
	# A translucent window forces picom to re-blur everything behind it on every frame.
	# On this stack that convolution runs on the CPU through xrender, over the whole
	# 2304x1184 inset, and it saturates the X server itself. Measured in the recorder
	# image at 2560x1440, one identical counter printing as fast as the terminal will
	# take it, six seconds per arm, unique frames counted with mpdecimate:
	#
	#   no compositor                     171 unique / 359 grabbed   28 fps
	#   opaque + blur                      89 unique / 337 grabbed   14 fps
	#   0.72 opacity, no blur              69 unique / 305 grabbed   11 fps
	#   0.72 opacity + blur (was default)  14 unique /  69 grabbed    2 fps
	#   blur-background-fixed              13 unique /  55 grabbed    2 fps
	#
	# The middle column is the tell that this is not a terminal problem and not an
	# encoder problem: with the blur on, ffmpeg could only GRAB 69 of 360 frames. The X
	# server had nothing left to answer a screen capture with, so no capture setting and
	# no render-loop change downstream can recover the frames -- they were never drawn.
	# A published hero take measured 385 unique frames across 7415, a flat 3.3 per second
	# through typing, streaming and idle alike, which is this row and nothing else.
	#
	# AND IT CHANGES NOTHING ON SCREEN, which is what makes this a deletion rather
	# than a trade. The backdrop is generated once, never moves, and is already
	# blurred at 0x26, so what the runtime pass convolves every frame is a constant
	# smooth gradient -- and a blur of a smooth gradient returns the same smooth
	# gradient. Captured as a still through .internal/frost-ab.sh, identical geometry
	# and identical terminal contents, the blurred and unblurred arms differ by an
	# RMSE of 0.001 of 255. Zero point zero zero percent. The frost, the rounding,
	# the shadow and the edge highlight all survive it, because they come from
	# --active-opacity, --corner-radius and --shadow, none of which is a blur.
	#
	# So the row above is not "the expensive look": it is 8 to 20 times the frame
	# rate spent on an image difference no viewer can see.
	#
	# SCENE_CHROME_BLUR=1 exists only so the claim above stays falsifiable -- set it,
	# capture the pair, and look. It is not a quality knob.
	if [ "${SCENE_CHROME_BLUR}" = "1" ]; then
		CHROME+=(--blur-background)
		echo "chrome: blur-background forced on; expect ~2 fps of real motion" >&2
	fi

	# xrender's `kernel` blur is the default, and dual_kawase is opt-in behind
	# SCENE_CHROME_BACKEND=glx. The reasoning in the note this replaces was wrong in both
	# directions, so both halves are worth writing down.
	#
	# It said this display has no accelerated GL and that picom's glx backend therefore fails at
	# backend init. There is indeed no acceleration -- glxinfo answers llvmpipe -- but picom does
	# not need acceleration, it needs a GL context, and it gets one: on glx it logs `Screen
	# redirected.` and runs dual_kawase, a multi-pass blur with a strength knob rather than a
	# fixed 11-pixel kernel. So the stated reason for avoiding glx was false.
	#
	# The conclusion was still right. Recorded as a frame pair through proof/scenes/chrome-probe.sh
	# at 2560x1440, the glx arm captures a window with NO CONTENTS: the rounded rectangle, the
	# shadow and a grey smear where the terminal grid should be, while the xrender arm captures the
	# session. picom composites the backdrop and drops the window's own pixels on this GL stack.
	# Nothing in picom's log says so -- it reports the same successful redirect on both arms --
	# which is why the pin below exists and why the backend is judged on pixels, never on a flag.
	#
	# glx stays reachable rather than deleted, because passing a real GPU to this container is the
	# obvious next thing to try and the pin is how the next arm gets recorded. Anyone who sets it
	# must look at the frame: a blank window is the expected failure, and it is invisible in a log.
	# WHERE THE CHROME IS DRAWN. `post` is the default and runs no compositor at
	# all: the rounding, the shadow and the opacity are applied to the recorded
	# frames by proof/compose-chrome.sh once the take is over. The backdrop is
	# already in the capture, because xwallpaper set it as a root pixmap above.
	#
	# Compositing live is what starved the capture. With the blur on, ffmpeg could
	# GRAB only 69 of 360 frames; with opacity alone it lost a third of them. The
	# backdrop never moves, so blending it under the window thirty times a second
	# recomputes one static picture for the length of the take. `live` stays
	# reachable so the comparison can be re-run, and because the Wayland twin still
	# composites in its compositor.
	if [ "${SCENE_CHROME}" != "live" ]; then
		echo "chrome: none at capture time; composited after the take" >&2
	else
		if [ "${SCENE_CHROME_BACKEND}" = "glx" ]; then
			start_compositor "glx dual_kawase strength ${SCENE_BLUR_STRENGTH}" \
				--backend glx --blur-method dual_kawase --blur-strength "${SCENE_BLUR_STRENGTH}" \
				"${CHROME[@]}" && GLASS=1
		fi
		[ "${GLASS:-0}" = "1" ] ||
			start_compositor "xrender kernel ${SCENE_BLUR_KERN}" \
				--backend xrender --blur-method kernel --blur-kern "${SCENE_BLUR_KERN}" \
				"${CHROME[@]}" || {
				echo "picom never redirected the screen; the capture would be unthemed" >&2
				exit 1
			}
	fi
fi

# The terminal is sized to the inset once and never resized, because the grid the
# scene aims at comes from `stty size` inside the shell the terminal started.
TW=$((W - 2 * MARGIN))
TH=$((H - 2 * MARGIN))

case "${SCENE_TERMINAL}" in
xterm)
	# xterm answers XTEST motion with SGR 1006 reports without a window manager,
	# which is the whole point of this path. directColor keeps 24-bit colour.
	xterm \
		-geometry "$((TW / 12))x$((TH / 27))+${MARGIN}+${MARGIN}" \
		-fa "JetBrains Mono" -fs "${SCENE_FONT_SIZE}" \
		-bg "${SCENE_BG}" -fg "${SCENE_FG}" \
		-b "${SCENE_PADDING}" \
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
		--override "font_size=${SCENE_FONT_SIZE}" \
		--override "sync_to_monitor=no" \
		--override "repaint_delay=8" \
		--override "input_delay=1" \
		--override "background=${SCENE_BG}" \
		--override "foreground=${SCENE_FG}" \
		--override "cursor_blink_interval=0" \
		--override "window_padding_width=${SCENE_PADDING}" \
		--override "remember_window_size=no" \
		--override "initial_window_width=${TW}" \
		--override "initial_window_height=${TH}" \
		--override "hide_window_decorations=yes" \
		--override "confirm_os_window_close=0" \
		--override "scrollback_lines=20000" \
		--override "enable_audio_bell=no" \
		--override "focus_follows_mouse=yes" \
		--override "allow_remote_control=socket-only" \
		--listen-on "unix:/tmp/kitty.sock" \
		/tmp/bootstrap.sh >/tmp/term.log 2>&1 &
	;;
esac
KITTY_PID=$!

# Wait for a window that can actually be configured, not for the first id the
# search returns, and then check that configuring it WORKED. kitty creates and
# destroys a window before the one it keeps, and taking the first id raced it:
# `windowmove` and `getwindowgeometry` both failed with BadWindow on 0x600007, the
# inset never applied, and the scene helpers read an origin of 0,0 -- a themed
# capture that silently came out full-screen. Waiting for a geometry was not enough
# on its own, because the doomed window has a geometry too: the second take of the
# language-server row lost thirteen minutes to a full-bleed slab with the backdrop
# nowhere on screen. So the placement is read back, retried against a freshly
# resolved id, and the run is aborted rather than recorded if the window will not
# sit where the theme needs it.
pick_window() {
	local found="" candidate
	for candidate in $(xdotool search --class "kitty|XTerm" 2>/dev/null); do
		if xdotool getwindowgeometry "${candidate}" 2>/dev/null | grep -qE "Geometry: [1-9][0-9]*x[1-9]"; then
			found="${candidate}"
		fi
	done
	printf '%s' "${found}"
}
window_origin() {
	xdotool getwindowgeometry "${1}" 2>/dev/null | sed -n 's/.*Position: \([0-9]*\),\([0-9]*\).*/\1 \2/p'
}

WINDOW=""
PLACED=0
for _ in $(seq 1 40); do
	WINDOW="$(pick_window)"
	[ -n "${WINDOW}" ] || {
		sleep 0.25
		continue
	}
	# A window that is about to be retired answers a geometry query and then stops
	# existing, so give it a moment to prove it is the one kitty keeps.
	sleep 0.4
	xdotool getwindowgeometry "${WINDOW}" >/dev/null 2>&1 || continue
	xdotool windowmove "${WINDOW}" "${MARGIN}" "${MARGIN}" 2>/dev/null || continue
	xdotool windowsize "${WINDOW}" "${TW}" "${TH}" 2>/dev/null || continue
	sleep 0.3
	read -r WX WY <<<"$(window_origin "${WINDOW}")"
	if [ "${WX:-}" = "${MARGIN}" ] && [ "${WY:-}" = "${MARGIN}" ]; then
		PLACED=1
		break
	fi
done
if [ -z "${WINDOW}" ]; then
	echo "no terminal window with a geometry appeared" >&2
	tail -40 /tmp/term.log >&2 2>/dev/null || true
	tail -40 /tmp/boot.err >&2 2>/dev/null || true
	exit 1
fi
[ "${PLACED}" = "1" ] || {
	echo "terminal window would not move to +${MARGIN}+${MARGIN} (last origin: ${WX:-none},${WY:-none})" >&2
	tail -20 /tmp/term.log >&2 2>/dev/null
	exit 1
}
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

ffmpeg -loglevel error -y -thread_queue_size 2048 -f x11grab -draw_mouse 1 -framerate "${FPS}" \
	-video_size "${W}x${H}" -i "${DISPLAY}" \
	-c:v libx264 -preset ultrafast -tune zerolatency -crf 18 -pix_fmt yuv420p \
	-r "${FPS}" \
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

# The chrome the capture deliberately did not draw. Applied to the video and to
# every still the scene took, so a frame published beside the clip is the same
# picture. The gate runs after this, on the file that actually ships.
if [ "${SCENE_CHROME}" != "live" ] && [ "${SCENE_THEME}" != "plain" ]; then
	# A composite that fails must not leave the take looking finished. The bare
	# capture is a real recording of a square-cornered terminal, so it plays, and a
	# silent skip would publish it as the themed one.
	bash /repo/proof/compose-chrome.sh "${OUT}/${NAME}.mp4" "${OUT}/${NAME}-chrome.mp4" || {
		echo "xsession.sh: the chrome pass failed; refusing to publish the bare capture as a themed take" >&2
		exit 1
	}
	mv -f "${OUT}/${NAME}-chrome.mp4" "${OUT}/${NAME}.mp4"
	for still in "${OUT}/${NAME}"-*.png; do
		[ -e "${still}" ] || continue
		bash /repo/proof/compose-chrome.sh "${still}" "${still%.png}-chrome.png" || {
			echo "xsession.sh: the chrome pass failed on ${still##*/}" >&2
			exit 1
		}
		mv -f "${still%.png}-chrome.png" "${still}"
	done
fi

# The capture is judged on motion, not on settings: a true 60 fps CFR file that
# encodes without dropping anything can still be three frames a second of actual
# movement, and ffprobe cannot tell the difference. proof/motion-gate.sh owns the
# measurement and the floor.
if [ "${SCENE_MOTION_GATE}" = "1" ]; then
	bash "${SCENE_MOTION_GATE_BIN}" "${OUT}/${NAME}.mp4" >&2
fi

# A GIF of the same recording, for a page that has to open in a browser without a
# video codec argument. The palette pass is what keeps the terminal's greys from
# banding.
#
# Off for a long take. A 22-minute 1920x1080 session is a two-frame-per-second GIF
# of several gigabytes that nothing will ever open, and the encode of one took the
# whole container down with it after the recording had already succeeded: the take
# was on disk and the run still reported failure. A caller that publishes a WebP
# and an mp4 does not need it.
if [ "${SCENE_GIF}" = "1" ]; then
	ffmpeg -loglevel error -y -i "${OUT}/${NAME}.mp4" \
		-vf "fps=${SCENE_GIF_FPS},scale=${SCENE_GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
		"${OUT}/${NAME}.gif"
fi
ls -la "${OUT}/${NAME}.mp4"
