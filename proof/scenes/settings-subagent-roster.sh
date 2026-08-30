#!/usr/bin/env bash
# Before-and-after differential for where a subagent's model is asked for.
#
# Before: the Subagents tab carries a "Subagent Roster" row plus standalone
# "Subagent Model" and "Subagent Effort" rows, three surfaces for one value.
# After: one "Roster" row, and inside it a "Same Model for All Agents" toggle
# that reveals the shared Model and Effort pair and greys the per-agent lanes.
#
#   OUT_DIR=proof/captures/x11/before \
#     proof/docker/record-x11-before.sh proof/scenes/settings-subagent-roster.sh
#   OUT_DIR=proof/captures/x11 \
#     proof/docker/record-x11.sh proof/scenes/settings-subagent-roster.sh
#
# Guarded on text the SETTINGS SCREEN prints for what the scene typed, never on a
# model choice, so a miss is a defect in the build rather than a slow turn.
settle 18
submit "/settings"
expect_screen "Settings" 60 settings-open
settle 2
shot settings-open

# The search pane is the frame that shows how many rows own this one value. The
# needle is the half both arms print: "Subagent Roster" before, "Roster" after.
t "subagent"
settle 2
expect_screen "Roster" 30 subagent-search
shot subagent-search

# Into the roster page itself. Before: straight to the agent list. After: the
# shared toggle heads it.
#
# A click in the search pane moves the cursor and nothing else, so the row is
# opened by Return. Exactly one: search mode routes Return to the result list as
# an activation (settings-selector.ts `#handleSearchModeInput`), so a second one
# activates the first row INSIDE the page and photographs a model picker. The
# guard is an agent id, which both arms list, so a take that stopped short of
# the page ends instead of photographing the search pane twice.
click_row_with "Roster" 60
settle 1
k Return
expect_screen "designer" 20 roster-page
settle 2
shot roster-page

k Escape
settle 1
k Escape
settle 2
shot settings-closed
