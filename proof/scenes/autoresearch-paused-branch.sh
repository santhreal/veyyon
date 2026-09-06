#!/usr/bin/env bash
# The status row of a loop whose branch is not the one checked out, and the row
# again once it is.
#
#   PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     proof/record.sh proof/scenes/autoresearch-paused-branch.sh
#   PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     PROOF_BASE_REF=1a37965593 proof/record.sh --before \
#     proof/scenes/autoresearch-paused-branch.sh
#
# The scene needs a model, because a turn is what re-reads the branch: with no
# endpoint the turn fails on DNS before it starts, no handler runs, and the take
# records the row it already had. proof/scenes/new-session-keeps-running.sh
# states how the llama.cpp sidecar is started.
#
# A git checkout raises no event of its own, so the branch is re-read at the
# start of each turn: the scene checks a branch out with `!git checkout` and then
# sends a message, which is exactly how a user reaches this state.
#
# Before the fix the session was looked up by branch alone, so off its branch it
# was simply not found and the checkout was noticed by nothing: the before arm
# shows the row still reading its runs, and the loop still holding its experiment
# tools, while the status line stands on `main`. After it the row states the
# branch to return to, and checking that branch back out lifts the pause.
#
# The run screen is shot on both arms and differs on neither: this path never
# reached the state-wipe, so the screen is context for the row rather than
# evidence of its own. The blanked row that wipe produces is reached by resuming
# a session off its branch, which no scene can drive: the suite
# a-loop-that-stops-says-why-it-stopped.test.ts owns it.
#
# The session comes from proof/docker/seed-autoresearch.ts (`swarm`), which
# leaves the tree on the session's branch; `/autoresearch` adopts it rather than
# allocating a new one.
#
# A still take: the row holds between keystrokes, so the motion gate has to be
# lowered or the take is rejected as a stutter.

settle 20

slash "/autoresearch make the tokenizer faster"
settle 6
expect_screen "autoswarm" 90 "armed"

# Turning the mode on starts the loop's own turn. A message sent while that turn
# is in flight is queued rather than started, and a queued message re-reads
# nothing: the branch is read when a turn STARTS. So the loop's turn is
# interrupted first, exactly as a user interrupts one, and every message below
# lands on an idle session.
k Escape
settle_idle 60 3 2

# The loop on its own branch: the reading every later frame is compared against.
shot row-live

# Off the branch. A bash command is not a turn, so nothing has re-read the branch
# yet and the row is still the live one.
submit "!git checkout -q main"
settle_idle 40 3 2

submit "say ok"
# The turn is what re-reads the branch, so the row cannot be photographed until
# one has started. Waiting on the row rather than on a duration keeps the take
# honest: a frame shot on a timer would pass whether or not the fix ran.
#
# The before arm has no word to wait for -- the row is taken away rather than
# repainted -- so it waits for the turn itself and photographs whatever the row
# became, which is the defect.
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "paused" 150 "paused"
else
	settle_idle 150 4 2
fi
shot row-paused

# The run screen still opens on a paused session and still holds the runs. This
# is the half of the defect the row cannot show: before the fix the state was
# reset, so the screen had nothing to list.
k ctrl+x
settle 3
[ "${SCENE_ARM:-after}" = "after" ] && expect_screen "esc close" 60 "screen"
shot screen-paused
k Escape
settle 3

# Back on the branch, and one turn to notice it. Before the fix the loop stayed
# off here however many times the branch came back.
#
# The pause was photographed at the START of a turn, so that turn is still
# streaming. Interrupting it first is what makes the checkout below land on an
# idle session: a message sent into a running turn is queued, and a queued
# message starts no turn, so nothing re-reads the branch and the row stays paused
# for reasons that have nothing to do with the fix.
k Escape
settle_idle 90 3 2
submit "!git checkout -q autoresearch/tokenizer-throughput"
settle_idle 40 3 2
submit "say ok"

# The row drops the pause once a turn has started back on the branch. Waiting on
# the row losing the word, rather than on a duration, is the whole claim of the
# resume half: a timed frame would publish whichever state happened to be up.
#
# Pre-fix the row carries no word to lose -- it is gone -- so that arm waits for
# the turn and photographs the row that never came back.
if [ "${SCENE_ARM:-after}" = "after" ]; then
	for _ in $(seq 1 75); do
		case "$(row_with "autoswarm")" in
		*paused*) sleep 2 ;;
		*) break ;;
		esac
	done
	case "$(row_with "autoswarm")" in
	*paused*) abandon_take "resumed" "the row still reads paused back on the session's branch" ;;
	esac
else
	settle_idle 150 4 2
fi

# The status line reads the branch on its own cadence, so it can still be showing
# the branch that was left while the row has already resumed. A frame caught
# between the two reads is a frame that argues with itself -- a reviewer sees a
# resumed row over a status line that says `main` -- so the take waits for both
# to agree before it is published. This is presentation, not the claim: the row
# above is what the fix changes.
for _ in $(seq 1 40); do
	case "$(row_with "~/demo")" in
	*autoresearch/tokenizer-throughput*) break ;;
	*) sleep 2 ;;
	esac
done
case "$(row_with "~/demo")" in
*autoresearch/tokenizer-throughput*) ;;
*) abandon_take "resumed" "the status line never caught up with the checkout" ;;
esac
shot row-resumed
