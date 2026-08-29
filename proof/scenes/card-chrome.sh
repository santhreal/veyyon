#!/usr/bin/env bash
# The floating cards whose chrome this branch changed, in one take.
#
#   /session          a two-row subcommand picker. It is the card that showed the
#                     defect worst: a fixed share of the terminal around two rows
#                     of content, so most of the frame was empty and read as a
#                     list that had failed to load.
#   /account          nine rows, one of them long (`use <provider> <account>`), so
#                     the same card sizes to a WIDE body from the same rule.
#   /account manager  the account manager: a full card with a sidebar rule, a
#                     pointer band across its rows, and a footer of ten chips
#                     that packs into more than one row at this width.
#   ctrl+s            the manager's search, which had no field of its own.
#   /agents           the subagent dashboard's card chrome. Its roster band is
#                     not photographed here: a session with no subagents has no
#                     roster row to hover, so the two frames came out
#                     byte-identical and the take said so. The band is pinned by
#                     test/modes/components/a-pointer-band-arrives-instead-of-switching.ts
#                     instead, which drives the real dashboard with a registered
#                     agent.
#
# Nothing here needs a model: every surface is opened by a slash command and
# every guard is a string the product itself prints, so the take is decided by
# the build and not by what a model chose to say.
#
# Every guard is a string that survives the narrowest width this scene records.
# A guard on a row's DESCRIPTION does not: at 80 columns the pre-change list
# pinned its label column to 22 cells and cut the description to ten, so
# `Show session info and stats` never printed and the before arm of the width
# matrix abandoned at its first guard while the after arm walked on. A row label
# and the pane's empty-state prefix are on screen in both builds at every width,
# which is what a paired matrix needs.
#
# Every command goes through `slash`, which dismisses the completion popup before
# Return. `submit` loses a command with a subcommand: the popup owns Return while
# it is open, so `/account manager` was accepted into the composer as a row
# instead of being run, and the manager guard waited out its ceiling on a screen
# that had never opened it.
#
# Recorded as a pair:
#   SCENE_MOTION_FLOOR=2 proof/docker/record-x11.sh proof/scenes/card-chrome.sh
#   SCENE_MOTION_FLOOR=2 proof/docker/record-x11-before.sh proof/scenes/card-chrome.sh
#
# The floor is lowered because this scene is deliberately still: it holds each
# card long enough to photograph it, so the take carries far less change per
# second than a streaming session and the default gate reads that as a stutter.
#
# Grid at this window size: 133x37.

settle 18

# --- /session: the small card ----------------------------------------------
slash "/session"
expect_screen "delete" 30 session-picker
settle 3
shot session-picker

# The pointer onto the row the selection is not on, so the band arrives rather
# than switching. Jumped, not glided: a jump is what showed the old switch.
point 13 40
sleep 1.2
shot session-hover
k Escape
settle 2

# --- /account: the same rule against a wide body ---------------------------
slash "/account"
expect_screen "logout" 30 account-picker
settle 3
shot account-picker
point 14 40
sleep 1.2
shot account-hover
k Escape
settle 2

# --- the account manager: sidebar rule, band, packed footer ----------------
slash "/account manager"
expect_screen "No accounts stored for this" 30 account-manager
settle 4
shot manager-open

glide 10 30 14 30 12 0.08
sleep 1.2
shot manager-hover

# The manager's search. It differed from idle by one faint line before this
# branch, so the frame is the evidence that it now has a field of its own.
k ctrl+s
settle 2
shot manager-search
t "ant"
settle 2
shot manager-search-typed
k Escape
settle 1
k Escape
settle 2

# --- /agents: the dashboard's own chrome ------------------------------------
slash "/agents"
expect_screen "Subagent Dashboard" 30 agents-dashboard
settle 4
shot agents-open
k Escape
settle 2
