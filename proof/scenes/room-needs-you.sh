#!/usr/bin/env bash
# A question from a conversation that is off screen waits for it.
#
# The claim under test is that a conversation asking for approval while another
# one is on screen does not open its card over the one being read. The card
# waits; the room marks who is waiting on the status line and in its view; going into
# that conversation shows the card:
#
#   1. `/room new` opens conversation 2, which is asked to run a shell command.
#   2. `alt+,` goes back to conversation 1 before the model answers.
#   3. The model calls `bash`, which `ask-command` holds for approval. The card
#      is held: the status line says conversation 2 needs you and which key
#      opens the room, and the room chip counts it.
#   4. `alt+w` opens the room view: the title and the pager mark window 2, and
#      `→` brings it to the front, where it says `needs you` on its edge and
#      `waiting for your answer` at its foot.
#   5. Enter goes into conversation 2, and its approval card is on screen there.
#
# Off arm (--before): the base branch has no room, so `/room` is an unknown
# command, the prompt runs in the one conversation, and its card opens at once.
# That arm stops at `held-off-screen`: the room shots after it would photograph
# the same card again.
#
# Model: llama.cpp serving qwen2.5-1.5b on the recorder's network (see
# `new-session-keeps-running.sh` for the sidecar). The session carries only the
# `bash` tool, so the schemas fit the window and the one call it can make is the
# one that asks.
#
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b --tools bash --approval-mode ask-command' \
#     SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/room-needs-you.sh
#
# The take is a held dialog and a waiting model, still by design, so it records
# with the motion floor off.

after() { [ "${SCENE_ARM:-after}" = "after" ]; }

settle 18
shot idle

# Warm the prefix so the turn that matters starts at once.
submit "hi"
settle_idle 200 6 2 20

# --- 1. conversation 2 is asked to run a command ----------------------------
clear_composer
t "/room new"
pause 0.7
k Return
# needle-source: Switched to -- room-controller.ts #announce states the member it landed on
expect_screen "$(arm_key 'Switched to' 'Unknown command')" 60 "room-new"
sleep 1
submit "Use the bash tool to run this exact command: ls -la"
pause 1.5

# --- 2. back to conversation 1 before the call arrives ----------------------
after && k alt+comma
pause 1
# A fast model asks before this frame, and then this frame is the next one;
# the recorder refuses two identical shots, so the earlier one is left out.
if ! after || ! screen_has "needs you"; then shot left-for-one; fi

# --- 3. the call is held, and the status line says who is waiting -----------
# needle-source: needs you -- room-controller.ts #onWaitingChange names the waiting member
after && expect_screen "needs you" 180 "held"
pause 1
shot held-off-screen

# --- 4. the room view marks the waiting window ------------------------------
after && k alt+w
# needle-source: 2 conversations -- room-stage.ts #paintChrome counts the room on its title row
after && expect_screen "2 conversations" 15
# The first room view in a profile opens with its guide; a key takes it away.
# needle-source: any key closes this -- room-guide.ts paintRoomGuide's last line
after && expect_screen "any key closes this" 10
after && k Escape
pause 1
after && shot room-opened
# Bring window 2 to the front: wide enough to say it in words.
after && k Right
# needle-source: waiting for your answer -- room-window.ts paints it at the foot of a waiting window
after && expect_screen "waiting for your answer" 15
pause 1
after && shot room-needs-you

# --- 5. going into it shows the card ----------------------------------------
after && k Return
# needle-source: Permission required -- the approval card's title
expect_screen "Permission required" 60 "card"
sleep 1.5
if after; then shot card-on-arrival; fi
