#!/usr/bin/env bash
# `/room new` beside a running answer, `→→` between the two, and `irc` across them.
#
# The claim under test is that a terminal holds two driving conversations side
# by side: each is a full session, the one left behind keeps running, and a
# switch is a full re-attach rather than a proxied view. A background session
# produces no pixels, so as in new-session-keeps-running.sh the transcripts
# testify across the round trip:
#
#   1. Session A is asked for a long list and starts streaming.
#   2. `/room new` lands WHILE A is streaming. The screen is a fresh session B,
#      the status line carries the `1 peer` chip, and the `/room` listing
#      stars B with A beside it.
#   3. B is asked for its own long list and starts streaming.
#   4. `→→` on the empty composer opens the strip with the cursor on A; Enter
#      switches. A's transcript has moved on, and the status line says it is
#      still running: the live object was re-attached.
#   5. `/room 2` switches back to B by ordinal, whose answer also moved on.
#   6. From B, the model is asked to `irc list`: the roster names A as a room
#      peer and states that `to: "all"` reaches B's own spawns only.
#
# Off arm (--before): the same take on the base branch, where `/room` is an
# unknown command and `→→` moves nothing: the frames after step 1 show the
# same session and no chip.
#
# Model and server setup are the ones new-session-keeps-running.sh describes:
# llama.cpp serving qwen2.5-1.5b on the recorder's docker network, `--no-tools`
# for steps 1 to 5. Step 6 needs the irc tool, so it runs with the tool set
# narrowed to `irc` (`--tools irc`), which keeps the prompt inside the window.
#
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts \
#     --model local/qwen2.5-1.5b --tools irc' \
#     PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     proof/docker/record-x11.sh proof/scenes/room-peers.sh

settle 18
shot idle

# Warm the prefix so the turns that matter start streaming immediately.
submit "hi"
settle_idle 200 6 2 20

# --- 1. A is answering ------------------------------------------------------
submit "write a numbered list of sixty short facts about terminal emulators, one line each"
sleep 6
shot a-streaming

# --- 2. /room new while A is answering --------------------------------------
slash "/room new"
expect_screen "Opened a peer conversation" 30
sleep 1
shot b-opened-beside-a
slash "/room"
expect_screen "Room (2)" 10
sleep 1
shot room-listing

# --- 3. B gets its own turn -------------------------------------------------
submit "write a numbered list of sixty short facts about text editors, one line each"
sleep 6
shot b-streaming

# --- 4. →→ Enter back to A, which kept going --------------------------------
clear_composer
k Right
pause 0.2
k Right
pause 0.5
shot strip-open
k Return
expect_screen "terminal emulators" 45
sleep 2
shot a-switched-still-live

# --- 5. /room 2 back to B by ordinal ----------------------------------------
slash "/room 2"
expect_screen "text editors" 45
sleep 2
shot b-switched-still-live

# --- 6. the peer is an irc peer ---------------------------------------------
settle_idle 300 6 2 20
submit "run the irc tool with op list and repeat its output verbatim"
expect_screen "room peer" 90
sleep 2
shot irc-lists-the-peer
