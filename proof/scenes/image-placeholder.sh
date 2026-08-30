#!/usr/bin/env bash
# The row that stands in for a picture, in the withheld-content voice.
#
# Before: `[image not shown, images off (Show Inline Images)] shots/board.png ·
#         image/png · 1600x1000` -- a bracketed box row that named the media type
#         a second time, in a weight the block above it did not use.
# After:  `… image not shown · shots/board.png · 1600x1000 (images off, turn on
#         Show Inline Images in /settings)` -- the ellipsis, the facts and the
#         affordance last, the way every other surface holding content back says
#         it, and the remedy spelled the way the product spells one.
#
#   SCENE_MOTION_FLOOR=0 SCENE_IMAGE_TURN=1 \
#     SCENE_SETTINGS='terminal.showImages: false' \
#     proof/docker/record-x11.sh proof/scenes/image-placeholder.sh
#   PROOF_BASE_REF=<voice-commit>~1 <same knobs> \
#     proof/docker/record-x11-before.sh proof/scenes/image-placeholder.sh
#
# The terminal in this container speaks the kitty graphics protocol, so the cause
# under capture is the SETTING rather than the terminal: the seeded config turns
# inline images off, which is the one cause of the four an operator can undo and
# the only one whose row names a switch. The picture is a real file in the demo
# project, read by the real read tool; only the endpoint that decides to call it
# is a stub, because a 1.5B model asked to read an image calls something else.
#
# The floor is zero: one prompt, one tool call, one row, and the rest of the take
# is a still frame.

settle 18
shot idle

submit "Look at shots/board.png and tell me what is in it."

# The read runs under whatever approval mode the seeded profile has, so a prompt
# is answered rather than assumed absent.
approve_while_asked 40

# needle-source: image not shown -- imageFallback in packages/tui/src/terminal-capabilities.ts,
# drawn by ToolExecutionComponent for a picture the terminal will not show.
expect_screen "image not shown" 90 "the-turn-drew-no-placeholder-row"

# THE ARM SPLIT IS THE CLAIM: the bracketed row and the voiced row cannot both
# hold, so a take that recorded the other arm's spelling aborts instead of
# shipping a frame that proves nothing.
#
# needle-source: Show Inline Images in /settings -- IMAGE_FALLBACK_CAUSE in packages/tui/src/terminal-capabilities.ts, the after arm's remedy
# needle-source: [image not shown, -- the pre-voice spelling of the same row, which is what the before arm holds
if [ "${SCENE_ARM}" = "before" ]; then
	expect_screen "[image not shown," 20 "the-before-arm-did-not-hold-the-old-row"
else
	expect_screen "Show Inline Images in /settings" 20 "the-row-named-no-remedy"
fi

settle 3
shot placeholder
