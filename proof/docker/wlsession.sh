#!/usr/bin/env bash
# Record one scene under swayfx, so the capture has the blur, the rounded corners
# and the shadow a compositor draws natively.
#
#   proof/docker/wlsession.sh proof/scenes/<name>.sh
#
# This is xsession.sh's twin and keeps its contract exactly: it exports SCENE_NAME,
# SCENE_OUT and SCENE_T0, sources proof/scenes/lib.sh and then the scene, records
# video for the whole run, and writes <name>.mp4 plus one PNG per shot into /out.
#
# WHY A SECOND SESSION SCRIPT RATHER THAN A BRANCH IN THE FIRST. Almost nothing is
# shared: there is no X server, no window manager to work around, no window id to
# chase, no xdotool, and the capture and the encoder are different programs. The
# parts that ARE shared -- the backdrop recipe, the terminal's options, the scene
# handoff -- are short, and the X11 path is what every published frame was recorded
# through, so it is left untouched rather than rebuilt around a conditional.
#
# What this stack cost to find, kept here because each one is a container:
#   * swayfx will not run as root and exits at main.cpp:59, so the session runs as
#     an unprivileged user and only the setup above it is root.
#   * wlroots' gles2 renderer refuses to start without a DRM render node even on
#     the headless backend. WLR_RENDERER=pixman needs no node and cannot run the
#     blur shader, so the node is a requirement: the container needs
#     `--device /dev/dri/renderD128` and the render group.
#   * The compositor is ready when grim can copy the output, not when the socket
#     exists. wlroots advertises the socket before the output is committed.
set -euo pipefail

SCENE="${1:?usage: wlsession.sh <scene.sh>}"
NAME="$(basename "${SCENE}" .sh)"
OUT="${SCENE_OUT_DIR:-/out}"
W="${SCENE_WIDTH:-2560}"
H="${SCENE_HEIGHT:-1440}"
FPS="${SCENE_FPS:-30}"
MARGIN=0
mkdir -p "${OUT}"

if [ "${SCENE_THEME:-plain}" != "plain" ]; then
	MARGIN="${SCENE_MARGIN:-96}"
	# The same field xsession.sh builds, for the same reason: neutral but NOT
	# featureless. An earlier version lit it violet in one corner and cyan in the
	# other, which put a saturated rim on every window edge, and it was blurred to
	# 0x70, which is past the point where anything is left to blur -- a window blur
	# that samples a smooth gradient returns the same smooth gradient.
	magick -size "${W}x${H}" xc:"${SCENE_BACKDROP_BASE:-#1a1e26}" \
		\( -size "${W}x${H}" radial-gradient:"${SCENE_BACKDROP_WARM:-#f8fafc}"-"#000000" \
		-resize 165% -gravity northwest -crop "${W}x${H}+0+0" -evaluate multiply 0.44 \) \
		-compose screen -composite \
		\( -size "${W}x${H}" radial-gradient:"${SCENE_BACKDROP_COOL:-#a5c8ff}"-"#000000" \
		-resize 190% -gravity southeast -crop "${W}x${H}+0+0" -evaluate multiply 0.20 \) \
		-compose screen -composite \
		\( -size "${W}x${H}" gradient:"#ffffff"-"#000000" -rotate -28 \
		-gravity center -crop "${W}x${H}+0+0" -evaluate multiply 0.13 \) \
		-compose screen -composite \
		\( -size "${W}x${H}" gradient:"#00000000"-"#000000" -evaluate multiply 0.22 \) \
		-compose over -composite \
		-blur "0x${SCENE_BACKDROP_BLUR:-26}" -modulate 100,55,100 /tmp/backdrop.png
fi

TW=$((W - 2 * MARGIN))
TH=$((H - 2 * MARGIN))

