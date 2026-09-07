#!/usr/bin/env bash
# Before-and-after differential for the settings register.
#
# Before: the idle rows sit in separate "Park" and "Prune" groups, the toggle is
# "Prune Parked Subagents", and each description opens with why the setting
# exists and what it used to do.
# After: one "Idle Agents" group, "Prune Parked Agents", and every description is
# one to three sentences stating what the setting does and what each value
# selects.
#
#   PROOF_BASE_REF=plugin-main-integration proof/record.sh --pair proof/scenes/settings-register.sh
#
# Guarded on text the SETTINGS SCREEN prints for what the scene typed, never on a
# model choice, so a miss is a defect in the build rather than a slow turn. Every
# frame is a still of a settings pane, so the motion floor is off.
export SCENE_MOTION_FLOOR=0

settle 18
submit "/settings"
expect_screen "Settings" 60 settings-open
settle 2
shot settings-open

# The search pane lists every prune row with its group heading. "Prune After" is
# the label both arms print.
t "prune"
settle 2
expect_screen "Prune After" 30 prune-search
shot prune-search

# Land on the toggle in its own tab: a click in the search pane moves the cursor
# and Escape leaves search on the selected row (settings-selector.ts
# `#endSearch`). Right expands that row's description, which is the text the
# register rewrote.
click_row_with "Prune Parked" 60
settle 1
k Escape
settle 1
k Right
settle 2
shot prune-description

k Escape
settle 2
shot settings-closed
