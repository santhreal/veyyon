#!/usr/bin/env bash
# The X11 primitives every scene helper is built on: keys, pointer, capture.
#
# This is the code that used to sit inline in lib.sh, moved behind a name so a
# second display server can answer the same six calls. Nothing about the X11
# behaviour changed, deliberately: every published frame on the proof page was
# recorded through these exact calls, so a scene must not record differently
# because the file it lives in was reorganised.
#
# Sourced by lib.sh when SCENE_SERVER is x11 (the default). DISPLAY and
# SCENE_WINDOW are already exported by xsession.sh.

# Text fallback used when kitty's remote-control socket is unavailable. Keep
# the XTEST spelling behind the backend boundary so shared scenes remain
# display-server independent.
_xdo() { xdotool "$@"; }

# The window's pixel size and its origin on the root window. A themed capture
# insets the window, so the origin is not 0,0 and every pointer target has to add
# it back.
_be_window_px() {
	xdotool getwindowgeometry "${SCENE_WINDOW}" | sed -n 's/.*Geometry: \([0-9]*\)x\([0-9]*\)/\1 \2/p'
}
_be_window_origin() {
	xdotool getwindowgeometry "${SCENE_WINDOW}" | sed -n 's/.*Position: \([0-9]*\),\([0-9]*\).*/\1 \2/p'
}

# A key press, retried against whatever holds the focus when the window id has
# gone stale. kitty may map a second window during startup and retire the first,
# and every key after that dies of BadWindow -- which under `set -e` takes the
# recorder down with it, leaving a video that stops at the first keystroke. So a
# failure is reported and does not abort: a scene that loses one key is worth more
# than no recording.
_be_key() {
	xdotool key --clearmodifiers --window "${SCENE_WINDOW}" "$@" 2>/dev/null && return 0
	xdotool key --clearmodifiers "$@" 2>/dev/null && return 0
	echo "scene: key ${*} reached no window" >&2
	return 0
}

_be_pointer_at() {
	local loc
	loc="$(xdotool getmouselocation --shell)"
	printf '%s %s' \
		"$(printf '%s\n' "${loc}" | sed -n 's/^X=//p')" \
		"$(printf '%s\n' "${loc}" | sed -n 's/^Y=//p')"
}
_be_pointer_move() { xdotool mousemove --sync "$1" "$2"; }
_be_click() { xdotool click "${1:-1}"; }

# The whole screen, which is what ffmpeg is recording, so a still and the video
# frame at the same second are the same pixels.
_be_capture() { import -window root "$1"; }
