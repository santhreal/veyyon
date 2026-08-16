#!/usr/bin/env bash
# The pointer over the two cards that had no fade at all until this branch.
#
#   /model            the model picker. Its rows are painted by ModelBrowser,
#                     which is an inner list: it owns no repaint of its own, so
#                     its band fades only if the card lends it one, and nobody
#                     did. The same list is what the model hub and every model
#                     panel on the settings screen embed.
#   /mcp add a-server the add wizard's transport step. Its host hands the
#                     repaint to the CONSTRUCTOR rather than to a setter, which
#                     is the seam that was never wired: the card had a fade it
#                     could never build, so the row under the pointer switched.
#
# Jumps, not glides. A glide crosses every row in between and gives each one a
# frame or two, which hides the thing worth seeing: on a jump the row the
# pointer left is still fading out while the row it arrived on comes up. One
# glide at the end of the picker shows the other half, the band tracking a
# pointer that keeps moving.
#
# The rows below are measured off an earlier recording of this scene rather than
# assumed: the pointer helper maps a row through the grid the shell reports,
# which is three pixels a row short of what this terminal actually draws, so a
# row number here is the one that lands on the intended line and not the line's
# own index. The selected row is never hovered: it wears its own accent and is
# never banded, so a jump onto it shows a band leaving against nothing arriving.
#
# No stills -- `import` costs about fifteen seconds a frame on this display and
# would stall the middle of every motion. The page's stills are cut out of the
# recording afterwards.

settle 18

# --- the model picker ------------------------------------------------------
submit "/model"
settle 5

# Two rows three apart, jumped between, so the cross-fade carries two at once.
point 11 45
sleep 1.5
point 14 45
sleep 1.5
point 11 45
sleep 1.5
point 14 45
sleep 1.5
point 12 45
sleep 1.5

# Down the list one row at a time: the band tracks the pointer rather than
# appearing under it.
glide 11 45 14 45 12 0.10
sleep 1.5
glide 14 45 11 45 12 0.10
sleep 1.5
k Escape
settle 3

# --- the /mcp add wizard ---------------------------------------------------
# A name on the command line opens the wizard on its transport step. The step
# arrives about eight seconds after the command: the pointer waits for it,
# because a jump onto a card that is still on its name step proves nothing.
submit "/mcp add a-server"
settle 12
point 20 40
sleep 1.5
point 21 40
sleep 1.5
point 20 40
sleep 1.5
point 21 40
sleep 1.5
point 20 40
sleep 1.5

# main draws this step as a plain transcript block rather than a card, three rows
# lower and starting at the left edge. The pointer visits those rows as well, so
# the before arm's answer -- no band anywhere on either geometry -- is a
# measurement of main's own list and not a pointer that missed it.
point 26 20
sleep 1.2
point 27 20
sleep 1.2
point 26 20
sleep 1.2

k Escape
sleep 0.8
k Escape
settle 3
