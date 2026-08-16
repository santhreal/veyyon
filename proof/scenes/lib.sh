#!/usr/bin/env bash
# Helpers a scene uses to drive the terminal: keys, text, a real pointer, and
# stills cut out of the same display ffmpeg is recording.
#
# Sourced by proof/docker/xsession.sh with DISPLAY, SCENE_WINDOW, SCENE_NAME and
# SCENE_OUT already exported.

# The grid comes from the shell (`stty size`), and the pixel size of a cell from
# the window divided by that grid. Asking the terminal directly (CSI 16t) only
# works where window operations are enabled, which xterm disables by default.
read -r TERM_ROWS TERM_COLS <<<"$(sed -n 's/^stty=//p' /tmp/geom)"
PAD="${SCENE_PADDING:-8}"
: "${TERM_ROWS:=40}" "${TERM_COLS:=150}"
_win_px() { xdotool getwindowgeometry "${SCENE_WINDOW}" | sed -n 's/.*Geometry: \([0-9]*\)x\([0-9]*\)/\1 \2/p'; }
read -r WIN_W WIN_H <<<"$(_win_px)"
: "${WIN_W:=1600}" "${WIN_H:=1000}"
CELL_W=$(((WIN_W - 2 * PAD) / TERM_COLS))
CELL_H=$(((WIN_H - 2 * PAD) / TERM_ROWS))
: "${CELL_W:=9}" "${CELL_H:=18}"
echo "scene ${SCENE_NAME}: ${TERM_COLS}x${TERM_ROWS} cells of ${CELL_W}x${CELL_H}px"

# Row and column are 1-based, the way the terminal counts them.
px_x() { echo $(((${1} - 1) * CELL_W + CELL_W / 2 + PAD)); }
px_y() { echo $(((${1} - 1) * CELL_H + CELL_H / 2 + PAD)); }

pause() { sleep "${1:-0.5}"; }

k() { xdotool key --clearmodifiers --window "${SCENE_WINDOW}" "$@"; }
key_repeat() { # key_repeat <key> <count> [delay]
	local key="$1" count="$2" delay="${3:-0.12}"
	for _ in $(seq 1 "${count}"); do
		xdotool key --clearmodifiers --window "${SCENE_WINDOW}" "${key}"
		sleep "${delay}"
	done
}
t() { xdotool type --clearmodifiers --window "${SCENE_WINDOW}" --delay "${TYPE_DELAY:-28}" -- "$1"; }
submit() { t "$1"; pause 0.4; k Return; }

# Move the real pointer to a cell. The terminal turns that into the same SGR
# motion report a hand on a mouse produces, which is the only way a hover state
# is real evidence.
point() { xdotool mousemove --sync "$(px_x "$2")" "$(px_y "$1")"; }
# Glide, so the recording shows the pointer travelling and every row it crosses
# lighting up on the way.
glide() { # glide <row-from> <col-from> <row-to> <col-to> [steps] [delay]
	local r0="$1" c0="$2" r1="$3" c1="$4" steps="${5:-16}" delay="${6:-0.03}"
	for i in $(seq 0 "${steps}"); do
		xdotool mousemove --sync \
			"$(px_x $((c0 + (c1 - c0) * i / steps)))" \
			"$(px_y $((r0 + (r1 - r0) * i / steps)))"
		sleep "${delay}"
	done
}
click() { xdotool click 1; }
click_at() { point "$1" "$2"; pause 0.3; click; }
wheel_up() { key_repeat_button 4 "${1:-3}"; }
wheel_down() { key_repeat_button 5 "${1:-3}"; }
key_repeat_button() {
	local button="$1" count="$2"
	for _ in $(seq 1 "${count}"); do
		xdotool click "${button}"
		sleep 0.12
	done
}

shot() { import -window root "${SCENE_OUT}/${SCENE_NAME}-$1.png"; }

# Wait for text to appear on screen, so a scene never races the model. Reads the
# window's own text through kitty's remote control if it is on, otherwise falls
# back to a fixed wait.
settle() { sleep "${1:-2}"; }
