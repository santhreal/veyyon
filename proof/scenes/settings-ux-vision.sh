#!/usr/bin/env bash
# Before-and-after visual proof for settings UX vision:
# 1. Agent roster layout with bounded list, wrapped authoring hint and navigation footer.
# 2. Settings search displaying dimmed '(unset)' for optional text settings and reserved scrollbar gutter.
# 3. Status line preview on Appearance tab adapting cleanly to pane width.

export SCENE_MOTION_FLOOR=0

settle 18
submit "/settings"
expect_screen "Settings" 60 settings-open
settle 2

# 1. Agent Roster: filter for Roster and open the roster submenu
t "roster"
settle 2
expect_screen "Roster" 30 roster-search
click_row_with "Roster" 60
settle 1
k Return
expect_screen "designer" 30 roster-open
settle 2
shot agent-roster

# Return from roster submenu to search list, then exit search mode
k Escape
settle 1
k Escape
settle 2

# 2. Settings Search: search for text settings that exhibit (unset) and scrollbar gutter
t "essential"
settle 2
expect_screen "Essential Tools Override" 30 search-unset
settle 2
shot unset-search

# Exit search mode to land on the settings tab
k Escape
settle 2

# 3. Appearance Tab: navigate to Appearance to show status line preview width adaptation
click_row_with "Appearance" 25
settle 2
expect_screen "Preview:" 30 appearance-open
settle 2
shot appearance-preview

# Close settings
k Escape
settle 2
