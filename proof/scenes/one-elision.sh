#!/usr/bin/env bash
# One elision, one character.
#
# Before: a row that had been cut wrote the mark three different ways. The
#         extension inspector's Origin row wrote `...` before the last segments
#         of a path it had shortened, the thinking fence wrote `...` after the
#         prose it hid, the diff renderer wrote `...` for a skipped hunk, and a
#         command's description was cut at sixty UTF-16 code units rather than
#         sixty cells, so a wide character pushed the row past its column.
# After:  every display row that has been cut carries one `…`, and the cut that
#         produced it is measured in cells.
#
# The surface is the extension inspector's Origin row, on a skill whose path is
# longer than the row's forty cells: the panel shortens the path to its last
# three segments and marks what it dropped. The row is two lines under the
# panel's title, so the frame is the panel as it opens -- no scrolling, no
# model, no network.
#
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_EXTENSION_PREVIEWS=1 \
#     proof/docker/record-x11.sh proof/scenes/one-elision.sh
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_EXTENSION_PREVIEWS=1 \
#     PROOF_BASE_REF=<the commit>~1 proof/docker/record-x11-before.sh proof/scenes/one-elision.sh
#
# The floor is zero because the take is still: one panel and a dozen keystrokes.
#
# The seeded skill sits at the ordinary place a native skill lives, under the
# profile's skills/ directory, and the panel reads it through the product's own
# discovery. Nothing about the row is faked here; the only thing seeded is a
# skill for the panel to open.

settle 18
shot idle

slash "/extensions"
# needle-source: Extension Control Center -- the dashboard title, from
# modes/components/extensions/extension-dashboard.ts.
expect_screen "Extension Control Center" 30 "the-extensions-panel-never-opened"
settle 4

# The list filters as you type, so the query is how a row is reached without
# knowing where the panel put it.
t "release-audit"
settle 3
# needle-source: Origin: -- the section label the inspector writes above the
# path it shortened, from modes/components/extensions/inspector-panel.ts. It is
# arm-invariant: both arms draw the label, and only the mark on the row under it
# changes.
expect_screen "Origin:" 20 "the-inspector-never-drew-the-origin-row"
shot origin

k Escape
settle 3
shot closed
