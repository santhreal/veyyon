#!/usr/bin/env bash
# The run screen of a loop that Escape paused: its title states the pause.
#
#   PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     proof/record.sh proof/scenes/autoresearch-paused-screen-title.sh
#   PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     PROOF_BASE_REF=db41064e74 proof/record.sh --before \
#     proof/scenes/autoresearch-paused-screen-title.sh
#
# The scene needs a model: an interrupt is only an interrupt when a turn is
# streaming. proof/scenes/new-session-keeps-running.sh states how the llama.cpp
# sidecar is started.
#
# The status row reads `paused · send a message to resume` after Escape, and the
# run screen opened over that row titled itself as if the loop were running:
# `Autoswarm · tokenizer-throughput`, the same title a live loop has. The title
# now reads `(paused)` off the same runtime state the row does. `(mode off)`
# outranks it, so a loop turned off reads off and not paused.
#
# The title sits in the sidebar's border segment, which truncates from the
# right, and the state is the rightmost word: the first take of this scene
# printed `Autoswarm · tokenizer-throughput  (paus…`. The title is now fitted
# to the border's budget with the name giving way and the state kept, so this
# frame is also the proof that `(paused)` survives a name of this length.
#
# The hold point is the commit before the title change, which already has the
# paused row: the pair differs in the screen title and nothing else.
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
expect_screen "interrupted" 30 "interrupted"
settle 3
shot interrupted

# The run screen over the paused loop. Both arms open it; the after arm waits
# for the title it claims, the before arm for the screen itself, and
# photographs the title that reads as running.
k ctrl+x
settle 3
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "(paused)" 30 "screen-paused"
else
	expect_screen "esc close" 60 "screen"
fi
shot screen-paused
k Escape
settle 3
