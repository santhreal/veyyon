#!/usr/bin/env bash
# A real pointer over the settings screen. The card is drawn on a 133x37 grid at
# this window size, so the rows below are the sidebar (8 = Appearance, 24 =
# Plugins) and the footer chip row (32).
settle 20
submit "/settings"
settle 4
shot open

# Down the sidebar one row at a time, so the recording shows the band tracking
# the pointer instead of appearing under it.
glide 8 25 18 25 22 0.07
shot sidebar-hover
click
settle 1
shot sidebar-click
glide 18 25 23 25 12 0.07
shot sidebar-hover-low

# Across the footer chips.
point 32 40
settle 1
shot chip-hover-1
glide 32 40 32 90 26 0.05
shot chip-hover-2
settle 1
