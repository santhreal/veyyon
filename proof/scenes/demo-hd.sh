#!/usr/bin/env bash
# The one recording: a single long session that finishes a real piece of work, and signs
# the result with a credential it never types.
#
# It is one take rather than a row per feature. A gallery of one-feature clips costs a
# live take each and every one of them opens on the same empty composer, so the reader
# watches the product start up nine times and work once. One session that plans, reads,
# edits, verifies, advances its todo board, and then signs its output is the shorter
# recording and the more honest one: the state each step leaves behind is what the next
# step starts from. Surfaces that do not move are published as screenshots taken from this
# same take.
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
screen_has "model:" || screen_has "demo" || screen_has "veyyon" || MISSED="${MISSED:-} idle"
shot idle

# PLAN-FIRST: THE BOARD OPENS BEFORE THE WORK BEGINS.
#
# A plan written after the work is done is a retrospective disguised as planning.
# The session opens with the plan panel: a structured four-phase hardening roadmap
# written by the shipped todo tool, establishing the contract and the phased steps
# before a single file is touched.
submit "use your todo tool: initialize a four-phase plan for hardening environment variable handling across service/: Foundation with two tasks ('Audit unvalidated numeric env reads across service/' and 'Create service/env.ts with validating readNumber helper'), Migration with one task ('Migrate service/config, handlers, and store via parallel subagents'), Validation with two tasks ('Add hex rejection test to service/settings.test.ts' and 'Run service test suite to verify defaults'), and Release with one task ('Sign hardened release artifact with release signature'). Call the todo tool with op init once and stop immediately after the tool result -- do not call any other tools and do not read, search, or edit any files."
wait_for_screen "Todo" 240 || MISSED="${MISSED:-} todo-board"
if screen_has "Todo 0/6 tasks" && screen_has "Foundation"; then
	echo "scene: plan-first todo board visible" >&2
else
	MISSED="${MISSED:-} todo-board"
fi
shot todo-board
# The todo mutation has landed. Stop this turn before the model can execute ahead;
# the next request owns the first task.
k Escape
settle 3

# THE AUDIT & DISCOVERY.
#
# The first Foundation task is executed: finding every unvalidated numeric environment
# read across the nine modules in service/. The finished turn is the stable signal; its
# real search block is then brought back into view before the inventory is captured.
submit "now execute only the first Foundation task. Use your search tool across service/ and find all nine numeric environment reads in the seeded codebase. Mark only the audit task completed in your todo list, then print a compact nine-row inventory with file, variable, env var, default, and raw spelling (Number, parseInt, or unary +). Its final line must be exactly 'AUDIT COMPLETE: 9 reads; Number 3; parseInt 3; unary 3.' Stop at that line. Do not edit or write files, do not call the task tool, and do not begin the helper or migration."
wait_for_screen "AUDIT COMPLETE: 9 reads" 300 || MISSED="${MISSED:-} inventory"
# The inventory is now complete and the todo mutation has landed. Stop before a
# model that ignored the final instruction can execute the next phase ahead.
k Escape
settle 3
if screen_has "AUDIT COMPLETE: 9 reads" && screen_has "Number 3" && screen_has "parseInt 3" && screen_has "unary 3" && screen_has "service/"; then
	echo "scene: inventory audit table visible" >&2
else
	MISSED="${MISSED:-} inventory"
fi
# Search output can leave the viewport before a fast model finishes the table.
# Capture the real tool block from this same turn rather than racing its redraw.
wheel_up 7
settle 1
if screen_has "Grep" && screen_has "process.env"; then
	echo "scene: raw environment search visible" >&2
else
	MISSED="${MISSED:-} search-block"
