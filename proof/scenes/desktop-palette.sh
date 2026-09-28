#!/usr/bin/env bash
# scene-terminal: native
# The command palette opened and filtered by a typed query.
#
#   proof/record.sh --pair proof/scenes/desktop-palette.sh
#
# Publishes desktop-palette-open.webp (the palette opening). After
# arm: OpenPalette and driver-typed text; before arm: Ctrl+K and typed keys.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_clip_begin open
pause 0.6
desk_action workspace::OpenPalette ctrl+k
desk_expect_target palette 10
pause 0.8
desk_clip_end
desk_type "settings"
desk_idle 10
shot palette
