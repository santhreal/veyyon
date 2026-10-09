#!/usr/bin/env bash
# The Composer Predictions settings on a profile with no OpenAI Codex login.
#
# Opens Settings, filters to the Composer Predictions group by search, and opens
# the selected row's submenu. The recording profile holds no Codex login, so the
# ChatGPT Pro included mode can request nothing: the mode row reads
# "Off (no ChatGPT Pro account)", and in the mode submenu "ChatGPT Pro included"
# is greyed out with the connect hint, beside "Off" and "Custom (choose model)".
#
#   proof/record.sh --pair proof/scenes/composer-predictions-mode.sh
#
# The before arm holds the tree at the commit before the three modes
# (PROOF_BASE_REF=39ecc20e8e), where the group is an on/off toggle and a source.
#
# Frames:
#   predictions-search  the settings screen filtered to Composer Predictions
#   predictions-menu    the selected row's submenu
#   predictions-menu-off  the submenu with the cursor moved off the first row
settle 18
submit "/settings"
expect_screen "Settings" 60 settings-open
settle 2

k "/"
pause 0.4
t "Composer Predictions"
settle 2
expect_screen "Composer Predictions" 30 predictions-search
shot predictions-search

k Return
settle 2
shot predictions-menu

k Down
settle 1
shot predictions-menu-off

k Escape
settle 1
k Escape
settle 1
k Escape
settle 2
shot settings-closed
