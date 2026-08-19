#!/usr/bin/env bash
# The one recording: a single long session that finishes a real piece of work, and signs
# the result with a credential it is never shown.
#
# It is one take rather than a row per feature. A gallery of one-feature clips costs a
# live take each and every one of them opens on the same empty composer, so the reader
# watches the product start up nine times and work once. One session that reads, edits,
# verifies, plans and then signs its output is the shorter recording and the more honest
# one: the state each step leaves behind is what the next step starts from. Surfaces that
# do not move are published as screenshots taken from this same take.
#
# THE SIGNATURE IS THE PART A READER CAN CHECK.
#
# The container's environment holds one number, exported by seed-demo.sh and never typed
# into the session. `/secret from-env` stores it without it passing through the transcript,
# and from then on the model has a placeholder and nothing else. The model is asked to
# sign the file it just changed: it writes a command containing #RELEASE_SIGNATURE#, and
# veyyon substitutes the real bytes at the outbound boundary, after the model has
# committed to the command and before the shell sees it.
#
# So the recording shows three things that cannot all be faked at once: the transcript
# carrying the placeholder, the file on disk carrying the sha256 of the real number, and
# `/secret log` naming the spend. Anyone with the number can hash it themselves and get
# the digest in the frame. The number is printed at the end of the run, outside the
# recording, for exactly that purpose.
settle 16
shot idle

# Reading. The model finds the file itself, which is what puts a read block with its rail
# on screen rather than a path someone typed.
submit "read src/parser.ts and tell me in one sentence what it rejects"
settle 45
shot read-block

# Editing, with the diff the edit tool applied and the file named in the block header.
submit "in src/parser.ts, make parse also reject a string that is only whitespace, and keep the existing error message style"
settle 80
shot edit-diff

# A command the model chose to check its own work with, and its output.
submit "run the project's own test for the parser and tell me whether it passes"
settle 75
shot verify-command

# The plan panel, written by the shipped todo tool rather than typed into the transcript.
submit "use your todo tool: a three-phase plan for hardening this parser, Foundation with two tasks, Validation with three, Release with one, then start the first task"
settle 70
shot todo-board
submit "mark the first Foundation task completed"
settle 50
shot todo-strike

# The credential, taken out of the environment so it is typed nowhere.
slash "/secret from-env RELEASE_SIGNATURE release-signature"
settle 10
shot secret-stored

slash "/secret list"
settle 8
shot secret-list
k Escape
sleep 1

# Spending it. The model writes the placeholder; veyyon writes the value, and only into
# the command's arguments at the outbound boundary.
submit "sign your work: run one bash command that pipes #RELEASE_SIGNATURE# into sha256sum and appends a line 'signature: <digest>' to SIGNED.md. Print the file afterwards. Never print the credential itself."
settle 110
shot signature-written

slash "/secret log"
settle 10
shot secret-log
k Escape
sleep 1

# What the session cost, from the product's own accounting rather than a claim about it.
slash "/context"
settle 10
shot context-report
k Escape
sleep 1

# The settings card, opened by a real pointer travelling down the sidebar.
slash "/settings"
sleep 2
shot settings-open
glide 12 40 24 40 24 0.06
sleep 0.8
shot settings-pane
k Escape
sleep 1.5

# The session as a whole: scroll back through everything the take produced, so it ends on
# the work rather than on an empty composer.
wheel_up 14
sleep 1
shot scrolled
wheel_down 14
sleep 1
shot bottom

# Outside the recording: the number, the digest the shell computed, and the file. The
# frame shows the digest; this is what it is a digest OF, so the claim is checkable rather
# than asserted.
{
	echo "signing number (never on screen): ${RELEASE_SIGNATURE:-<unset>}"
	printf 'sha256 of that number: '
	printf '%s' "${RELEASE_SIGNATURE:-}" | sha256sum | cut -d' ' -f1
	echo "--- SIGNED.md ---"
	cat "${SCENE_CWD:-/sandbox/home/demo}/SIGNED.md" 2>&1
} >"${SCENE_OUT}/signature-crosscheck.txt" 2>&1
