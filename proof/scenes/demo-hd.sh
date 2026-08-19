#!/usr/bin/env bash
# The one recording: a single long session that finishes a real piece of work, and signs
# the result with a credential it never types.
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

# Reading, and the beat exists for the answer rather than the block: the guard in the fixture
# is `!s`, so a whitespace-only string already passes it, and what makes the next turn worth
# watching is the model saying so on its own before anything has been edited.
submit "read src/parser.ts and tell me in one sentence what it rejects"
settle_idle 90 6 2 20
shot read-block

# Editing, with the diff the edit tool applied and the file named in the block header.
#
# The instruction not to run anything is kept, and it is not trusted: this model verifies its
# own edit unasked, in the same turn, and did so on both takes that carried the instruction.
# So the scene scrolls back until the edit block's own header is on screen and shoots there.
# The needle is "Edit: " because that is what the header literally is: renderStatusLine joins
# the title and the description with ": ", and the description opens with a language badge, so
# "Edit: src/parser.ts" is not on screen as one string and would have scrolled past the diff
# looking for it. scroll_to reports into the log either way, and a frame whose name does not
# match what is in it is worse than a missing frame.
submit "in src/parser.ts, make parse also reject a string that is only whitespace, and keep the existing error message style. Apply the edit only -- do not run any commands."
settle_idle 260 8 2 20
scroll_to "Edit: " 14 || true
shot edit-diff
wheel_down 20
pause 1

# A command the model chose to check its own work with, and its output.
submit "run the project's own test for the parser and tell me whether it passes"
settle_idle 220 8 2 20
shot verify-command

# The plan panel, written by the shipped todo tool rather than typed into the transcript.
#
# "Do not start any of them" because the take before this one was asked to start the first
# task and finished all six before the shot, so what published as the plan board was a
# board with nothing left on it. The board is the surface; the work is the next beat.
submit "use your todo tool: write a three-phase plan for hardening this parser, Foundation with two tasks, Validation with three, Release with one. Do not start any of them yet and do not change any files."
settle_idle 200 8 2 20
shot todo-board
submit "start the first Foundation task, then mark it completed and commit the parser work as one scoped commit"
settle_idle 240 8 2 20
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
#
# AND THE PRODUCT ASKS FIRST. A tool call whose arguments carry a real credential needs
# explicit approval in every non-yolo mode (secret-use-boundary.ts), so the take that did
# not answer that dialog never wrote the file at all: three runs published a crosscheck
# whose SIGNED.md was missing, and the reason was on screen the whole time. The dialog is
# the best frame in the take -- it names the credential the call would spend and what
# approving means -- so it gets shot, and then approved the way a reader would.
submit "sign your work: one bash call, chained with && so it is a single call: append the sha256 of #RELEASE_SIGNATURE# to SIGNED.md as a line reading 'signature: <digest>', then cat SIGNED.md. Never print the credential itself."
settle_idle 300 10 2 20
shot secret-approval
approve_while_asked 6
settle_idle 200 8 2 20
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
#
# SCENE_SIGNING_NUMBER, not RELEASE_SIGNATURE. xsession.sh exports RELEASE_SIGNATURE into
# the APP's environment so `/secret from-env` can find it; this block runs in the scene's
# own shell, which never had it. The take before this one published "signing number
# (never on screen): <unset>" and the sha256 of the empty string beside a real digest from
# SIGNED.md, which makes the one checkable claim in the recording uncheckable.
NUMBER="${SCENE_SIGNING_NUMBER:-${RELEASE_SIGNATURE:-}}"
{
	# "Never typed, never in the transcript" -- not "never on screen". veyyon substitutes the
	# credential BEFORE asking permission, so the approval dialog shows the operator the exact
	# command that will run, real value included. That is the point of an approval dialog, and
	# a crosscheck that claimed otherwise would be describing a product that does not exist.
	echo "signing number (never typed, never in the transcript; shown in the approval dialog): ${NUMBER:-<unset>}"
	printf 'sha256 of that number: '
	printf '%s' "${NUMBER}" | sha256sum | cut -d' ' -f1
	printf 'sha256 of that number and a newline: '
	printf '%s\n' "${NUMBER}" | sha256sum | cut -d' ' -f1
	echo "--- SIGNED.md ---"
	# Tolerant of the file not being there, because the scene must not die on the way to
	# publishing fifteen frames. A take whose signing turn was never approved exited here
	# under set -e and threw away its whole recording; the missing file is now a line in
	# the crosscheck, which is where a reader would look for it anyway.
	cat "${SCENE_CWD:-/sandbox/home/demo}/SIGNED.md" 2>&1 || echo "SIGNED.md was never written"
} >"${SCENE_OUT}/signature-crosscheck.txt" 2>&1
