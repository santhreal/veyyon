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
# A themed capture insets the window so the backdrop and the compositor's shadow
# are visible, so the window's own origin is no longer the screen's. Every
# pointer target is a pixel on the ROOT window, which is what xdotool moves and
# what ffmpeg records, so the origin has to be added back. It is 0,0 for a plain
# full-screen capture, which leaves those scenes aiming at exactly the pixels
# they did before.
_win_origin() { xdotool getwindowgeometry "${SCENE_WINDOW}" | sed -n 's/.*Position: \([0-9]*\),\([0-9]*\).*/\1 \2/p'; }
read -r WIN_X WIN_Y <<<"$(_win_origin)"
: "${WIN_X:=0}" "${WIN_Y:=0}"
CELL_W=$(((WIN_W - 2 * PAD) / TERM_COLS))
CELL_H=$(((WIN_H - 2 * PAD) / TERM_ROWS))
: "${CELL_W:=9}" "${CELL_H:=18}"
echo "scene ${SCENE_NAME}: ${TERM_COLS}x${TERM_ROWS} cells of ${CELL_W}x${CELL_H}px at +${WIN_X}+${WIN_Y}"

# Row and column are 1-based, the way the terminal counts them.
px_x() { echo $((WIN_X + (${1} - 1) * CELL_W + CELL_W / 2 + PAD)); }
px_y() { echo $((WIN_Y + (${1} - 1) * CELL_H + CELL_H / 2 + PAD)); }

pause() { sleep "${1:-0.5}"; }

# Keys go to the window xsession.sh found. That id can go stale: kitty may map a
# second window during startup and retire the first, and every key after that
# dies of BadWindow -- which under `set -e` takes the recorder down with it,
# leaving a video that stops at the first keystroke and no gif and no stats. The
# whole scene had already run past its load when that happened on the fresh arm
# of the long-session pair. So a send that fails on the id is retried against
# whatever holds the focus, and a send that fails both ways is reported and does
# not abort the run: a scene that loses one key is worth more than no recording.
_xdo() {
	local verb="$1"
	shift
	xdotool "${verb}" --clearmodifiers --window "${SCENE_WINDOW}" "$@" 2>/dev/null && return 0
	xdotool "${verb}" --clearmodifiers "$@" 2>/dev/null && return 0
	echo "scene: ${verb} ${*} reached no window" >&2
	return 0
}

k() { _xdo key "$@"; }
key_repeat() { # key_repeat <key> <count> [delay]
	local key="$1" count="$2" delay="${3:-0.12}"
	for _ in $(seq 1 "${count}"); do
		_xdo key "${key}"
		sleep "${delay}"
	done
}
# Typing is not the demonstration. A published clip that spends its first seconds
# watching characters appear one at a time shows the recorder's pointer, not the
# product, so the text lands as fast as the emulator will accept it and the clip
# begins at the result. A scene driving a login shell rather than the app can raise
# TYPE_DELAY: a shell has no input debounce of its own and xdotool has been observed
# doubling characters into one, which turns a typed command into a typo.
t() { _xdo type --delay "${TYPE_DELAY:-0}" -- "$1"; }
submit() {
	t "$1"
	pause 0.2
	k Return
}

# Submit a slash command. The completion popup owns Return while it is open: it
# takes the highlighted row rather than submitting the line, so a command whose
# name is a prefix of another one gets the wrong one. The escape dismisses the
# popup and leaves the typed text, which is what the recorded tapes did and for
# this reason.
slash() {
	t "$1"
	pause 0.7
	k Escape
	pause 0.3
	k Return
}

# Move the real pointer to a pixel. The terminal turns that into the same SGR
# motion report a hand on a mouse produces, which is the only way a hover state
# is real evidence.
#
# A move to the pixel the pointer already occupies is skipped, and that check is
# the difference between a scene that runs and one that does not: `xdotool
# mousemove --sync` waits for a motion event, a move to the current position
# produces none, and it stands there for FIFTEEN SECONDS before giving up. The
# card-bands scene measured 351s against sixty seconds of its own sleeps, all of
# it duplicate moves inside `glide`.
move_px() {
	local x="$1" y="$2" loc cx cy
	loc="$(xdotool getmouselocation --shell)"
	cx="$(printf '%s\n' "${loc}" | sed -n 's/^X=//p')"
	cy="$(printf '%s\n' "${loc}" | sed -n 's/^Y=//p')"
	if [ "${cx}" = "${x}" ] && [ "${cy}" = "${y}" ]; then return 0; fi
	xdotool mousemove --sync "${x}" "${y}"
}

# Move the real pointer to a cell.
point() { move_px "$(px_x "$2")" "$(px_y "$1")"; }

# Glide, so the recording shows the pointer travelling and every row it crosses
# lighting up on the way. Interpolated in PIXELS: stepping in cells rounds every
# intermediate step onto one of the endpoint rows, which is a teleport with
# extra sleeps rather than a travelling pointer.
glide() { # glide <row-from> <col-from> <row-to> <col-to> [steps] [delay]
	local r0="$1" c0="$2" r1="$3" c1="$4" steps="${5:-16}" delay="${6:-0.03}"
	local x0 y0 x1 y1 i
	x0="$(px_x "${c0}")"
	y0="$(px_y "${r0}")"
	x1="$(px_x "${c1}")"
	y1="$(px_y "${r1}")"
	for i in $(seq 0 "${steps}"); do
		move_px "$((x0 + (x1 - x0) * i / steps))" "$((y0 + (y1 - y0) * i / steps))"
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

# A still, and the second of the recording it was taken at.
#
# The timestamp is what lets a clip be cut around the moments the scene exists to
# show. Nothing else in the take knows where they are: change magnitude finds the
# largest repaints, which in a session against a reasoning model are pages of
# thinking, so a magnitude cut of a feature scene is streamed text with the feature
# in two frames of it. SCENE_T0 is set in milliseconds when the recorder starts
# capturing, so this is an offset into the video and not a wall clock. The
# arithmetic is shell integer maths because the recorder image carries no `bc`.
shot() {
	import -window root "${SCENE_OUT}/${SCENE_NAME}-$1.png"
	if [ -n "${SCENE_T0:-}" ]; then
		local ms=$(($(date +%s%3N) - SCENE_T0))
		printf '%s\t%d.%d\n' "$1" $((ms / 1000)) $((ms % 1000 / 100)) \
			>>"${SCENE_OUT}/${SCENE_NAME}-marks.tsv"
	fi
}

# Wait out a turn. Every wait in every scene passes through here, so one knob
# retimes a scene for a slower model: SCENE_SETTLE_SCALE multiplies it.
#
# The waits in these scenes were measured against a sparse 30B that generates about
# 90 tokens a second. The dense 32B recording them now generates 48, so it wants
# roughly twice the wait. A wait that is too short does not fail loudly: it records
# the next question typed into a composer that is still streaming the last answer,
# which is worse than no recording because it looks like the product dropped a turn.
# Scaling is done in awk because the recorder image carries no bc and a wait can be
# fractional.
settle() {
	local want="${1:-2}" scale="${SCENE_SETTLE_SCALE:-1}"
	[ "${scale}" = "1" ] || want="$(awk -v w="${want}" -v s="${scale}" 'BEGIN { printf "%.1f", w * s }')"
	sleep "${want}"
}
