#!/usr/bin/env bash
# The Prewalk group: the dependent model rows exist only while the feature is on.
#
# Opens Settings and searches for the Prewalk row. The off arm of the
# differential shows only the Enable Prewalk toggle; with `prewalk.enabled: true`
# seeded through SCENE_SETTINGS, the Prewalk Cheap Model and Prewalk Strong Model
# rows appear under it.
#
# Frames:
#   prewalk-search   the settings search filtered to the Prewalk row
#   prewalk-group    the Prewalk group at this window size
settle 20
submit "/settings"
settle 4

# Search rather than count sidebar rows: the category order is a display fact
# that moves as groups are added, and the search lands on the row by name.
k "/"
pause 0.4
t "Prewalk"
settle 2
shot prewalk-search

k Return
settle 3
expect_screen "Prewalk" 30
shot prewalk-group
