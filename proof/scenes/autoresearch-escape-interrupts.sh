#!/usr/bin/env bash
# Escape during a loop turn, and the message that resumes it.
#
#   PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     proof/record.sh proof/scenes/autoresearch-escape-interrupts.sh
#   PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     PROOF_BASE_REF=82b08a8511 proof/record.sh --before \
#     proof/scenes/autoresearch-escape-interrupts.sh
#
# The scene needs a model: an interrupt is only an interrupt when a turn is
# streaming. proof/scenes/new-session-keeps-running.sh states how the llama.cpp
# sidecar is started.
#
# `agent_end` reads every turn end alike, and a loop turn that ended without
# advancing the experiment was nudged back into motion on the spot. Escape ended
# a turn without advancing it, so the loop was running again before the composer
# came back and the interrupt had done nothing. The hook now reads the abort off
# the last assistant message, disarms the resume, and reports the pause; the next
# message the user sends resumes the loop through `before_agent_start`.
#
# The hold point is the commit before the fix rather than `origin/main`. `main`
# has no stall nudge, so on that side Escape leaves the loop silently stopped --
# a different frame, and not the defect this pair is for.
#
# The session comes from proof/docker/seed-autoresearch.ts (`swarm`), which
# leaves the tree on the session's branch; `/autoresearch` adopts it rather than
# allocating a new one.
#
# A still take: the screen holds between keystrokes, so the motion gate has to
# be lowered or the take is rejected as a stutter.

settle 20

slash "/autoresearch make the tokenizer faster"
settle 6
expect_screen "autoswarm" 90 "armed"

# Turning the mode on starts the loop's own turn. The model spends its first
# seconds on the prompt before anything streams, and an Escape that lands before
# the request is in flight aborts nothing.
sleep 8
k Escape

# The frame is shot once the product has answered the key. The after arm prints
# the pause; the before arm has no word to wait for -- the nudge turn is a hidden
# message -- so it waits long enough for that turn to be visibly running and
# photographs the loop that did not stop.
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "interrupted" 30 "interrupted"
	settle 3
else
	settle 12
fi
shot interrupted

# A message resumes the loop. On the after arm this is the resume half of the
# claim: the pause holds until the user speaks, and then the loop's turn starts
# again on the same session. On the before arm the loop never stopped, so the
# message queues behind the turn it never left.
submit "continue with the arena allocator"
settle 8
shot resumed
