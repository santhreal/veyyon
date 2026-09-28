#!/usr/bin/env bash
# scene-terminal: native
# The terminal drawer open under the body with a shell that has run `ls -la`.
#
#   proof/record.sh --pair proof/scenes/desktop-drawer.sh
#
# After arm: ToggleDrawer; before arm: Ctrl+J (ToggleDrawer). Both arms type the command
# with keys into the focused terminal.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_action workspace::ToggleDrawer ctrl+j
desk_expect_target drawer 20
pause 2
xdotool type --delay 40 -- "ls -la" || abandon_take "drawer" "xdotool could not type"
desk_key Return
desk_settle 10
desk_park
shot drawer
