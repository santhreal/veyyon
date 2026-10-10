#!/usr/bin/env bash
# A composer prediction after a real turn, and Tab inserting it.
#
# The model is llama.cpp serving qwen2.5-7b on the recorder's own network
# (proof/docker/home-seed/profiles/default/agent/models.yml). The 1.5B the other
# scenes use answers the prediction request with bare prose instead of the JSON
# object the request asks for, so it never produces a prediction. The recording
# profile holds no OpenAI Codex login, and the default mode is Off, so the off
# arm requests nothing. Custom mode with no Prediction Model inherits the
# session's model, so the on arm predicts through the same local server.
#
# The first request of a session is about 22k tokens and the 7B row declares a
# 32k window, which is past the automatic-compaction point (window minus reserve),
# so the turn would compact, free nothing and never settle. Both arms seed
# `compaction.enabled: false`; the only setting the arms differ in is the mode.
#
#   docker run -d --rm --gpus all --name veyyon-proof-llm --network veyyon-proof \
#     -v "${MODELS_DIR:?}":/models:ro ghcr.io/ggml-org/llama.cpp:server-cuda \
#     -m /models/qwen2.5-7b-instruct-q4_k_m.gguf --host 0.0.0.0 --port 8080 \
#     -c 32768 -ngl 99 --cache-reuse 256
#   export PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=0 \
#     SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-7b'
#   OUT_DIR=proof/captures/x11/off proof/record.sh \
#     --settings 'compaction.enabled: false' proof/scenes/composer-prediction-ghost.sh
#   OUT_DIR=proof/captures/x11/on proof/record.sh \
#     --settings "$(printf 'compaction.enabled: false\ncomposer.predictions.mode: custom')" \
#     proof/scenes/composer-prediction-ghost.sh
#
# A prediction replaces the composer's resting hint, "ask anything", with the
# suggested message and a "· tab to accept" hint in the same dim style. The off
# arm keeps the resting hint after the turn; the on arm waits for the hint to be
# replaced, checks the accept hint, holds the frame, then presses Tab, which
# inserts the suggestion without the accept hint.
#
# Frames:
#   predicted   the empty composer after the turn (off: the resting hint; on: the suggestion and accept hint)
#   tab         on arm only: the composer after Tab inserted the suggestion
set -euo pipefail

case "${SCENE_SETTINGS:-}" in
*"composer.predictions.mode: custom"*) arm=on ;;
*) arm=off ;;
esac

settle 18
expect_screen "ask anything" 60 resting-hint

submit "my parser tests fail after a refactor. do not call any tools. in plain text, offer in one sentence to run bun test test/parser.test.ts for me."
# The resting hint also shows while the turn runs, so neither arm reads the
# composer until the working indicator is gone.
settle 10
turn=0
while screen_has "Working"; do
	[ "${turn}" -lt 300 ] || abandon_take "predicted" "the turn did not settle in 300s"
	sleep 2
	turn=$((turn + 2))
done
echo "scene: turn settled ${turn}s after the first check" >&2

case "${arm}" in
off)
	settle 45
	screen_has "ask anything" || abandon_take "predicted" "the off arm replaced the resting hint"
	screen_has "tab to accept" && abandon_take "predicted" "the off arm shows an accept hint"
	shot predicted
	;;
on)
	waited=0
	while screen_has "ask anything"; do
		[ "${waited}" -lt 240 ] || abandon_take "predicted" "no prediction replaced the resting hint in 240s"
		sleep 2
		waited=$((waited + 2))
	done
	echo "scene: prediction shown ${waited}s after the turn settled" >&2
	settle 2
	screen_has "tab to accept" || abandon_take "predicted" "the prediction shows no accept hint"
	settle 6
	shot predicted
	k Tab
	settle 2
	screen_has "tab to accept" && abandon_take "tab" "the accept hint outlived the inserted suggestion"
	shot tab
	;;
esac