# The terminal's options are the X11 session's, minus the ones that only meant
# something to a compositor scraping an X pixmap. background_opacity is the
# client's own here and it works: on Wayland the terminal picks an ARGB buffer
# without needing a GLX visual with an alpha channel, which is exactly what it
# could not do on Xvfb.
# The session's HOME is the SEEDED one, not a fresh home for the unprivileged
# user. record-wl.sh copies the profile into ${HOME}/.veyyon before this script
# runs, and the product reads its models, its config and its vault from there; a
# session started with any other HOME finds no profile and comes up in first-run
# onboarding, which is what the first glass take actually recorded.
SESSION_HOME="${HOME:-/sandbox/home}"
mkdir -p "${SESSION_HOME}/.config/kitty"
cat >"${SESSION_HOME}/.config/kitty/kitty.conf" <<KITTY
font_family JetBrains Mono
font_size ${SCENE_FONT_SIZE:-15}
background ${SCENE_BG:-#1e2127}
foreground ${SCENE_FG:-#d7dae0}
background_opacity ${SCENE_OPACITY:-0.72}
dynamic_background_opacity yes
cursor_blink_interval 0
window_padding_width ${SCENE_PADDING:-8}
remember_window_size no
initial_window_width ${TW}
initial_window_height ${TH}
hide_window_decorations yes
confirm_os_window_close 0
scrollback_lines 20000
enable_audio_bell no
focus_follows_mouse yes
allow_remote_control socket-only
KITTY

# The window's rectangle is stated, not discovered. On X11 the session had to find
# a window id, move it, and read the placement back, because kitty maps and
# retires a window during startup and a take once recorded full-bleed with the
# backdrop nowhere on screen. Here the compositor is told the rectangle before the
# client exists, and the scene library is told the same numbers.
cat >/tmp/sway.conf <<CONF
output ${SCENE_OUTPUT:-HEADLESS-1} resolution ${W}x${H}
default_border none
default_floating_border none
gaps inner 0
focus_follows_mouse no

corner_radius ${SCENE_RADIUS:-26}
blur enable
blur_passes ${SCENE_BLUR_PASSES:-3}
blur_radius ${SCENE_BLUR_RADIUS:-5}
blur_noise ${SCENE_BLUR_NOISE:-0.02}
blur_brightness ${SCENE_BLUR_BRIGHTNESS:-1.02}
shadows enable
shadows_on_csd enable
shadow_blur_radius ${SCENE_SHADOW_BLUR:-44}
shadow_color ${SCENE_SHADOW_COLOR:-#00000099}
shadow_offset 0 6
layer_effects "swaybg" blur disable

for_window [app_id="kitty"] floating enable, resize set ${TW} ${TH}, move position ${MARGIN} ${MARGIN}
CONF
if [ "${SCENE_THEME:-plain}" != "plain" ]; then
	printf 'exec swaybg -i /tmp/backdrop.png -m fill\n' >>/tmp/sway.conf
else
	printf 'output %s background %s solid_color\n' "${SCENE_OUTPUT:-HEADLESS-1}" "${SCENE_BG:-#1e2127}" >>/tmp/sway.conf
fi

# The scene's own command, run in the terminal, exactly as the X11 path does it:
# the grid the scene aims at comes from `stty size` inside that shell.
#
# The window OUTLIVES the command through kitty's own --hold, not through a shell
# left running after it. The X11 path could let kitty close with the product,
# because a crash was still readable in a log written as root; here the container
# is torn down straight after, and the first glass take of the real product
# recorded an empty window whose reason had already gone.
#
# The command is `exec`ed, exactly as the X11 path does it, and that is a finding
# rather than a preference: with a shell kept as the parent the product started,
# held the pty and painted NOTHING (a bare cursor, 709 near-background pixels in
# the whole top text band, an empty `get-text`, an empty stderr and no exit
# status), while kitty logged a garbled private mode nobody sends. --hold keeps
# whatever it printed on screen and in `get-text` after it exits, which is where
# a crash has to be readable once the container is gone.
cat >/tmp/bootstrap.sh <<'BOOT'
#!/usr/bin/env bash
# One number in the environment, for a scene that stores a credential with `/secret
# from-env` and then asks the model to sign with the placeholder. Exported here rather
# than typed in the session, which is the point: a credential that reaches the vault
# through the environment never appears in the transcript, so what the recording shows
# being spent is a placeholder. xsession.sh has always done this and this file did not,
# which cost a full rehearsal: every turn ran, and the one the take exists for reported
# "the environment variable RELEASE_SIGNATURE is not set in this process".
export RELEASE_SIGNATURE="${SCENE_SIGNING_NUMBER:-}"
printf 'stty=%s\n' "$(stty size)" >/tmp/geom
cd "${SCENE_CWD:-/sandbox/home/demo}" || cd /
exec script -q -f -c "${SCENE_COMMAND}" /tmp/app-out.raw 2>/tmp/app-stderr.log
BOOT
chmod +x /tmp/bootstrap.sh

# THE SESSION USER IS THE REPO'S OWNER, and that is not cosmetic. swayfx refuses to
# run as root, so this path cannot keep the X11 session's root, and an arbitrary
# unprivileged uid cannot write the repo: bun needs its cache and the product needs
# its logs, so the product exits and the take records an empty window. The uid that
# owns the bind mount can do both and is still not root.
PUID="${SCENE_UID:-$(stat -c %u /repo)}"
[ "${PUID}" != 0 ] || PUID=1500
PUSER="$(getent passwd "${PUID}" | cut -d: -f1 || true)"
if [ -z "${PUSER}" ]; then
	groupadd -g "${PUID}" proof 2>/dev/null || true
	useradd -m -u "${PUID}" -g "${PUID}" -s /bin/bash proof
	PUSER=proof
fi
PGID="$(id -g "${PUSER}")"
getent group "${SCENE_RENDER_GID:-993}" >/dev/null 2>&1 ||
	groupadd -g "${SCENE_RENDER_GID:-993}" rendernode
usermod -aG "${SCENE_RENDER_GID:-993}" "${PUSER}"
mkdir -p /tmp/xdg
chmod 700 /tmp/xdg
chown -R "${PUID}:${PGID}" /tmp/xdg "${OUT}"
chown "${PUID}:${PGID}" /tmp/sway.conf /tmp/bootstrap.sh /tmp/backdrop.png 2>/dev/null || true
# The seeded HOME is handed over rather than copied: it already holds the profile
# record-wl.sh wrote, including the models file whose base URL was rewritten for
# this host, and the demo project seed-demo.sh git-inited.
chown -R "${PUID}:${PGID}" "${SESSION_HOME}" 2>/dev/null || true

cat >/tmp/session.sh <<'SESSION'
set -euo pipefail
export XDG_RUNTIME_DIR=/tmp/xdg
export WLR_BACKENDS=headless
export WLR_HEADLESS_OUTPUTS=1
export WLR_RENDERER=gles2
export WLR_LIBINPUT_NO_DEVICES=1
export WLR_NO_HARDWARE_CURSORS=1
export XDG_SESSION_TYPE=wayland
export WAYLAND_DISPLAY=wayland-1
[ -n "${SCENE_RENDER_NODE:-}" ] && export WLR_RENDER_DRM_DEVICE="${SCENE_RENDER_NODE}"

sway -c /tmp/sway.conf >/tmp/sway.log 2>&1 &
SWAY_PID=$!
export SWAYSOCK="${XDG_RUNTIME_DIR}/sway-ipc.$(id -u).${SWAY_PID}.sock"

ready=0
for _ in $(seq 1 120); do
	kill -0 "${SWAY_PID}" 2>/dev/null || break
	if grim -o "${SCENE_OUTPUT:-HEADLESS-1}" /tmp/ready.png >/dev/null 2>&1; then
		ready=1
		break
	fi
	sleep 0.5
done
if [ "${ready}" != 1 ]; then
	echo "chrome: swayfx never produced a copyable output" >&2
	tail -25 /tmp/sway.log >&2
	exit 1
fi
echo "chrome: swayfx radius ${SCENE_RADIUS:-26} blur ${SCENE_BLUR_PASSES:-3}x${SCENE_BLUR_RADIUS:-5} shadow ${SCENE_SHADOW_BLUR:-44} composited the output" >&2

kitty --hold --listen-on unix:/tmp/kitty.sock /tmp/bootstrap.sh >/tmp/term.log 2>&1 &
KITTY_PID=$!
# The terminal is up when its socket answers, which is also the channel every
# typed character and every screen read goes through, so this waits on the thing
# the scene actually depends on rather than on a window appearing.
for _ in $(seq 1 120); do
	kitty @ --to unix:/tmp/kitty.sock ls >/dev/null 2>&1 && break
	sleep 0.5
done
for _ in $(seq 1 60); do
	[ -s /tmp/geom ] && break
	sleep 0.5
done

# wf-recorder takes its frames through wlr-screencopy, the same protocol grim
# uses, so a still and the video frame at that second are the same pixels.
wf-recorder -o "${SCENE_OUTPUT:-HEADLESS-1}" -f "${SCENE_VIDEO}" -r "${SCENE_FPS:-30}" \
	-c libx264 -p preset=veryfast -p crf=20 --no-damage >/tmp/wf.log 2>&1 &
WF_PID=$!
sleep 1
rm -f "${SCENE_OUT}/${SCENE_NAME}-marks.tsv"
export SCENE_T0="$(date +%s%3N)"

cleanup() {
	# THE SCREEN IS READ BEFORE ANYTHING IS KILLED. This ran after `kill
	# "${KITTY_PID}"` and so asked a dead terminal what it was showing: the
	# capture came back empty on every take, which read as "the product painted
	# nothing" and sent the diagnosis after the product instead of after this
	# function. An empty capture must mean an empty screen, or it is not evidence.
	kitty @ --to unix:/tmp/kitty.sock get-text >"${SCENE_OUT}/${SCENE_NAME}-screen.txt" 2>/dev/null || true
	# wf-recorder needs SIGINT to finalise the container; killing it outright
	# leaves an mp4 with no moov atom, which plays nowhere.
	kill -INT "${WF_PID}" 2>/dev/null || true
	wait "${WF_PID}" 2>/dev/null || true
	kill "${KITTY_PID}" 2>/dev/null || true
	swaymsg exit >/dev/null 2>&1 || kill "${SWAY_PID}" 2>/dev/null || true
	# The container is gone the moment this returns, and with it every reason a
	# take came out wrong. The first glass take of the real product recorded an
	# empty window and the log that said why had already been destroyed, so the
	# logs leave with the artifacts.
	for log in /tmp/term.log /tmp/sway.log /tmp/wf.log /tmp/app-stderr.log /tmp/app-exit /tmp/app-out.raw; do
		[ -s "${log}" ] && cp -f "${log}" "${SCENE_OUT}/${SCENE_NAME}-$(basename "${log}")" 2>/dev/null
	done
	return 0
}
trap cleanup EXIT

export SCENE_SERVER=wayland
export KITTY_SOCKET="unix:/tmp/kitty.sock"
# The scene library reads the window rectangle from these rather than asking the
# compositor: sway was told the rectangle, so these are the numbers it applied.
export SCENE_WIN_W="${SCENE_TW}"
export SCENE_WIN_H="${SCENE_TH}"
export SCENE_WIN_X="${SCENE_MARGIN_PX}"
export SCENE_WIN_Y="${SCENE_MARGIN_PX}"
_WL_PTR_X=$((SCENE_MARGIN_PX + SCENE_TW / 2))
_WL_PTR_Y=$((SCENE_MARGIN_PX + SCENE_TH / 2))
export _WL_PTR_X _WL_PTR_Y
swaymsg -- seat "${SCENE_SEAT:-seat0}" cursor set "${_WL_PTR_X}" "${_WL_PTR_Y}" >/dev/null 2>&1 || true

# shellcheck disable=SC1090
source "${SCENE_LIB:-/repo/proof/scenes/lib.sh}"
# shellcheck disable=SC1090
source "${SCENE_FILE}"

sleep 1
cleanup
trap - EXIT
SESSION
chown "${PUID}:${PGID}" /tmp/session.sh

setpriv --reuid "${PUID}" --regid "${PGID}" --init-groups --inh-caps=-all \
	env "HOME=${SESSION_HOME}" PATH=/opt/glass/bin:/usr/local/bin:/usr/bin:/bin \
	"SCENE_FILE=${SCENE}" "SCENE_NAME=${NAME}" "SCENE_OUT=${OUT}" \
	"SCENE_VIDEO=${OUT}/${NAME}.mp4" "SCENE_TW=${TW}" "SCENE_TH=${TH}" \
	"SCENE_MARGIN_PX=${MARGIN}" "SCENE_FPS=${FPS}" \
	"SCENE_OUTPUT=${SCENE_OUTPUT:-HEADLESS-1}" \
	"SCENE_RENDER_NODE=${SCENE_RENDER_NODE:-/dev/dri/renderD128}" \
	"SCENE_RADIUS=${SCENE_RADIUS:-26}" \
	"SCENE_BLUR_PASSES=${SCENE_BLUR_PASSES:-3}" \
	"SCENE_BLUR_RADIUS=${SCENE_BLUR_RADIUS:-5}" \
	"SCENE_SHADOW_BLUR=${SCENE_SHADOW_BLUR:-44}" \
	"SCENE_COMMAND=${SCENE_COMMAND:-bun /repo/packages/coding-agent/src/cli.ts}" \
	"SCENE_CWD=${SCENE_CWD:-/sandbox/home/demo}" \
	"SCENE_PADDING=${SCENE_PADDING:-8}" \
	"SCENE_SETTLE_SCALE=${SCENE_SETTLE_SCALE:-1}" \
	"SCENE_SIGNING_NUMBER=${SCENE_SIGNING_NUMBER:-}" \
	"SCENE_LIB=${SCENE_LIB:-/repo/proof/scenes/lib.sh}" \
	"LOCAL_LLM_KEY=${LOCAL_LLM_KEY:-none}" \
	"PROOF_LLM_BASE_URL=${PROOF_LLM_BASE_URL:-}" \
	"VEYYON_DEMO_SECRET=${VEYYON_DEMO_SECRET:-}" \
	"SCENE_HIDE_THINKING=${SCENE_HIDE_THINKING:-}" \
	"SCENE_SETTINGS=${SCENE_SETTINGS:-}" \
	"SCENE_THEME=${SCENE_THEME:-plain}" \
	"SCENE_BG=${SCENE_BG:-#1e2127}" "SCENE_FG=${SCENE_FG:-#d7dae0}" \
	"TYPE_DELAY=${TYPE_DELAY:-}" \
	"SCENE_TYPING_REPEAT=${SCENE_TYPING_REPEAT:-}" \
	"TERM=xterm-kitty" "COLORTERM=truecolor" "LANG=C.UTF-8" "LC_ALL=C.UTF-8" \
	bash /tmp/session.sh

ls -la "${OUT}/${NAME}.mp4"
