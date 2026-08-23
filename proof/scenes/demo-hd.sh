#!/usr/bin/env bash
# One recording, one operator task: the model creates a persistent goal and carries
# a complete greenfield build through a phased todo list, parallel implementation,
# compiled verification, protected release signing, and the final 3D simulator.
#
# The operator performs only one setup action before the task: ingest the synthetic
# signing key with /secret. One user prompt then runs to completion. If a model turn
# ends, goal continuation supplies the next turn; the scene never prompts the model
# again.
#
# The signing proof is independently checkable. The model sees only the
# #RELEASE_SIGNATURE# placeholder. Veyyon resolves it at the outbound bash
# boundary, shows the real command to the operator for approval, and leaves an
# HMAC-SHA256 signature beside the compiled binary.
set -euo pipefail

settle 16
screen_has "model:" || screen_has "demo" || screen_has "veyyon" || MISSED="${MISSED:-} idle"
shot idle

# Operator setup: store the key without typing it into the transcript.
slash "/secret from-env RELEASE_SIGNATURE release-signature"
settle 8
if screen_has "release-signature" || screen_has "Stored" || screen_has "secret"; then
	echo "scene: release signing secret stored" >&2
else
	MISSED="${MISSED:-} secret-stored"
fi
shot secret-stored

# Hold the stored-secret confirmation long enough to read at 1080p once the
# camera has moved in. The cue file is the camera: zoom-in on this mark, zoom-out
# as the short prompt is typed. The long task lives on disk as TASK.md so the
# composer shows a line a viewer can actually read.
settle 3
secret_t="$(awk -F '\t' '$1=="secret-stored"{print $2; exit}' "${SCENE_OUT}/${SCENE_NAME}-marks.tsv")"
python3 - "${SCENE_OUT}/${SCENE_NAME}-cues.txt" "${secret_t}" <<'CUE'
from pathlib import Path
import sys
out, secret_t = Path(sys.argv[1]), float(sys.argv[2])
fps = 30
start = int(round(secret_t * fps))
end = start + int(round(3.0 * fps))
out.write_text(f"zoom-in {start}\nzoom-out {end}\n")
CUE
# The full contract lives at proof/prompts/demo-hd.md and is seeded as TASK.md.
# Named here so verify-scene.ts still traces every guard to that file.
# shellcheck disable=SC2034
DEMO_TASK=proof/prompts/demo-hd.md
submit "Read TASK.md and do exactly what it says."

# The model, not an operator slash command, creates the persistent owner of the
# long run before reading or planning.
expect_model_screen "Goal:" 420 goal-created
if screen_has "Nebula Drift" && { screen_has "active" || screen_has "Goal:"; }; then
	echo "scene: model-created persistent build goal visible" >&2
else
	MISSED="${MISSED:-} goal-created"
fi
shot goal-created
# The model must plan before mutation and keep the board alive through the whole
# task. Capture it while the same turn continues into implementation.
#
# The guard waits for the board's header, which is the word alone: the board used to print
# "Todo 0/8 tasks" and now carries no count, so a scene pinned to the count waited out its whole
# timeout and published the previous take's frame under this name. The phase names below are what
# prove the board is the one this prompt asked for.
expect_model_screen "Todos" 420 todo-board
if screen_has "Flight plan" && screen_has "Parallel build" && screen_has "Release"; then
	echo "scene: four-phase todo board visible before implementation" >&2
else
	MISSED="${MISSED:-} todo-board"
fi
shot todo-board

# The three implementation lanes must overlap. The block's header is the guard, because
# it is the one string a spawn always produces; a lane's NAME is the model's choice, and a
# take that waited 1200s on one name then spent every later ceiling in series. The names
# below are content checks on the frame, so a run with different names records the miss
# and keeps going.
expect_model_screen "Subagents" 600 agent-lanes
pause 2
if screen_has "DynamicsAgent:" && screen_has "RenderAgent:" && screen_has "FlightAgent:" && ! screen_has "Error:"; then
	echo "scene: all three ship-simulator workers visible" >&2
else
	MISSED="${MISSED:-} agent-lanes"
fi
shot agent-lanes

# The main agent owns integration and edits the seeded CLI while workers own their
# disjoint modules. This is still the original user turn or a goal continuation,
# never a new operator instruction.
expect_model_screen "Edit" 900 integration-edit
pause 2
if screen_has "src/cli.ts" || screen_has "src/sign.ts"; then
	echo "scene: main-agent integration edit visible" >&2
else
	MISSED="${MISSED:-} integration-edit"
fi
shot integration-edit

