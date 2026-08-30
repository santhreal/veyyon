#!/usr/bin/env bash
# One wait, in one voice.
#
# Before: a row that said the product was working spelled the wait with three
#         ASCII periods on one surface and with an ellipsis on the next. The MCP
#         connect row read `Connecting to "slow-notes"...`, the row after it
#         `"slow-notes" is still connecting...`, and the loader two commands
#         later `Running… (esc to cancel)` -- one product, two characters for
#         one fact.
# After:  every one of them is the product one waiting row: the subject, one
#         ellipsis, and the chord that stops it in the single spelling the owner
#         holds.
#
# WHY AN MCP SERVER. A wait has to outlast a frame to be photographed, and every
# other wait in the product either needs a provider or is over in milliseconds: a
# compaction needs a dozen real turns first, a share needs the network, a model
# download needs weights. A stdio MCP transport is a process the product spawns,
# so a command that sleeps is a handshake that never arrives, and the connecting
# row holds the screen for the ten seconds the product waits before it reports
# the server as still connecting.
#
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_MCP_SERVER=1 \
#     proof/docker/record-x11.sh proof/scenes/waiting-row.sh
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_MCP_SERVER=1 \
#     PROOF_BASE_REF=<the commit>~1 proof/docker/record-x11-before.sh proof/scenes/waiting-row.sh
#
# The floor is zero because the take is a still: two commands and one wait. The
# spinner beside the row does move, and the row states the wait in text either
# way, which is the point -- a still is enough to read the spelling.
#
# No model and no network: the transport is a local process and the rows are
# drawn from the product own connection state.

settle 18
shot idle

# --- the animated connect row ------------------------------------------------
#
# The seeded server is disabled, so enabling it is what starts the connect.
# needle-source: Connecting to -- McpConnectingBlock, from
# modes/controllers/mcp-command-controller.ts.
slash "/mcp enable slow-notes"
expect_screen "Connecting to" 30 "the-connect-row-never-appeared"
settle 2
shot connecting

# The product waits ten seconds for the handshake, then says the server is still
# connecting rather than claiming a failure it has not established.
# needle-source: is still connecting -- the same controller, the connecting arm
# of the status it sets when the wait times out.
expect_screen "is still connecting" 40 "the-still-connecting-row-never-appeared"
settle 3
shot still-connecting

# --- the same voice on a second surface --------------------------------------
#
# needle-source: Testing connection to -- the /mcp test path in the same
# controller, which is the one waiting row in the product that names the chord
# that stops it.
slash "/mcp test slow-notes"
expect_screen "Testing connection to" 30 "the-testing-row-never-appeared"
settle 2
shot testing

# --- the chord the row names --------------------------------------------------
#
# The testing row is the one wait that states what stops it, so the take ends by
# pressing that chord. The frame after it differs from the frame before only if
# esc really cancels the test, and a shot identical to the one before it is
# abandoned by the recorder, so this frame is also the check on the hint.
k Escape
settle 4
shot cancelled
