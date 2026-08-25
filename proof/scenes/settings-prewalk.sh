#!/usr/bin/env bash
# The Prewalk group: the dependent model rows exist only while the feature is on.
#
# Opens Settings and searches for the Prewalk row. The off arm of the
# differential shows only the Enable Prewalk toggle; with `prewalk.enabled: true`
# seeded through SCENE_SETTINGS, the Prewalk Cheap Model and Prewalk Strong Model
# rows appear under it. The on arm seeds a cheap target too: prewalk enabled
# without `prewalk.cheapModel` fails the launch, so the arm seeds the recorder's
# local model as the target.
#
# Frames:
#   prewalk-search   the settings search filtered to the Prewalk rows, with
#                    each arm's values in effect
#
# The scene stops at the filtered list. Pressing Return here opens the row
# under the cursor — a boolean row's editor TOGGLES it — so the frame after
# Return shows a state the arm's seeding did not set.
settle 20
submit "/settings"
settle 4

# Search rather than count sidebar rows: the category order is a display fact
# that moves as groups are added, and the search lands on the row by name.
k "/"
pause 0.4
t "Prewalk"
settle 2
expect_screen "match" 30
shot prewalk-search
