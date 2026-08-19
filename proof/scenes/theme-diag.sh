#!/usr/bin/env bash
# Why a themed capture looks wrong, answered from inside the session it was taken
# in. A still tells you the window is flat; it cannot tell you whether the
# compositor refused to start, the wallpaper never landed, or the command under
# the terminal died before it painted anything.
set +e
settle 6
{
	echo "-- theme=${SCENE_THEME:-plain} opacity=${SCENE_OPACITY:-} bg=${SCENE_BG:-} geometry=${SCENE_WIDTH:-}x${SCENE_HEIGHT:-}"
	echo "-- compositor: $(xprop -root _NET_WM_CM_S0 2>&1 | head -1)"
	echo "-- ps:"
	ps -eo pid,args | grep -E "picom|kitty|xwallpaper|bun|node" | grep -v grep | head -10
	echo "-- picom.log:"
	tail -20 /tmp/picom.log 2>&1
	echo "-- wallpaper.log:"
	tail -10 /tmp/wallpaper.log 2>&1
	echo "-- term.log:"
	tail -40 /tmp/term.log 2>&1
	echo "-- backdrop:"
	ls -la /tmp/backdrop.png 2>&1
} >/out/theme-diag.txt 2>&1
settle 3
shot diag
