#!/usr/bin/env bash
# Before-and-after differential for the idle-agent settings.
#
# Before: the "Idle Agents" group holds "Park Idle Agents After" beside three
# prune rows ("Prune Parked Agents", "Prune After", "Prune Waiting After").
# After: the group holds "Sleep Idle Agents After" alone, with options Never and
# 1, 5, 15 and 30 minutes; nothing prunes an agent.
#
#   proof/record.sh --pair proof/scenes/settings-register.sh
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

# The search pane lists every idle-agent row under its group heading. "Idle
# Agents After" is the end of the timer label both arms print.
t "idle agents"
settle 2
expect_screen "Idle Agents After" 30 idle-search
shot idle-search

# Land on the timer row in its own tab: a click in the search pane moves the
# cursor and Escape leaves search on the selected row (settings-selector.ts
# `#endSearch`). Right expands that row's description.
click_row_with "Idle Agents After" 60
settle 1
k Escape
settle 1
k Right
settle 2
shot idle-description

k Escape
settle 2
shot settings-closed
