#!/usr/bin/env bash
# A tour of the room with real agents: three conversations working on one
# repository in one terminal, and the room view that shows them.
#
#   1. Conversation 1 takes a long task in ship-sim: write two modules against
#      their tests, then run them.
#   2. `/room new` opens conversation 2 beside it for a parser fix; conversation 1
#      keeps working.
#   3. `→→` opens the room view the first time, with its guide. Escape closes the
#      guide; `←` glides the row, Tab lays out every window and back.
#   4. `n` opens conversation 3 from the view, and it is asked a question that
#      needs no tools.
#   5. The room again: `r` names each window.
#   6. Commands ask before they run. A conversation that asks while it is off
#      screen waits: the room counts it as needing you, the arrows find the window
#      whose key row reads `enter answer`, and Enter answers it there.
#   7. `alt+.` twice in a row goes two conversations on; `/room list` prints the
#      room; the room once more at the end.
#
# Any model with tools drives it. The guards read what the room prints and never
# what a model writes, and the waits for a question are bounded and carry on
# without one, so a model that asks nothing still records the rest.
#
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model <provider/model> --approval-mode ask-command' \
#     PROOF_AUTH_DIR=<a directory holding an agent.db signed in to that provider> \
#     SCENE_MOTION_FLOOR=0 proof/record.sh proof/scenes/room-tour.sh
#
# The take waits on real turns, so it has stretches with little motion; the motion
# floor is off for it.

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

# A question on screen is answered where it stands, so the keys that follow reach
# the composer and not the dialog.
answer_on_screen() {
	approve_while_asked 6 || true
}

# Whether a conversation has asked, waiting up to $1 seconds with the room open.
room_waits_for_you() {
	local ceiling="$1" waited=0
	while [ "${waited}" -lt "${ceiling}" ]; do
		screen_has "needs you" && return 0
		sleep 3
		waited=$((waited + 3))
	done
	return 1
}

# Whether the question is on screen, waiting up to $1 seconds. Not a guard: the
# guards approve a question they meet while they wait, and this one is to be seen
# before it is answered.
question_on_screen() {
	local ceiling="$1" waited=0
	while [ "${waited}" -lt "${ceiling}" ]; do
		screen_has "Permission required" && return 0
		sleep 1
		waited=$((waited + 1))
	done
	return 1
}

# Walk the row from the first window to the one whose key row reads `enter
# answer`, and go into it. Says whether it found one.
enter_the_one_waiting() {
	k Home
	pause 0.8
	local step
	for step in 1 2 3 4; do
		if [ -n "$(row_with 'enter answer')" ]; then
			pause 0.8
			k Return
			return 0
		fi
		k Right
		pause 0.9
	done
	return 1
}

settle 18
shot idle

# --- 1. a long task in conversation 1 ------------------------------------------
submit "In ship-sim, read SPEC.md, src/contracts.ts, test/math.test.ts and test/physics.test.ts, then write src/math.ts and src/physics.ts so those tests pass. Use your file tools to read and write; run no command until both files are written. Then run: cd ship-sim && bun test test/math.test.ts test/physics.test.ts"
sleep 8
answer_on_screen
shot one-working

# --- 2. /room new: a second conversation beside it ------------------------------
clear_composer
t "/room new"
pause 0.7
k Return
# needle-source: Switched to -- room-controller.ts #announce after a quick switch lands
expect_screen "Switched to" 60
sleep 1.5
submit "src/parser.ts accepts a string of only spaces. Make it throw the same error it throws for an empty string, and add a test for that to src/parser.test.ts. Use your file tools; then run: bun test src/parser.test.ts"
sleep 6
answer_on_screen
shot two-working

# --- 3. the room view, with its guide the first time ----------------------------
open_room
# needle-source: any key closes this -- room-guide.ts paintRoomGuide's last line
expect_screen "any key closes this" 10
pause 2.5
shot room-guide
k Escape
pause 1.2
shot room-side-by-side
k Left
pause 1.2
shot room-glided
k Tab
# needle-source: all windows -- the title row's layout name after Tab
expect_screen "all windows" 10
pause 2.5
shot room-all-windows
k Tab
pause 1.2

# --- 4. a third conversation from the view --------------------------------------
k n
# needle-source: Now on -- room-controller.ts #announce after entering a member from the overview
expect_screen "Now on" 60
sleep 1.5
submit "Without running or changing anything, explain in three short bullets how src/rate-limiter.ts refills its bucket."
sleep 5
answer_on_screen
shot three-asked

# --- 5. every window gets a name --------------------------------------------------
open_room
k Home
pause 0.8
for name in "ship-sim physics" "parser whitespace" "rate limiter"; do
	k r
	# needle-source: Name conversation -- room-stage.ts #paintChrome's naming line
	expect_screen "Name conversation" 10
	pause 0.4
	t "${name}"
	pause 0.6
	k Return
	pause 1
	k Right
	pause 0.8
done
k Home
pause 1
shot room-named

# --- 6. a conversation that asks while it is off screen waits for you -----------
# Up to two questions, each answered in the conversation that asked it.
for round in 1 2; do
	if ! room_waits_for_you 150; then
		echo "scene: no conversation asked in round ${round}" >&2
		break
	fi
	pause 1.5
	shot "room-needs-you-${round}"
	if ! enter_the_one_waiting; then
		echo "scene: the room counted a question and no window offered to answer it" >&2
		break
	fi
	if question_on_screen 30; then
		pause 1.5
		shot "question-on-arrival-${round}"
	else
		echo "scene: the question did not come on screen with its conversation" >&2
	fi
	answer_on_screen
	sleep 2
	open_room
done

# --- 7. the quick switch, /room list, and the room at the end ---------------------
k Escape
pause 1.5
answer_on_screen
k alt+period
pause 0.2
k alt+period
sleep 3
answer_on_screen
shot quick-switched-twice
clear_composer
t "/room list"
pause 0.7
k Return
# needle-source: Room ( -- room-controller.ts describe() heads the list with the room's size
expect_screen "Room (" 20
pause 2.5
shot room-list
open_room
pause 3
shot room-at-the-end
k Escape
pause 2
