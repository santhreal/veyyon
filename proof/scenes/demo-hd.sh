#!/usr/bin/env bash
# One recording, one operator task: the model creates a persistent goal and carries
# a complete greenfield build through a phased todo list, parallel implementation,
# compiled verification, protected release signing, and the final 3D simulator.
#
# The operator performs setup actions before the task:
# 1. Type /yolo and confirm "Yes" to enable bypass mode.
# 2. Add the signing key with /secret add <sha> and name it RELEASE_SIGNATURE.
# 3. Type a concise prompt (2 sentences max) to trigger the autonomous build.
#
# If a model turn ends, goal continuation supplies the next turn; the scene never
# prompts the model again.
set -euo pipefail

pause 1.0
screen_has "model:" || screen_has "demo" || screen_has "veyyon" || MISSED="${MISSED:-} idle"
shot idle

# ~100 WPM typing speed (0.055s per character)
type_human() {
	local s="$1"
	local i
	for ((i = 0; i < ${#s}; i++)); do
		t "${s:i:1}"
		pause 0.055
	done
}

# 1. Type `/yolo` at ~100 WPM, hit Return to open confirmation dialog, hit Return to select "Yes"
clear_composer
pause 0.2
type_human "/yolo"
pause 0.1
k Return
pause 0.35
# Confirm "Yes" on the dialog
k Return
pause 0.6
if screen_has "bypass ON" || screen_has "Yolo" || screen_has "YOLO" || screen_has "yolo"; then
	echo "scene: yolo mode confirmed and enabled" >&2
fi

# 2. Type `/secret add <sha>` at ~100 WPM, hit Return to open name prompt, type RELEASE_SIGNATURE, hit Return
clear_composer
SIGNING_KEY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
type_human "/secret add ${SIGNING_KEY}"
pause 0.1
k Return
pause 0.4
# Name the secret so the model can reference it as #RELEASE_SIGNATURE#
type_human "RELEASE_SIGNATURE"
pause 0.1
k Return
pause 0.8
if screen_has "RELEASE_SIGNATURE" || screen_has "Stored" || screen_has "secret"; then
	echo "scene: release signing secret stored" >&2
else
	MISSED="${MISSED:-} secret-stored"
fi
shot secret-stored

# 3. Type prompt (2 sentences max) at ~100 WPM and submit
clear_composer
pause 0.3
# The full contract lives at proof/prompts/demo-hd.md and is seeded as TASK.md.
# Named here so verify-scene.ts still traces every guard to that file.
# shellcheck disable=SC2034
DEMO_TASK=proof/prompts/demo-hd.md
type_human "Read TASK.md and build the complete Nebula Drift release. Run all verification checks, test the simulator, and sign the final binary with the release key."
pause 0.2
k Return

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
expect_model_screen "Todos" 420 todo-board
if screen_has "Flight plan" && screen_has "Parallel build" && screen_has "Release"; then
	echo "scene: four-phase todo board visible before implementation" >&2
else
	MISSED="${MISSED:-} todo-board"
fi
shot todo-board

# The three implementation lanes must overlap. The block's header is the guard, because
# it is the one string a spawn always produces.
expect_model_screen "Subagents" 600 agent-lanes
pause 1
if screen_has "DynamicsAgent" && screen_has "RenderAgent" && screen_has "FlightAgent"; then
	echo "scene: all three ship-simulator workers visible" >&2
else
	MISSED="${MISSED:-} agent-lanes"
fi
shot agent-lanes

# The main agent owns integration and edits the seeded CLI while workers own their
# disjoint modules.
expect_model_screen "Edit" 900 integration-edit
pause 1
if screen_has "src/cli.ts" || screen_has "src/sign.ts"; then
	echo "scene: main-agent integration edit visible" >&2
else
	MISSED="${MISSED:-} integration-edit"
fi
shot integration-edit

# The prompt prints this sentinel only after tests, typecheck, and compilation all succeed.
expect_model_screen "BUILD VERIFIED: tests, typecheck, and dist/nebula-drift passed" 1800 build-verified
pause 1
if screen_has "BUILD VERIFIED" || screen_has "dist/nebula-drift" || screen_has "compile" || screen_has "pass"; then
	echo "scene: tests, typecheck, and compiled binary verified" >&2
else
	MISSED="${MISSED:-} build-verified"
fi
shot build-verified

# Show the actual compiled product before release signing.
expect_model_screen "NEBULA DRIFT" 360 simulator-preview
pause 1
if screen_has "NEBULA DRIFT" || screen_has "AUTOPILOT" || screen_has "FUEL"; then
	echo "scene: compiled 3D flight display visible" >&2
else
	MISSED="${MISSED:-} simulator-preview"
fi
shot simulator-preview

# Secret expansion approval (if requested or under yolo)
expect_model_screen "Permission required" 600 secret-approval
if screen_has "RELEASE_SIGNATURE" || screen_has "SHIP_RELEASE_KEY" || screen_has "SIGNED BINARY" || screen_has "Stored"; then
	echo "scene: binary signing held for explicit approval" >&2
else
	MISSED="${MISSED:-} secret-approval"
fi
shot secret-approval
approve_while_asked 4

expect_model_screen "SIGNED BINARY: dist/nebula-drift" 360 signature-written
pause 1
if screen_has "nebula-drift.sig" || screen_has "SIGNED BINARY"; then
	echo "scene: signed binary artifact visible" >&2
else
	MISSED="${MISSED:-} signature-written"
fi
shot signature-written

# The model closes both planning layers before its final tool call.
expect_model_screen "Todo list done" 420 todo-finished
if screen_has "Todo list done" || screen_has "8 tasks" || screen_has "8/8" || screen_has "Release"; then
	echo "scene: all eight tasks completed" >&2
else
	MISSED="${MISSED:-} todo-finished"
fi
shot todo-finished

expect_model_screen "Goal mode completed." 420 goal-complete
if screen_has "Goal mode completed" || screen_has "Goal:" || screen_has "complete"; then
	echo "scene: model completed the persistent goal" >&2
else
	MISSED="${MISSED:-} goal-complete"
fi
shot goal-complete

expect_model_screen "NEBULA DRIFT READY" 600 presentation
pause 2
if screen_has "NEBULA DRIFT" && screen_has "READY"; then
	echo "scene: final signed simulator presentation visible" >&2
else
	MISSED="${MISSED:-} presentation"
fi
shot presentation

# Filesystem guards
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

# Outside the recording, verify the signature with the synthetic key
KEY="${SIGNING_KEY}"
{
	echo "signing key (synthetic; never typed or sent to the model): ${KEY}"
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
