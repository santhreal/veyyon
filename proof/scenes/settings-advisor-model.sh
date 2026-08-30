#!/usr/bin/env bash
# Before-and-after differential for where the advisor's model is asked for.
#
# Both arms run with the advisor on, because the row is conditional and an arm
# with the feature off shows nothing either way. Before: the Advisor group has a
# toggle and three behaviour knobs, and the model lives in the generic Roles
# table under "Advisor". After: an "Advisor Model" row sits directly under
# Enable Advisor, and the Roles table no longer lists the advisor.
#
#   SCENE_SETTINGS='advisor.enabled: true' OUT_DIR=proof/captures/x11/before \
#     proof/docker/record-x11-before.sh proof/scenes/settings-advisor-model.sh
#   SCENE_SETTINGS='advisor.enabled: true' OUT_DIR=proof/captures/x11 \
#     proof/docker/record-x11.sh proof/scenes/settings-advisor-model.sh
settle 18
submit "/settings"
expect_screen "Settings" 60 settings-open
settle 2
shot settings-open

# The Advisor group. Before this change the search returns the toggle and the
# three behaviour knobs and no model row at all.
t "advisor"
settle 2
expect_screen "Enable Advisor" 30 advisor-search
shot advisor-search

# The Roles table, which is where the advisor's model used to be asked for.
#
# A click in the search pane moves the cursor and nothing else, so the row is
# opened by Return. Exactly one: search mode routes Return to the result list as
# an activation, so a second one opens the model picker for whichever role sits
# first and photographs that instead. The guard is a role both arms list, so a
# take that stopped short of the table ends. What the pair compares is whether
# Advisor is one of the rows inside.
k ctrl+u
settle 1
t "role"
settle 2
expect_screen "Role Models" 30 roles-search
click_row_with "Role Models" 60
settle 1
k Return
expect_screen "Architect" 20 roles-table
settle 2
shot roles-table

k Escape
settle 1
k Escape
settle 1
k Escape
settle 2
shot settings-closed