fi
shot search-block
wheel_down 20
settle 1
screen_has "AUDIT COMPLETE: 9 reads" || MISSED="${MISSED:-} inventory"
shot inventory
# The audit is evidence only if the tree is still the nine raw reads the search
# inspected. A model that starts the helper or migration ahead can still print a
# plausible table, so check the seeded source state before asking for the write.
demo_dir="${SCENE_CWD:-/sandbox/home/demo}"
raw_reads="$(
	grep -hE 'Number\(process\.env|parseInt\(process\.env|= \+\(process\.env' \
		"${demo_dir}"/service/config/*.ts \
		"${demo_dir}"/service/handlers/*.ts \
		"${demo_dir}"/service/store/*.ts |
		wc -l |
		tr -d '[:space:]'
)"
if [ "${raw_reads}" = "9" ] && [ ! -e "${demo_dir}/service/env.ts" ]; then
	echo "scene: audit left all nine raw reads untouched" >&2
else
	MISSED="${MISSED:-} inventory-preedit"
fi

# THE FAN-OUT & PARALLEL MIGRATION.
#
# The main agent writes the one validating owner first (service/env.ts), then uses the task tool
# to fan out three subagents in parallel across service/config, service/handlers, and service/store.
# The helper contract is explicit: readNumber(name, fallback) returns fallback when process.env[name]
# is missing or blank, accepts only finite decimal numbers, rejects hex/octal/binary/non-numeric strings
# with an Error naming the variable, and adds no range checks.
submit "now execute the second Foundation task and dispatch the Migration phase: write service/env.ts first: one exported readNumber(name: string, fallback: number): number that reads process.env[name], returns fallback when missing or empty/blank, accepts only valid finite decimal numbers, and throws an Error naming the variable when given invalid non-decimal or non-numeric strings like hex (0x10), octal, or garbage. Do not edit test files or add range checks. Then dispatch the migration without waiting between calls: call your task tool first with only ConfigMigrate for service/config, then immediately call it again with HandlersMigrate for service/handlers and StoreMigrate for service/store in the same batch. All three must remain in flight together. Each replaces every env read in its own directory with readNumber and edits nothing outside it. Do not do that work yourself. After the second task call, stop immediately: do not wait for results, verify files, update todos, begin Validation, inspect Release, or ask questions."
wait_for_screen "Subagents" 360 || MISSED="${MISSED:-} agent-lanes"
# The request itself names the workers, so bare names are not readiness. The
# colon is emitted by the live Subagents renderer once each worker exists.
wait_for_screen "StoreMigrate:" 360 || MISSED="${MISSED:-} agent-lanes"
pause 2
if screen_has "ConfigMigrate:" && screen_has "HandlersMigrate:" && screen_has "StoreMigrate:" && ! screen_has "Error:"; then
	echo "scene: all three migration agents visible" >&2
else
	MISSED="${MISSED:-} agent-lanes"
fi
shot agent-lanes
settle_idle 900 10 3 30

# THE HASH-ANCHORED EDIT.
#
# The main agent applies a hash-anchored patch to service/settings.test.ts using the edit tool,
# adding a test case verifying that readNumber refuses invalid hex inputs (like '0x10') rather
# than silently reading 16.
submit "now add only the first Validation case to service/settings.test.ts yourself -- do not spawn anyone for this. Use the edit tool: the file already has cases that must stay exactly as they are, so do not use your write tool and do not rewrite the file. The case proves readNumber refuses a hex value like 0x10 instead of silently reading 16. Stop immediately after the edit tool result: do not run tests, update todos, commit, inspect Release, or ask questions."
wait_for_screen "Edit: " 400 || MISSED="${MISSED:-} edit-diff"
pause 2
shot edit-diff
settle_idle 400 8 2 20

# THE TEST SUITE EXECUTION.
#
# The verification command proves the entire hardened service holds together: all 9 call sites
# resolve defaults correctly and the new validation case passes with 0 failures.
submit "run the service suite with bun test and tell me whether every module still resolves its default and the new hex validation passes. Stop immediately after reporting the result: do not update todos, commit, inspect Release, sign anything, or ask questions."
settle_idle 300 8 2 20
if screen_has "2 pass" && screen_has "0 fail"; then
	echo "scene: service test suite passed with 0 failures" >&2
else
	MISSED="${MISSED:-} verify-command"
fi
shot verify-command

# ADVANCING THE PLAN & COMMITTING.
#
# The todo board closes Foundation and advances Migration and Validation; the whole
# service hardening is committed as one scoped commit.
submit "use your todo tool to mark the Create service/env.ts helper task completed, mark the Migration task completed, and mark the Validation tasks completed, then commit the whole service hardening as one scoped commit. Stop immediately after the commit: do not inspect Release, sign anything, or ask questions."
wait_for_screen "Todo" 240 || MISSED="${MISSED:-} todo-strike"
settle_idle 240 8 2 20
if screen_has "Migration" && screen_has "Validation"; then
	echo "scene: todo-strike board visible" >&2
else
	MISSED="${MISSED:-} todo-strike"
fi
shot todo-strike

# THE VAULT: STORING A CREDENTIAL FROM THE ENVIRONMENT.
#
# Stored without passing through the transcript.
slash "/secret from-env RELEASE_SIGNATURE release-signature"
settle 10
screen_has "release-signature" || screen_has "Stored" || screen_has "secret" || MISSED="${MISSED:-} secret-stored"
shot secret-stored

slash "/secret list"
settle 8
screen_has "SECRET" || screen_has "release-signature" || screen_has "RELEASE_SIGNATURE" || screen_has "Vault" || screen_has "Scope" || MISSED="${MISSED:-} secret-list"
shot secret-list
k Escape
sleep 1

# SPENDING THE CREDENTIAL WITH EXPLICIT PERMISSION APPROVAL.
#
# The model writes the placeholder #RELEASE_SIGNATURE#; veyyon intercepts at the outbound
# boundary, prompts with the permission dialog, and upon approval substitutes the real value.
submit "sign your work: one bash call, chained with && so it is a single call: append the sha256 of #RELEASE_SIGNATURE# to SIGNED.md as a line reading 'signature: <digest>', then cat SIGNED.md. Never print the credential itself. Stop immediately after reporting the command result: do not update todos or open any operator surface."
wait_for_screen "Permission required" 300 || MISSED="${MISSED:-} secret-approval"
shot secret-approval
approve_while_asked 6
settle_idle 200 8 2 20
screen_has "signature:" || screen_has "SIGNED.md" || MISSED="${MISSED:-} signature-written"
shot signature-written

slash "/secret log"
settle 10
screen_has "most recent use" || screen_has "release-signature" || screen_has "Spent" || screen_has "bash" || screen_has "Log" || MISSED="${MISSED:-} secret-log"
shot secret-log
k Escape
sleep 1

# CLOSING THE RELEASE PHASE ON THE TODO BOARD.
#
# A complete plan is closed out once its final release artifact is signed.
submit "use your todo tool to mark the Release task completed and confirm all phases are finished. Stop immediately after that confirmation: do not open any operator surface."
wait_for_screen "Todo" 240 || MISSED="${MISSED:-} todo-finished"
settle_idle 200 8 2 20
if screen_has "Todo list done" && screen_has "6 tasks"; then
	echo "scene: todo-finished board closed" >&2
else
	MISSED="${MISSED:-} todo-finished"
fi
shot todo-finished

# THE CONTEXT ACCOUNTING REPORT.
slash "/context"
settle 10
screen_has "Context" || screen_has "Tokens" || screen_has "Session" || MISSED="${MISSED:-} context-report"
shot context-report
k Escape
sleep 1

# OPERATOR SURFACE: SETTINGS CARD & POINTER NAVIGATION.
slash "/settings"
sleep 2
screen_has "Settings" || screen_has "General" || MISSED="${MISSED:-} settings-open"
shot settings-open
glide 12 40 24 40 24 0.06
sleep 0.8
screen_has "Settings" || screen_has "General" || MISSED="${MISSED:-} settings-pane"
shot settings-pane
k Escape
sleep 1.5

# FULL SESSION SCROLLBACK.
wheel_up 14
sleep 1
screen_has "service/" || screen_has "Todo" || screen_has "signature" || screen_has "readNumber" || MISSED="${MISSED:-} scrolled"
shot scrolled
wheel_down 14
sleep 1
screen_has "Context" || screen_has "Settings" || screen_has "demo" || screen_has "model:" || MISSED="${MISSED:-} bottom"
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
