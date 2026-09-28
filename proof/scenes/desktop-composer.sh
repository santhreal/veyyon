#!/usr/bin/env bash
# scene-terminal: native
# The composer holding a draft that grows over four lines, with its footer (the
# model chip and the controls beside it) under the draft.
#
#   proof/record.sh --pair proof/scenes/desktop-composer.sh
#
# The after arm sets each longer draft through InsertText; the before arm types
# each line and presses Shift+Return between them.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_new_thread
desk_draft "Rename the queue reducer's revision field to generation.
Keep the wire name unchanged so older hosts still decode it.
Update the three call sites in the sidebar and the run bar.
Then run the reducer tests and report what changed." 0.8
desk_idle 10
desk_park
shot composer
