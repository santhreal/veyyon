#!/usr/bin/env bash
# The room's `#room` channel with real agents: one conversation changes an
# interface that the conversation beside it is writing code against, and the
# room hears it.
#
#   1. `/room new` opens conversation 2, which writes a module on top of `parse`
#      from src/parser.ts.
#   2. `alt+,` goes back to conversation 1, which renames `parse`. It is told
#      that another conversation calls `parse`, and not how to tell it: each
#      conversation in a room is told what `#room` is for.
#   3. The room view shows the post in the row under its title.
#   4. `2` goes into conversation 2, where the post is a `#room` card.
#   5. `/room say` posts as you to both conversations.
#   6. The room at the end.
#
# Every task uses file tools only, so no command waits on an approval. The
# guards read what the room prints and never what a model writes; the wait for
# the post is bounded, and a take in which no conversation posts carries on and
# says so.
#
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model <provider/model> --approval-mode ask-command' \
#     PROOF_AUTH_DIR=<a directory holding an agent.db signed in to that provider> \
#     SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/room-channel.sh
#
# The take waits on real turns, so the motion floor is off for it.

# The room view opens on `→` twice on an empty composer.
open_room() {
	clear_composer
	k Right
	pause 0.25
	k Right
	# needle-source: side by side -- room-stage.ts #paintChrome names the layout on the title row
	expect_screen "side by side" 15
	pause 1
}

# Whether the room's channel has a line, waiting up to $1 seconds with the room
# open. The channel row is `#room`, two spaces, the poster; a transcript card is
# `#room`, one space, an arrow.
room_heard() {
	local ceiling="$1" waited=0
	while [ "${waited}" -lt "${ceiling}" ]; do
		screen_has "#room  " && return 0
		sleep 3
		waited=$((waited + 3))
	done
	return 1
}

settle 18
shot idle

# --- 1. conversation 2 builds on parse -------------------------------------------
clear_composer
t "/room new"
pause 0.7
k Return
# needle-source: Switched to -- room-controller.ts #announce after a quick switch lands
expect_screen "Switched to" 60
sleep 1.5
submit "Write src/focus.ts exporting focusOf(line: string): string, which returns parse(line) from ./parser.ts in upper case, and src/focus.test.ts with two tests for it. Use your file tools only; run no command."
sleep 6
shot two-working

# --- 2. conversation 1 changes the interface -------------------------------------
k alt+comma
# needle-source: Switched to -- room-controller.ts #announce after a quick switch lands
expect_screen "Switched to" 30
sleep 1.5
submit "Rename the exported function parse in src/parser.ts to parseFocus, and update src/parser.test.ts to match. Another conversation in this terminal is writing code that calls parse right now. Use your file tools only; run no command."
sleep 8
shot one-renaming

# --- 3. the room hears it ----------------------------------------------------------
open_room
if room_heard 180; then
	pause 1.5
	shot room-heard
else
	echo "scene: no conversation posted to #room" >&2
	shot room-quiet
fi

# --- 4. the post in conversation 2 ------------------------------------------------
k 2
# needle-source: Now on -- room-controller.ts #announce after entering a member from the overview
expect_screen "Now on" 30
sleep 2
shot two-read-it

# --- 5. /room say posts as you ------------------------------------------------------
clear_composer
t "/room say both of you: run no command, I will run the tests myself"
pause 0.7
k Return
# needle-source: Posted to #room -- room-controller.ts say reports the post on the status line
expect_screen "Posted to #room" 20
sleep 1.5
shot said

# --- 6. the room at the end ----------------------------------------------------------
sleep 20
open_room
pause 3
shot room-at-the-end
k Escape
pause 2
