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

# THE SUBJECT IS A TREE, NOT A FILE.
#
# What this take used to record was a model reading one short file and editing it, and that is
# not the work this product is for. Nine modules across three directories read a numeric
# setting straight out of the environment, each in its own spelling (`Number`, `parseInt`
# without a radix, unary plus), so a typo in a deploy is a silent zero rather than a failed
# boot. Finding every site is a search rather than a read, fixing them is one new owner plus
# nine call sites, and knowing you are done takes the suite. That is a session worth watching.
#
# The search first, and nothing changed yet. Two frames come out of this one turn, and the order
# is the order they exist in: the tool block is shot WHILE the search is running, and the answer
# once the turn is over. Scrolling back for the block is what the two takes before this one did,
# and against a model that writes a page about what it found it does not reach.
submit "use your search tool across service/ and list every place a numeric setting is read from the environment: file, variable, env var, default, and which spelling it uses. Do not change anything yet."
wait_for_screen "Grep" 240 || MISSED="${MISSED:-} search-block"
pause 1.5
shot search-block
settle_idle 300 8 2 20
shot inventory

# THE FAN-OUT. The needle is `Subagents`, the heading the lane list renders under, and the reason
# it is not a lane's name is that the names are IN THIS INSTRUCTION: a submitted prompt stays on
# screen, so `ConfigLane` was already there at the moment the wait started and the frame published
# under that name was the prompt, a `Thinking` line and a one-second spinner. A needle has to be
# text only the RENDERER can produce. `Subagents` qualifies -- the instruction below says
# "subagents" in lower case, and the case matters to `screen_has`.
#
# One owner is written by the main agent BEFORE the fan-out, because three agents inventing
# three helpers is the failure mode this instruction exists to avoid, and because it makes the
# lanes genuinely parallel: they edit disjoint directories against a file that already exists.
submit "write service/env.ts first: one exported readNumber(name, fallback) that reads process.env, accepts a missing value as the fallback, and throws naming the variable when the value is not a finite number. Then spawn three subagents in parallel -- ConfigLane for service/config, HandlerLane for service/handlers, StoreLane for service/store -- each replacing every env read in its own directory with readNumber. Nobody edits another lane's directory."
# The lane list is LIVE STATE: it exists while the lanes are running and it is gone, far above
# the bottom of a long report, by the time the turn ends. So it is shot while the lanes are up.
wait_for_screen "Subagents" 600 || MISSED="${MISSED:-} agent-lanes"
pause 2
shot agent-lanes
settle_idle 900 10 3 30

# THE PARENT'S OWN EDIT, AND WHY THE FAN-OUT CANNOT SUPPLY IT.
#
# A lane's diff belongs to that lane's transcript. The parent screen after a fan-out carries lane
# summaries and no diff at all, so the guard for this frame refused in two takes running -- and it
# was right both times: `Edit: ` is exactly what the header is (`renderStatusLine` joins title and
# description with ": "), there was simply no edit of the parent's own to find. The main agent
# is asked for one, and for the edit its own search argued for: `parseInt` without a radix reads
# `0x10` as 16, which is the trap it flagged while it was still only looking.
submit "now edit service/settings.test.ts yourself -- do not spawn anyone for this, and use your edit tool rather than rewriting the file -- adding one case that proves readNumber refuses a hex value like 0x10 instead of silently reading 16."
wait_for_screen "Edit: " 400 || MISSED="${MISSED:-} edit-diff"
pause 2
shot edit-diff
settle_idle 400 8 2 20

# The suite, which is the only thing that answers whether nine edits across three directories
# actually hold together.
submit "run the service suite and tell me whether every module still resolves its default"
settle_idle 300 8 2 20
shot verify-command

# The plan panel, written by the shipped todo tool rather than typed into the transcript.
#
# "Do not start any of them" because the take before this one was asked to start the first
# task and finished all six before the shot, so what published as the plan board was a
# board with nothing left on it. The board is the surface; the work is the next beat.
submit "use your todo tool: write a three-phase plan for finishing this hardening, Foundation with two tasks, Validation with three, Release with one. Do not start any of them yet and do not change any files."
settle_idle 200 8 2 20
shot todo-board
submit "start the first Foundation task, then mark it completed and commit the whole service hardening as one scoped commit"
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

# A FRAME THAT DOES NOT CONTAIN ITS SURFACE FAILS THE TAKE. Last, so everything above is on
# disk and the crosscheck is written before anything gives up: the publish step is what must
# not run, not the recording. Reported by name, because "a needle missed" in a log nobody
# reads is how a frame of prose got published as a diff.
if [ -n "${MISSED:-}" ]; then
	echo "scene: these frames do not contain the surface they are named after:${MISSED}" >&2
	echo "scene: nothing may be published from this take" >&2
	exit 1
fi
