#!/usr/bin/env bash
# The pointer band inside the settings card, moved in jumps rather than a glide.
#
# A jump is where a cross-fade and a switch differ: the row the pointer left has
# to be still fading out while the row it arrived on comes up. A glide hides
# that, because the pointer crosses every row in between and each one only gets
# a frame or two.
#
# Two surfaces, one after the other: the setting rows in the pane (columns
# around 60) and the category sidebar (column 25). The scene takes no stills --
# `import` costs about fifteen seconds a frame on this display, which would put
# a stall in the middle of every motion. The page's stills are cut out of this
# recording afterwards, which is the same pixels and no stall.
#
# Grid at this window size: 133x37. Pane rows 9-21 are settings, sidebar rows
# 8-24 are categories, and row 9 (Dark Theme) is where the keyboard selection
# sits, so the scene hovers rows that are not it.
settle 18
submit "/settings"
settle 4

# Pane: two rows eight apart, jumped between three times.
point 11 60
sleep 1.5
point 19 60
sleep 1.5
point 11 60
sleep 1.5
point 19 60
sleep 1.5

# Sidebar: the same jump on the category column. Neither row is the active
# category -- the active one wears its own accent and never bands, so a jump
# that lands on it shows one band coming up against nothing going out.
point 10 25
sleep 1.5
point 18 25
sleep 1.5
point 10 25
sleep 1.5
point 18 25
sleep 1.5

# And a slow walk down it, so the recording also shows the band tracking a
# pointer that is moving rather than arriving.
glide 10 25 22 25 12 0.12
sleep 1.5

k Escape
sleep 2
