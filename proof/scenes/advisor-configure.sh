#!/usr/bin/env bash
# The `/advisor configure` overlay: the roster list, the preview of the selected
# advisor, and the footer.
#
# Needs SCENE_SEED_ADVISORS=1, which copies a four-entry WATCHDOG.yml into the
# demo repo before veyyon starts. The overlay reads that file, so the frame shows
# a real roster rather than the empty state a fresh checkout opens on.
#
# No model turn is spent: `/advisor configure` opens a UI and returns.

settle 20

slash "/advisor configure"
settle 5
shot roster

# Move down the roster, so the preview pane changes with the selection rather
# than showing one entry for the whole take.
key_repeat Down 2 0.4
settle 2
shot roster-selected

k Escape
settle 3
shot closed
