#!/usr/bin/env bash
# The row that stands in for a picture, in the withheld-content voice.
#
# Before: a read of a picture landed in the read group -- a list of file rows with
#         no picture in it and no row standing in for one -- so the turn showed
#         `Read shots/board.png` and nothing else: no picture with images on, no
#         reason with them off.
# After:  the read reaches a block that owns both, and with images off the block
#         says `… image not shown · shots/board.png · 1600x1000 (images off, turn
#         on Show Inline Images in /settings)` -- the ellipsis, the facts and the
#         affordance last, the way every other surface holding content back says
#         it, and the remedy spelled the way the product spells one.
#
#   SCENE_MOTION_FLOOR=0 SCENE_IMAGE_TURN=1 \
#     SCENE_SETTINGS=terminal.showImages:\ false \
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

# needle-source: That is the dashboard mock-up. -- TOOL_REPLY in proof/docker/stub-tool-llm.ts, the reply that ends the turn
expect_screen "That is the dashboard mock-up." 90 "the-turn-never-finished"

# THE ARM SPLIT IS THE CLAIM. Before, a read of a picture went into the read
# group, which is a list of file rows with no picture in it and no row standing in
# for one, so the turn showed the file name and nothing else. After, the read
# reaches a block that owns both, and the block says what is missing and why. The
# two cannot hold at once, so a take that recorded the other arm aborts instead of
# shipping a frame that proves nothing.
#
# needle-source: image not shown -- imageFallback in packages/tui/src/terminal-capabilities.ts, drawn by ToolExecutionComponent for a picture the terminal will not show
# needle-source: Show Inline Images in /settings -- IMAGE_FALLBACK_CAUSE in packages/tui/src/terminal-capabilities.ts, the remedy the after arm carries
if [ "${SCENE_ARM}" = "before" ]; then
	if screen_has "image not shown"; then
		abandon_take "the-before-arm-already-had-the-row" "the picture read reached a block that explains itself, so this is not the before state"
	fi
else
	expect_screen "image not shown" 20 "the-turn-drew-no-placeholder-row"
	expect_screen "Show Inline Images in /settings" 20 "the-row-named-no-remedy"
fi

settle 3
shot placeholder
