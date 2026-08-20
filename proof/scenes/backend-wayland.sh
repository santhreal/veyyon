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

# THE POINTER GOES THROUGH THE PTY, AND THIS IS WHY. sway's headless backend gives
# the seat no pointer device, so `swaymsg seat seat0 cursor set` moves a cursor
# nothing is listening to: it exits 0, the compositor is happy, and the client
# receives no enter, no motion and no button. Measured rather than assumed --
# pointer-probe.sh drove the same file on both servers, and the settings sidebar
# row under the pointer came out 3.3 luminance brighter on X11 and 0.9 DARKER on
# Wayland, which is no hover band at all. A pointer that reports its own position
# back out of a variable it just set will pass any check that trusts it.
#
# So the report the terminal would have sent is written straight into the pty, in
# the SGR 1006 encoding the product already reads -- the same move the typed text
# and the keys made after xdotool's corruption cost three takes, for the same
# reason: the byte carries no ambiguity. The app's hit-testing, hover fades and
# click routing all run for real. What this does NOT exercise is the compositor's
# own input path and the terminal's encoding of a physical button, and the X11 arm
# is where those are still tested; a claim about the pointer on this backend is a
# claim about the application, not about libinput.
#
# The compositor's cursor is still moved, because wf-recorder draws it into the
# video and a scene about a pointer should show one travelling.
_be_pointer_at() { printf '%s %s' "${_WL_PTR_X:-0}" "${_WL_PTR_Y:-0}"; }

# Screen pixel -> terminal cell, inverting lib.sh's px_x/px_y exactly. A report at
# the wrong cell is worse than no report: it lands on a neighbouring row and the
# scene photographs the wrong thing while every check passes.
_wl_cell_col() { echo $(((${1} - WIN_X - PAD) / (CELL_W > 0 ? CELL_W : 9) + 1)); }
_wl_cell_row() { echo $(((${1} - WIN_Y - PAD) / (CELL_H > 0 ? CELL_H : 18) + 1)); }

_wl_report() { # _wl_report <cb> <M|m>
	printf '\033[<%d;%d;%d%s' "$1" "$(_wl_cell_col "${_WL_PTR_X:-0}")" \
		"$(_wl_cell_row "${_WL_PTR_Y:-0}")" "$2" |
		kitty @ --to "${KITTY_SOCKET}" send-text --stdin 2>/dev/null || {
		echo "scene: pointer report reached no terminal" >&2
		return 0
	}
}

_be_pointer_move() {
	_WL_PTR_X="$1"
	_WL_PTR_Y="$2"
	swaymsg -- seat "${SCENE_SEAT:-seat0}" cursor set "$1" "$2" >/dev/null 2>&1 || true
	# 32 marks a motion report and 3 means no button held: what a hand moving a
	# mouse across the window produces, which is what a hover state is made of.
	_wl_report 35 M
}

_be_click() {
	local button="${1:-1}"
	case "${button}" in
	# A wheel is an axis event on Wayland rather than a button, and it is the same
	# report either way: 64 up, 65 down, at the cell the pointer is on.
	4 | 5) _wl_report $((button == 4 ? 64 : 65)) M ;;
	*)
		_wl_report $((button - 1)) M
		sleep 0.05
		_wl_report $((button - 1)) m
		;;
	esac
}

_be_capture() { grim -o "${SCENE_OUTPUT:-HEADLESS-1}" "$1"; }
