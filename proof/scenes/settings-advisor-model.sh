#!/usr/bin/env bash
# Before-and-after differential for where the advisor's model is asked for.
#
# Both arms run with the advisor on, because the row is conditional and an arm
# with the feature off shows nothing either way. Before: the Advisor group has a
# toggle and three behaviour knobs and no model row at all, and the model is a
# row in the generic Roles table under "Advisor". After: an "Advisor Model" row
# sits directly under Enable Advisor.
#
# The Roles table itself is not photographed here, and cannot be from this
# profile. A settings row whose value came from the config file or a runtime
# override is rebuilt read-only with `submenu: undefined`
# (settings-selector.ts `#defToItem`), and the recording session assigns a model
# role at runtime, so Role Models reads "runtime override · all inherit" and
# Enter does not open it. That the advisor is gone from the table is pinned by
# test/modes/components/advisor-model-has-one-owner.test.ts instead.
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

# Esc clears the search, Esc closes the card.
k Escape
settle 1
k Escape
settle 2
shot settings-closed
