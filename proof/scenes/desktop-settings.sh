#!/usr/bin/env bash
# scene-terminal: native
# The settings view on its first page.
#
#   proof/record.sh --pair proof/scenes/desktop-settings.sh
#
# After arm: OpenSettings with no page. Before arm: Ctrl+, (OpenSettings).
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_action workspace::OpenSettings ctrl+comma
desk_expect_target settings 15
desk_park
shot settings
