#!/usr/bin/env bash
# Before-and-after differential for the workspace-search settings surface.
#
# The base arm shows the retired text and structure tool toggles. The branch arm
# shows canonical text-context controls and no search enable toggle: workspace
# search is part of the default inventory.
#
# Driven via the official HD recorder configuration:
#   OUT_DIR=proof/captures/x11/after \
#     proof/docker/record-x11.sh proof/scenes/settings-search.sh
#   OUT_DIR=proof/captures/x11/before \
#     proof/docker/record-x11-before.sh proof/scenes/settings-search.sh
#
# Grid at this window size: 133x37.

settle 18
submit "/settings"
settle 4
shot settings-open

# Search settings across the real overlay. The same query and pointer path show
# the tool-setting surface before and after the canonical default cutover.
t "search"
settle 2
shot search-pane

# Let the result list and pointer band settle before the proof frame.
glide 8 60 14 60 10 0.08
settle 2
shot search-settled

# Close overlay cleanly
k Escape
settle 2
shot settings-closed
