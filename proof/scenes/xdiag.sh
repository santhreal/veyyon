#!/usr/bin/env bash
set +e
settle 3
{
  echo "SCENE_WINDOW=${SCENE_WINDOW}"
  echo "-- ps:"; ps -eo pid,args | grep -E "kitty|xterm|sleep" | grep -v grep | head -5
  echo "-- children:"; xwininfo -root -children 2>&1 | sed -n '4,14p'
  xdotool mousemove --sync 700 400; sleep 0.5
  echo "-- loc: $(xdotool getmouselocation)"
} > /out/xdiag.txt 2>&1
settle 3
