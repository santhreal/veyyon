#!/usr/bin/env bash
# A real pointer over the settings screen. The sidebar rows are counted from the card's own
# top (8 = Appearance, 24 = Plugins), which holds at every width because the card is
# anchored and the category list does not reflow; the footer chips are found on the glass,
# because that strip does reflow.
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

# Across the footer chips, found on the glass. A counted column is a different chip at
# every width: at 78 cells the strip wraps and column 90 is off the card entirely, which
# published two identical hover frames.
read -r chip_row chip_col <<<"$(locate_text_in_row "navigate" "navigate")"
read -r last_row last_col <<<"$(locate_text_in_row "close" "close")"
point "${chip_row}" "${chip_col}"
settle 1
shot chip-hover-1
glide "${chip_row}" "${chip_col}" "${last_row}" "${last_col}" 26 0.05
shot chip-hover-2
settle 1
