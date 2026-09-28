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
# The clip starts at the chord on a window that draws nothing, so the only
# frames in it are the palette's: a still window split by an idle redraw reads
# as slow motion to the cadence check.
desk_settle 20 3 1
desk_clip_begin open
desk_action workspace::OpenPalette ctrl+k
desk_expect_target palette 10
pause 0.8
desk_clip_end
desk_type "settings"
desk_idle 10
shot palette
