#!/usr/bin/env bash
# `/new` over a running answer, and `/resume` back to it — both sessions live.
#
# The claim under test is that starting a session no longer costs the one that is
# answering. That cannot be shown in a single frame, because a session running in
# the background is by definition not the one on screen. So the take makes the
# round trip and lets the transcripts testify:
#
#   1. Session A is asked for a long list and starts streaming.
#   2. `/new` lands WHILE A is streaming. The footer names the session that keeps
#      running, and the transcript is empty — where an aborted turn used to be.
#   3. Session B is asked for its own long list and starts streaming.
#   4. `/resume` returns to A while A is STILL answering. The status line says so:
#      it re-attached the live object rather than replaying a finished file.
#   5. `/resume` returns to B, whose answer also moved on while nobody watched.
#   6. `/resume` returns to A once more. A's list is complete, and every token
#      after step 1 arrived while A was not the session on screen.
#
# Steps 4 to 6 are the proof: each session's transcript advanced during the time
# the other one was on screen. `shot` refuses a frame byte-identical to the one
# before it, so a take where nothing progressed cannot publish.
#
# The model is llama.cpp serving qwen2.5-1.5b on the recorder's own docker
# network (proof/docker/home-seed/profiles/default/agent/models.yml). No provider
# is reachable from this container, so what streams here is a real session or
# nothing. The first turn is a warm-up: on CPU the server spends about thirty
# seconds on the prompt before the first token, and `--cache-reuse` lets the
# turns after it start streaming straight away.
#
# It runs with `--no-tools`, which is what makes a turn on this model possible
# rather than a preference. `veyyon prompt --sections` measures the system prompt
# at 20,560 tokens and `veyyon prompt --tools` measures the twenty tool schemas
# at 16,061 more; every request pays both, so 36.6k of a 32,768 window is spent
# before the first question. That is what "0% left" and the automatic-maintenance
# warning in a plain take are reporting, accurately. Without the tool schemas the
# prompt is 19,509 tokens and a session has about 13k of window to work in.
#
# Two sessions also stream at once here, and llama.cpp shares one unified KV
# cache across its slots, so the server needs room for the pair: `-c 65536`. The
# model row still declares 32768, which is the per-slot window the server reports
# (the weights are trained to 32k) — declaring more would be a client accounting
# against a server that truncates.
#
# The take is deliberately still. A session in the background produces no pixels,
# so the frames that carry the claim are separated by minutes of a screen holding
# one transcript: the capture measures 2 fps of real change against a default
# floor of 12, and the floor has to be lowered for it rather than the take sped
# up. The motion gate is doing its job; this is the case it does not describe.
#
#   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
#     -v /mnt/FlareTraining/.golemn/models:/models:ro \
#     ghcr.io/ggml-org/llama.cpp:server \
#     -m /models/qwen2.5-1.5b-instruct-q4_k_m.gguf --host 0.0.0.0 --port 8080 \
#     -c 65536 --cache-reuse 256 -t 12
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts \
#     --model local/qwen2.5-1.5b --no-tools' \
#     PROOF_LLM_BASE_URL=http://veyyon-proof-llm:8080/v1 SCENE_MOTION_FLOOR=1 \
#     proof/docker/record-x11.sh proof/scenes/new-session-keeps-running.sh

SESSIONS_ROOT=/sandbox/home/.veyyon/profiles/default/agent/sessions
BASELINE_STEMS="$(mktemp)"

# Transcript stems on disk, oldest first. `/resume <stem>` matches a session by
# its file stem (session-listing.ts `sessionMatchesResumeArg`), which is how a
# script names a session without reading the selector's rows.
session_stems() {
	find "${SESSIONS_ROOT}" -name '*.jsonl' -printf '%T@ %f\n' 2>/dev/null |
		sort -n | sed 's/^[0-9.]* //; s/\.jsonl$//'
}

# The stem that appeared since the baseline was taken.
#
# A session file is created lazily: `SessionManager.#appendToSessionFile` writes
# nothing until the session has an ASSISTANT message, so a session that never
# produced output never leaves a file behind. A prompt on screen is therefore not
# enough — this waits for the new session's first token to have landed, which is
# also exactly the moment `/resume` can name it. Selecting by set difference
# rather than by newest mtime is deliberate: the session left behind is still
# streaming, so it keeps touching its own file and stays the newest.
wait_for_new_stem() {
	local ceiling="${1:-90}" waited=0 stem
	while [ "${waited}" -lt "${ceiling}" ]; do
		stem="$(session_stems | grep -F -x -v -f "${BASELINE_STEMS}" | tail -1)"
		if [ -n "${stem}" ]; then
			printf '%s\n' "${stem}"
			return 0
		fi
		sleep 2
		waited=$((waited + 2))
	done
	return 1
}

settle 18
shot idle

# Warm the prefix so the turns that matter start streaming immediately.
submit "hi"
settle_idle 200 6 2 20

A_STEM="$(session_stems | tail -1)"
[ -n "${A_STEM}" ] || abandon_take a-stem "no session transcript on disk after the warm-up turn"
echo "scene: session A is ${A_STEM}" >&2

# --- 1. A is answering ------------------------------------------------------
#
# Sixty facts rather than twenty: the answer has to still be arriving when step 4
# comes back to it, or `/resume` finds a finished session on disk and re-attaching
# the live object is never exercised.
submit "write a numbered list of sixty short facts about terminal emulators, one line each"
sleep 6
shot a-streaming

# --- 2. /new while A is answering -------------------------------------------
session_stems >"${BASELINE_STEMS}"
slash "/new"
expect_screen "keeps running" 30
sleep 1
shot b-new-while-a-runs

# --- 3. B gets its own turn -------------------------------------------------
submit "write a numbered list of sixty short facts about text editors, one line each"
sleep 6
shot b-streaming

# --- 4. back to A, which kept going ----------------------------------------
#
# Straight away, without waiting for anything on disk: every second spent here is
# a second of A's answer, and the status line under the transcript is the whole
# point of the frame — "still running" means `/resume` re-attached the live object
# rather than replaying a file.
slash "/resume ${A_STEM}"
expect_screen "terminal emulators" 45
sleep 2
shot a-resumed-still-live

# --- 5. and back to B, which also kept going -------------------------------
#
# B's stem is looked up here rather than before step 4 because the lookup is a
# wait, and waiting with A on screen is what makes B's transcript advance while
# nobody is watching it.
B_STEM="$(wait_for_new_stem 240)" ||
	abandon_take b-stem "the new session never produced a token, so nothing can name it to /resume"
echo "scene: session B is ${B_STEM}" >&2

slash "/resume ${B_STEM}"
expect_screen "text editors" 45
sleep 2
shot b-resumed-still-live

# --- 6. A's answer, finished ------------------------------------------------
#
# The closing frame: A's list is complete. Its first line was on screen in step 1
# and the rest of it arrived while A was in the background, so the transcript is
# the record of a turn that nothing here was watching.
slash "/resume ${A_STEM}"
expect_screen "terminal emulators" 45
settle_idle 300 6 2 20
shot a-completed-unattended