# The prompt prints this sentinel only after tests, typecheck, and compilation all
# succeed. Everything between the worker launch and this mark is the modest 1.25x
# section of the published cut.
expect_model_screen "BUILD VERIFIED: tests, typecheck, and dist/nebula-drift passed" 1800 build-verified
pause 2
if screen_has "BUILD VERIFIED" && ! screen_has "fail" && ! screen_has "error:"; then
	echo "scene: tests, typecheck, and compiled binary verified" >&2
else
	MISSED="${MISSED:-} build-verified"
fi
shot build-verified

# Show the actual compiled product before release signing.
expect_model_screen "NEBULA DRIFT" 360 simulator-preview
pause 2
if screen_has "AUTOPILOT" && screen_has "FUEL" && screen_has "GATE"; then
	echo "scene: compiled 3D flight display visible" >&2
else
	MISSED="${MISSED:-} simulator-preview"
fi
shot simulator-preview

# Secret expansion raises an explicit permission dialog. The model-authored command
# carries only the placeholder; the operator sees the resolved command before it runs.
expect_model_screen "Permission required" 600 secret-approval
if screen_has "RELEASE_SIGNATURE" || screen_has "release-signature" || screen_has "SHIP_RELEASE_KEY"; then
	echo "scene: binary signing held for explicit approval" >&2
else
	MISSED="${MISSED:-} secret-approval"
fi
shot secret-approval
approve_while_asked 6

expect_model_screen "SIGNED BINARY: dist/nebula-drift" 360 signature-written
pause 2
if screen_has "nebula-drift.sig" || screen_has "SIGNED BINARY"; then
	echo "scene: signed binary artifact visible" >&2
else
	MISSED="${MISSED:-} signature-written"
fi
shot signature-written

# The model closes both planning layers before its final tool call. This proves the
# list was worked, not merely created, and that model-visible goal completion is real.
expect_model_screen "Todo list done" 420 todo-finished
if screen_has "8 tasks" || screen_has "8/8"; then
	echo "scene: all eight tasks completed" >&2
else
	MISSED="${MISSED:-} todo-finished"
fi
shot todo-finished

# "Status: complete" is only ever drawn inside the goal details panel, which this scene never
# opens. What a completing session prints is the notice below, so that is what the shot waits for.
expect_model_screen "Goal mode completed." 420 goal-complete
if screen_has "Goal mode completed."; then
	echo "scene: model completed the persistent goal" >&2
else
	MISSED="${MISSED:-} goal-complete"
fi
shot goal-complete

expect_model_screen "NEBULA DRIFT READY" 600 presentation
pause 3
if screen_has "NEBULA DRIFT" && screen_has "AUTOPILOT" && screen_has "binary signed"; then
	echo "scene: final signed simulator presentation visible" >&2
else
	MISSED="${MISSED:-} presentation"
fi
shot presentation

# Filesystem guards are stronger than transcript prose. A plausible summary cannot
# publish unless the executable, signature, and complete implementation exist.
demo_dir="${SCENE_CWD:-/sandbox/home/demo/ship-sim}"
required=(
	"${demo_dir}/src/math.ts"
	"${demo_dir}/src/physics.ts"
	"${demo_dir}/src/autopilot.ts"
	"${demo_dir}/src/renderer.ts"
	"${demo_dir}/src/sign.ts"
	"${demo_dir}/src/cli.ts"
	"${demo_dir}/dist/nebula-drift"
	"${demo_dir}/dist/nebula-drift.sig"
)
for path in "${required[@]}"; do
	if [ ! -s "${path}" ]; then
		MISSED="${MISSED:-} missing-artifact:$(basename "${path}")"
	fi
done
if [ ! -x "${demo_dir}/dist/nebula-drift" ]; then
	MISSED="${MISSED:-} binary-not-executable"
fi

# Outside the recording, verify the signature with the synthetic key and preserve
# the result beside the take. The key is never sent to the model or transcript.
KEY="${SCENE_SIGNING_NUMBER:-${RELEASE_SIGNATURE:-}}"
{
	echo "signing key (synthetic; never typed or sent to the model): ${KEY:-<unset>}"
	python3 /repo/proof/verify-binary-signature.py \
		"${demo_dir}/dist/nebula-drift" \
		"${demo_dir}/dist/nebula-drift.sig" \
		--key "${KEY}"
	echo "--- dist/nebula-drift.sig ---"
	cat "${demo_dir}/dist/nebula-drift.sig"
} >"${SCENE_OUT}/signature-crosscheck.txt" 2>&1 || MISSED="${MISSED:-} signature-crosscheck"

if [ -n "${MISSED:-}" ]; then
	echo "scene: these proofs did not land:${MISSED}" >&2
	echo "scene: nothing may be published from this take" >&2
	exit 1
fi
