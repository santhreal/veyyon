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
#      streaming. This first open shows the room guide over the dimmed windows;
#      Escape takes it away.
#   5. `←` glides the row to window 1; Tab flips to all windows; Tab back.
#   6. Enter zooms into conversation 1, with its answer so far on screen at once,
#      and a follow-up is typed there and left unsent.
#   7. alt+. is the quick switch: pull back, slide, push in to 2. The unsent
#      text stays with conversation 1.
#   8. `→→` opens the view again; `←` shows window 1 carrying its draft at its
#      foot, and `n` opens conversation 3 from the view and zooms into it.
#   9. Conversation 3 is asked a short question and left at once with alt+, ;
#      its turn ends off screen and the status line says it finished, naming
#      it and the key that opens the room; the room chip counts it unread.
#  10. `→→` opens the view: the title counts it unread and the ordinal under
#      window 3 carries how its turn ended.
#  11. `r` names window 2: the line holds the name the title model gave it,
#      selected, and what is typed replaces it; Enter writes it on the edge.
#  12. Esc goes back to conversation 3, and `/room say` posts to `#room`: every
#      conversation takes the line, this transcript shows its `#room` card and
#      the status line says it was posted.
#  13. `→→` opens the view with the post under its title.
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

# --- 4. →→ opens the room view, with its guide the first time ---------------
clear_composer
k Right
pause 0.25
k Right
# needle-source: side by side -- room-stage.ts #paintChrome names the layout on the title row
after && expect_screen "side by side" 10
# needle-source: any key closes this -- room-guide.ts paintRoomGuide's last line
after && expect_screen "any key closes this" 10
pause 0.8
shot room-guide
after && k Escape
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
t "now compare these with the text editor facts"
pause 0.8

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
k Left
# needle-source: compare these -- typed in step 6; room-window.ts draftRow writes the kept draft at window 1's foot
after && expect_screen "compare these" 10
pause 0.9
shot room-draft-kept
k n
# needle-source: Now on -- room-controller.ts #announce after entering a member from the overview
after && expect_screen "Now on" 60
sleep 1.5
shot three-opened

# --- 9. a turn that ends off screen says so ---------------------------------
submit "name three terminal multiplexers, one line each"
pause 0.5
after && k alt+comma
# needle-source: finished — -- room-controller.ts #onTurnEnd states a turn that ended off screen
after && expect_screen "finished —" 120
sleep 1
shot finished-off-screen

# --- 10. the room keeps it unread until it is entered -----------------------
clear_composer
k Right
pause 0.25
k Right
after && expect_screen "side by side" 10
pause 0.9
shot room-unread

# --- 11. r names the selected conversation -----------------------------------
# The title model's name for a conversation is its answer's first line; `r`
# holds that name selected, and what is typed replaces it.
k r
# needle-source: Name conversation -- room-stage.ts #paintChrome's naming line
after && expect_screen "Name conversation" 10
pause 0.9
shot room-naming
t "text editor facts"
if after; then k Return; else clear_composer; fi
# needle-source: 2  text editor facts -- typed in step 11; room-window.ts titleLabel writes the ordinal and the name on the window's top edge
after && expect_screen "2  text editor facts" 10
pause 0.9
shot room-named

# --- 12. /room say posts to every conversation --------------------------------
after && k Escape
sleep 1
clear_composer
t "/room say the text editor list is final, keep it as it is"
pause 0.7
k Return
# needle-source: Posted to #room -- room-controller.ts say reports the post on the status line
expect_screen "$(arm_key 'Posted to #room' 'Unknown command')" 20
sleep 1
shot room-said

# --- 13. the room view shows what the room last said -------------------------
clear_composer
k Right
pause 0.25
k Right
# needle-source: #room  you: -- room-stage.ts #paintChrome's channel row under the title
after && expect_screen "#room  you:" 10
pause 0.9
shot room-channel
