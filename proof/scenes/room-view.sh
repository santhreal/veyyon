#!/usr/bin/env bash
# The room view: every conversation in one terminal as a window, and the motion
# between them and the screen.
#
# The claim under test is that a terminal holds several driving conversations
# side by side, that the room view shows each one live (its prompt, its tool
# rows, its state) while the one left behind keeps running, and that moving
# between them is a zoom and a slide rather than a cut:
#
#   1. Conversation 1 is asked for a long list and starts streaming.
#   2. `/room new` opens conversation 2 beside it; the screen slides to it, the
#      arrival line names the key that shows every conversation, and the status
#      line carries the `1 peer` chip with `1 working`.
#   3. Conversation 2 gets its own long list.
#   4. `→→` on the empty composer opens the room view side by side: the screen
#      pulls back into window 2 with window 1 receding to its left, both
#      streaming.
#   5. `←` glides the row to window 1; Tab flips to all windows; Tab back.
#   6. Enter zooms into conversation 1, with its answer so far on screen at once.
#   7. alt+. is the quick switch: pull back, slide, push in to 2.
#   8. `→→` opens the view again, and `n` opens conversation 3 from it and
#      zooms into it.
#
# Off arm (--before): the same keys on the base branch, where `/room` is an
# unknown command and `→→` moves nothing. Each guard is written for the arm it
# runs in, so both arms reach every shot and a frame keeps one name across the
# pair.
#
# Model: llama.cpp serving qwen2.5-1.5b on the recorder's docker network, the
# seed's `local` provider. Tools are off so the lists stream as prose.
#
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b --no-tools' \
#     PROOF_HOST_REPO_TARGET=/mnt/c/Users/<you>/<checkout> \
#     proof/record.sh proof/scenes/room-view.sh

after() { [ "${SCENE_ARM:-after}" = "after" ]; }

settle 18
shot idle

# Warm the prefix so the turns that matter start streaming at once.
submit "hi"
settle_idle 200 6 2 20

# --- 1. conversation 1 is answering -----------------------------------------
submit "write a numbered list of forty short facts about terminal emulators, one line each"
sleep 5
shot one-streaming

# --- 2. /room new slides to conversation 2 ----------------------------------
# Typed and entered directly: `slash` dismisses the completion popup with Escape,
# and Escape over a streaming turn is the interrupt, which would stop the very
# conversation this step claims keeps running.
clear_composer
t "/room new"
pause 0.7
k Return
# needle-source: Switched to -- room-controller.ts #land states the member it landed on
expect_screen "$(arm_key 'Switched to' 'Unknown command')" 60 "room-new"
sleep 1
shot two-opened

# --- 3. conversation 2 answers too ------------------------------------------
submit "write a numbered list of forty short facts about text editors, one line each"
sleep 5
shot two-streaming

# --- 4. →→ opens the room view ----------------------------------------------
clear_composer
k Right
pause 0.25
k Right
# needle-source: side by side -- room-stage.ts #paintChrome names the layout on the title row
after && expect_screen "side by side" 10
pause 0.8
shot room-side-by-side

# --- 5. glide, then the grid and back ---------------------------------------
k Left
pause 0.9
shot room-glided
k Tab
# needle-source: all windows -- the title row's layout name after Tab
after && expect_screen "all windows" 10
pause 0.9
shot room-all-windows
k Tab
pause 0.9

# --- 6. Enter zooms into conversation 1 -------------------------------------
k Return
after && expect_screen "terminal emulators" 30
sleep 1.5
shot entered-one

# --- 7. the quick switch ------------------------------------------------------
k alt+period
after && expect_screen "text editors" 30
sleep 1.5
shot quick-switched

# --- 8. a third conversation from the view ----------------------------------
# Keys, not the room chip: a footline click reaches the terminal only with
# `tui.scrollIsolation` on, and this scene records the defaults.
clear_composer
k Right
pause 0.25
k Right
pause 1
k n
# needle-source: Now on -- room-controller.ts #announce after entering a member from the overview
after && expect_screen "Now on" 60
sleep 1.5
shot three-opened
