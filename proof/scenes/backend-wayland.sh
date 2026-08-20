#!/usr/bin/env bash
# The same six primitives on Wayland, so a scene written for X11 records under a
# compositor that has blur, rounded corners and shadows.
#
# WHY THIS EXISTS. picom gives X11 rounding, a shadow and a fixed convolution
# blur, and its dual_kawase backend -- the one that looks like hyprland -- cannot
# be used at all: on this GL stack picom redirects the screen and composites a
# window with NO CONTENTS, because texture-from-pixmap never hands it the
# terminal's surface. A Wayland compositor composites the client's own buffer, so
# that class of failure does not exist, and swayfx has all three effects natively.
#
# WHAT IS DIFFERENT, and it is only these three things:
#   * Stills come from grim over wlr-screencopy instead of `import` off an X screen.
#   * The pointer moves through sway's IPC, because xdotool talks XTEST and there
#     is no Wayland equivalent. This is a REAL pointer: the compositor generates
#     motion, kitty turns it into the same SGR 1006 report a hand on a mouse
#     produces, so a hover state is still real evidence rather than a repaint.
#   * Keys are written into the pty as the bytes a terminal actually sends for
#     them. That is not a workaround for a missing tool: typed TEXT already went
#     through the pty for the same reason (`xdotool type` duplicated characters
#     under load and cost three takes), and a key carries no payload to corrupt.
#
# WHAT THIS DOES NOT COVER. An unmapped key name fails loudly instead of doing
# nothing, because a key that silently does not arrive looks exactly like a
# product that ignored it -- and the frame is the only place it would show.

# Geometry is not read back from the compositor. sway is told the window's exact
# rectangle in its config (`resize set` + `move position`), so the values are the
# ones the session asked for; asking the IPC for them would only echo the same
# numbers back through a JSON parse this image has no jq for.
_be_window_px() { printf '%s %s' "${SCENE_WIN_W}" "${SCENE_WIN_H}"; }
_be_window_origin() { printf '%s %s' "${SCENE_WIN_X}" "${SCENE_WIN_Y}"; }

# Every key a scene sends, as the bytes the terminal sends for it. The set is
# closed on purpose and matches what the scenes actually use: Escape, Return,
# Prior, Next, shift+Prior, shift+Next, Up, Down, BackSpace, ctrl+u, ctrl+r.
_be_keyseq() {
	case "$1" in
	Escape) printf '\033' ;;
	Return) printf '\r' ;;
	BackSpace) printf '\177' ;;
	Up) printf '\033[A' ;;
	Down) printf '\033[B' ;;
	Right) printf '\033[C' ;;
	Left) printf '\033[D' ;;
	Prior) printf '\033[5~' ;;
	Next) printf '\033[6~' ;;
	shift+Prior) printf '\033[5;2~' ;;
	shift+Next) printf '\033[6;2~' ;;
	Tab) printf '\t' ;;
	ctrl+u) printf '\025' ;;
	ctrl+r) printf '\022' ;;
	ctrl+c) printf '\003' ;;
	*) return 1 ;;
	esac
}

_be_key() {
	local name seq
	for name in "$@"; do
		if ! seq="$(_be_keyseq "${name}")"; then
			echo "scene: key '${name}' has no Wayland encoding (add it to backend-wayland.sh)" >&2
			return 0
		fi
		printf '%s' "${seq}" | kitty @ --to "${KITTY_SOCKET}" send-text --stdin 2>/dev/null || {
			echo "scene: key ${name} reached no terminal" >&2
			return 0
		}
	done
}

# The compositor owns the cursor position and will not report it back, so the
# session tracks it. That is what lets move_px skip a move to the pixel the
# pointer already occupies -- the check that keeps `glide` from standing still for
# fifteen seconds per duplicate step.
_be_pointer_at() { printf '%s %s' "${_WL_PTR_X:-0}" "${_WL_PTR_Y:-0}"; }
_be_pointer_move() {
	swaymsg -- seat "${SCENE_SEAT:-seat0}" cursor set "$1" "$2" >/dev/null 2>&1 || {
		echo "scene: pointer move to ${1},${2} was refused by the compositor" >&2
		return 0
	}
	_WL_PTR_X="$1"
	_WL_PTR_Y="$2"
}
_be_click() {
	local button="${1:-1}"
	case "${button}" in
	# A wheel is an axis event on Wayland, not a button, and sway's cursor command
	# has no axis verb. The terminal's own report is what the product reads, so the
	# scroll is written into the pty as the SGR 1006 sequence a wheel produces --
	# button 64 up, 65 down -- at the pointer's current cell.
	4 | 5)
		local code=$((button == 4 ? 64 : 65))
		local col=$(((_WL_PTR_X - SCENE_WIN_X) / (CELL_W > 0 ? CELL_W : 9) + 1))
		local row=$(((_WL_PTR_Y - SCENE_WIN_Y) / (CELL_H > 0 ? CELL_H : 18) + 1))
		printf '\033[<%d;%d;%dM' "${code}" "${col}" "${row}" |
			kitty @ --to "${KITTY_SOCKET}" send-text --stdin 2>/dev/null || true
		;;
	*)
		swaymsg -- seat "${SCENE_SEAT:-seat0}" cursor press "button${button}" >/dev/null 2>&1 || true
		sleep 0.05
		swaymsg -- seat "${SCENE_SEAT:-seat0}" cursor release "button${button}" >/dev/null 2>&1 || true
		;;
	esac
}

_be_capture() { grim -o "${SCENE_OUTPUT:-HEADLESS-1}" "$1"; }
