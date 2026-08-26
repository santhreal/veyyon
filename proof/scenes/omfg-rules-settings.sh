#!/usr/bin/env bash
# The TTSR rules list with its User created section leading.
#
# Opens Settings, filters to the Rules category by search, walks the selection
# up to the All Rules row, and opens the section index, where the profile's own
# rules lead under "User created".
#
# Frames:
#   rules-search    the settings screen filtered to the Rules category
#   on-all-rules    the selection resting on the All Rules row
#   rules-sections  the section index
#   user-created    inside User created: the profile's own rules, each on/off
settle 20
submit "/settings"
settle 4

# Search rather than count sidebar rows: the category order is a display fact
# that moves as groups are added, and the search lands on the category by name.
# The filtered pane keeps the cursor on its last selection, four rows below
# All Rules in this category, so walk it up and open.
k "/"
pause 0.4
t "Rules"
settle 2
shot rules-search

key_repeat Up 4
settle 1
shot on-all-rules

k Return
settle 3
expect_screen "Rules by section" 30
shot rules-sections

# The section this screen exists to show. A tree without it still records the
# index, which is exactly the before arm of the pair.
if screen_has "User created"; then
	k Return
	settle 2
	shot user-created
fi
