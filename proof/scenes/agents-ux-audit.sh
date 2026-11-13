#!/usr/bin/env bash
# Stills of every surface an operator meets when choosing, configuring or invoking a
# spawned agent: the Agents settings tab, settings search for "agent", the roster,
# two agents' pages, the /agents dashboard, the "@" completion popup, the
# magic-keyword highlight in the composer, and the "/agent" command completions.
#
#   proof/record.sh proof/scenes/agents-ux-audit.sh
#
# Guards wait on text the product prints for what the scene typed, never on a model
# choice. No shot needs a model turn.

export SCENE_MOTION_FLOOR=0

# Close the settings overlay, however many pages or search states deep it is, without
# letting a spare Escape reach an empty composer, where two in a row open the session
# tree. The overlay's close mark is on screen while any of its states is.
close_settings() {
	local n=0
	while [ "${n}" -lt 6 ] && visible_text | grep -qF "[x]"; do
		k Escape
		settle 1
		n=$((n + 1))
	done
}

settle 18
shot idle

submit "/settings"
expect_screen "search settings" 60 settings-open
settle 2

# The Agents category, reached the way the category list is walked: focus the
# list, step down to Agents (twelfth category), enter it.
k Left
settle 1
key_repeat Down 11 0.1
settle 1
k Right
settle 2
shot agents-tab
key_repeat Down 2 0.1
settle 1
shot roster-row
key_repeat Down 11 0.1
settle 1
k Return
settle 1
shot agents-advanced
close_settings

submit "/settings"
expect_screen "search settings" 60 settings-reopen
settle 2
t "agent"
settle 2
shot agent-search

close_settings
submit "/settings"
expect_screen "search settings" 60 settings-roster
settle 2
t "roster"
settle 2
k Return
expect_screen "HELPERS" 30 roster-page
settle 2
shot roster-page

k Return
expect_screen "Effort" 20 agent-page
settle 2
shot agent-page

k Escape
settle 1
key_repeat Down 4 0.1
settle 1
k Return
settle 2
shot second-agent-page
close_settings

slash "/agents"
settle 4
shot agents-dashboard
k Escape
settle 2

clear_composer
t "ask @"
settle 2
shot at-popup
t "rev"
settle 2
shot at-popup-filtered
k Escape
settle 1

clear_composer
t "ultrathink about the reviewer findings"
settle 2
shot magic-keyword
clear_composer
settle 1

t "/agent"
settle 2
shot slash-agent
k Escape
settle 1
clear_composer
settle 1
