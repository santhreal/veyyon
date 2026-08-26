#!/usr/bin/env bash
# `/agents` and `/process-manager`: one conversation, then every conversation.
#
# The claim under test is that the Agent Control Center can be opened at two
# scopes, and that the wider one reaches a conversation no screen is showing.
# Both arms are driven from this one scene so they cannot drift apart, and the
# take makes the differential four times rather than twice:
#
#   1. Session A is asked for a long list and starts streaming.
#   2. `/new` lands WHILE A is streaming, so A is now a conversation running in
#      the background — the state the wide scope exists for.
#   3. `/agents` opens on the new conversation. The title is plain and the chip
#      offers the other scope.
#   4. `a` widens the open card. The title gains the whole process and A's row
#      appears beneath it.
#   5. `/process-manager` opens wide from the start, which is the difference
#      between the two commands.
#   6. `a` narrows it back to the conversation the card was opened for.
#
# Steps 3 and 4 are the same card at both scopes, and steps 5 and 6 are the
# other entry point making the same trip in reverse. The title carries the
# claim: `Agent Control Center` against `Agent Control Center — all
# conversations`. Its absence is asserted on the narrow arms, because a card
# that opened wide by accident would otherwise publish as the narrow frame.
#
# A driving conversation registers a row of its own (`main:<sessionId>`), so
# this needs no subagent and therefore no tools: the two rows under the wide
# title are the two conversations themselves.
#
# The model is llama.cpp serving qwen2.5-1.5b on the recorder's own docker
# network (proof/docker/home-seed/profiles/default/agent/models.yml). It runs
# with `--no-tools`, without which the tool schemas alone spend more than the
# 32k window. A is asked for a long list so it is still answering when the card
# is opened over the top of it.
#
#   MODELS_DIR is wherever the gguf sits on the machine doing the recording.
#   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
#     -v "${MODELS_DIR:?}":/models:ro \
#     ghcr.io/ggml-org/llama.cpp:server \
#     -m /models/qwen2.5-1.5b-instruct-q4_k_m.gguf --host 0.0.0.0 --port 8080 \
#     -c 65536 --cache-reuse 256 -t 12
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts \
#     --model local/qwen2.5-1.5b --no-tools' \
#     PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     proof/docker/record-x11.sh proof/scenes/process-manager-scope.sh

WIDE_TITLE="Agent Control Center — all conversations"

# The other half of `expect_screen`: a guard that must NOT be on screen.
#
# A scope defect is silent in a still. A card that opened at the wrong scope
# renders a title, a chip and a roster, all of them plausible, and the frame
# publishes. Asserting the absence is what makes the narrow arms mean anything.
expect_missing() {
	local needle="$1"
	if screen_text | grep -qF -- "${needle}"; then
		abandon_take "${2:-absent}" "'${needle}' is on screen and this arm is the one where it must not be"
	fi
}

settle 18
shot idle

# Warm the prefix so the turn that matters starts streaming immediately.
submit "hi"
settle_idle 200 6 2 20

# --- 1. A is answering ------------------------------------------------------
submit "write a numbered list of sixty short facts about terminal emulators, one line each"
sleep 6
shot a-streaming

# --- 2. /new, and A keeps running in the background -------------------------
slash "/new"
expect_screen "keeps running" 30
sleep 1
shot b-new-while-a-runs

# --- 3. /agents: the conversation on screen, and only it --------------------
slash "/agents"
expect_screen "Agent Control Center" 30
expect_missing "${WIDE_TITLE}" agents-opened-wide
sleep 1
shot agents-this-conversation

# --- 4. `a` widens the card that is already open ----------------------------
#
# The same card, one keystroke later. A's row is here and was not in the frame
# before it, which is the whole differential.
k a
expect_screen "${WIDE_TITLE}" 30
sleep 1
shot agents-widened-to-every-conversation

# --- 5. /process-manager opens wide from the start --------------------------
#
# The difference between the two commands, and the reason there are two: this
# one answers a question about work that is not on the screen asking it.
k Escape
sleep 1
slash "/process-manager"
expect_screen "${WIDE_TITLE}" 30
sleep 1
shot process-manager-opens-wide

# --- 6. and `a` narrows it to the conversation it was opened for ------------
k a
expect_screen "Agent Control Center" 30
expect_missing "${WIDE_TITLE}" process-manager-stuck-wide
sleep 1
shot process-manager-narrowed-to-this-conversation
