#!/usr/bin/env bash
# Private headless sway session for the desktop bench.
#
#   scripts/desktop-bench/session.sh start    # start, print the session environment
#   scripts/desktop-bench/session.sh env      # print the environment of the running session
#   scripts/desktop-bench/session.sh stop     # stop the session this script started
#
# The session renders on the render node in BENCH_DRM_DEVICE (default
# /dev/dri/renderD129) and runs Xwayland, so every app under test is an X11
# client of one display. The X display and the Wayland socket are chosen by
# sway; start fails, and stops the new sway, when the chosen X display or
# Wayland socket answered before sway started, or when it is :0 or :1.
set -euo pipefail

BENCH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="$(cd -- "${BENCH_DIR}/../.." && /bin/pwd -P)"
STATE_DIR="${BENCH_SESSION_DIR:-${REPO_ROOT}/.internal/bench/session}"
DRM_DEVICE="${BENCH_DRM_DEVICE:-/dev/dri/renderD129}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

die() {
	printf 'session.sh: %s\n' "$*" >&2
	exit 1
}

# Live X displays: every number whose server answers a connection.
live_x_displays() {
	local sock n
	for sock in /tmp/.X11-unix/X*; do
		[ -e "${sock}" ] || continue
		n="${sock##*/X}"
		if timeout 2 xdpyinfo -display ":${n}" >/dev/null 2>&1; then
			printf ':%s\n' "${n}"
		fi
	done
}

wayland_sockets() {
	local sock
	for sock in "${RUNTIME_DIR}"/wayland-*; do
		[ -S "${sock}" ] && printf '%s\n' "${sock##*/}"
	done
	return 0
}

# The pid in the state directory when it is a sway started with this state
# directory's config; empty otherwise.
running_pid() {
	local pid
	[ -f "${STATE_DIR}/sway.pid" ] || return 0
	pid="$(cat "${STATE_DIR}/sway.pid")"
	[ -n "${pid}" ] && [ -r "/proc/${pid}/cmdline" ] || return 0
	if tr '\0' ' ' <"/proc/${pid}/cmdline" | grep -qF -- "-c ${STATE_DIR}/sway.conf"; then
		printf '%s\n' "${pid}"
	fi
}

cmd_env() {
	[ -n "$(running_pid)" ] || die "no session is running (state: ${STATE_DIR})"
	cat "${STATE_DIR}/env"
}

cmd_start() {
	if [ -n "$(running_pid)" ] && [ -f "${STATE_DIR}/env" ]; then
		cat "${STATE_DIR}/env"
		return 0
	fi
	[ -e "${DRM_DEVICE}" ] || die "render node ${DRM_DEVICE} does not exist; set BENCH_DRM_DEVICE"
	command -v sway >/dev/null || die "sway is not installed"
	command -v Xwayland >/dev/null || die "Xwayland is not installed"
	command -v xdpyinfo >/dev/null || die "xdpyinfo is not installed"

	mkdir -p "${STATE_DIR}"
	rm -f "${STATE_DIR}/env" "${STATE_DIR}/env.tmp" "${STATE_DIR}/sway.pid"
	local before_x before_wl
	before_x="$(live_x_displays)"
	before_wl="$(wayland_sockets)"

	{
		cat "${BENCH_DIR}/sway.conf"
		printf 'exec %q _hook %q\n' "${BENCH_DIR}/session.sh" "${STATE_DIR}"
	} >"${STATE_DIR}/sway.conf"

	# A clean environment: an inherited DISPLAY or WAYLAND_DISPLAY would make
	# wlroots nest inside the caller's display.
	setsid env -i \
		HOME="${HOME}" PATH="${PATH}" USER="${USER:-$(id -un)}" \
		XDG_RUNTIME_DIR="${RUNTIME_DIR}" \
		WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_RENDERER=gles2 \
		WLR_RENDER_DRM_DEVICE="${DRM_DEVICE}" WLR_LIBINPUT_NO_DEVICES=1 \
		sway --unsupported-gpu -c "${STATE_DIR}/sway.conf" \
		</dev/null >"${STATE_DIR}/sway.log" 2>&1 &
	local pid=$!
	printf '%s\n' "${pid}" >"${STATE_DIR}/sway.pid"

	local waited=0
	until [ -f "${STATE_DIR}/env" ]; do
		kill -0 "${pid}" 2>/dev/null || die "sway exited during startup; see ${STATE_DIR}/sway.log"
		[ "${waited}" -lt 200 ] || { cmd_stop; die "sway did not report its displays within 10 s"; }
		sleep 0.05
		waited=$((waited + 1))
	done

	# shellcheck disable=SC1091
	. "${STATE_DIR}/env"
	local refuse=""
	case "${DISPLAY:-}" in
	"" | :0 | :1) refuse="Xwayland display '${DISPLAY:-}' is not a private display" ;;
	esac
	if [ -z "${refuse}" ] && grep -qxF -- "${DISPLAY}" <<<"${before_x}"; then
		refuse="Xwayland display ${DISPLAY} was already in use"
	fi
	if [ -z "${refuse}" ] && grep -qxF -- "${WAYLAND_DISPLAY}" <<<"${before_wl}"; then
		refuse="Wayland socket ${WAYLAND_DISPLAY} was already in use"
	fi
	if [ -z "${refuse}" ]; then
		waited=0
		until timeout 2 xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; do
			[ "${waited}" -lt 100 ] || { refuse="Xwayland on ${DISPLAY} did not answer within 5 s"; break; }
			sleep 0.05
			waited=$((waited + 1))
		done
	fi
	if [ -n "${refuse}" ]; then
		cmd_stop
		die "${refuse}"
	fi
	cat "${STATE_DIR}/env"
}

cmd_stop() {
	local pid
	pid="$(running_pid)"
	if [ -z "${pid}" ]; then
		rm -f "${STATE_DIR}/env" "${STATE_DIR}/sway.pid"
		return 0
	fi
	kill -TERM "${pid}" 2>/dev/null || true
	local waited=0
	while kill -0 "${pid}" 2>/dev/null; do
		if [ "${waited}" -ge 60 ]; then
			kill -KILL "${pid}" 2>/dev/null || true
			break
		fi
		sleep 0.05
		waited=$((waited + 1))
	done
	rm -f "${STATE_DIR}/env" "${STATE_DIR}/sway.pid"
}

# Run by sway itself through the `exec` line: records the environment sway
# gives its children.
cmd_hook() {
	local dir="$1"
	printf 'WAYLAND_DISPLAY=%s\nDISPLAY=%s\nSWAYSOCK=%s\nXDG_RUNTIME_DIR=%s\n' \
		"${WAYLAND_DISPLAY:-}" "${DISPLAY:-}" "${SWAYSOCK:-}" "${XDG_RUNTIME_DIR:-}" >"${dir}/env.tmp"
	mv "${dir}/env.tmp" "${dir}/env"
}

case "${1:-}" in
start) cmd_start ;;
stop) cmd_stop ;;
env) cmd_env ;;
_hook) cmd_hook "$2" ;;
*)
	printf 'usage: %s start|stop|env\n' "$0" >&2
	exit 2
	;;
esac
