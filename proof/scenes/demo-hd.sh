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

# Camera helpers for the directed secret take. Cues are capture frames at SCENE_FPS.
# zoom-in is the peak on `/secret` (left composer); pan is the value sliding right;
# zoom-out is the frame the camera is wide again.
_even() { echo $(( ($1 / 2) * 2 )); }
now_frame() {
	local ms=$(($(date +%s%3N) - SCENE_T0))
	echo $((ms * ${SCENE_FPS:-60} / 1000))
}
composer_crop() {
	local side="$1"
	local canvas_w="${SCENE_WIDTH:-2560}"
	local canvas_h="${SCENE_HEIGHT:-1440}"
	local crop_w crop_h x y max_x max_y
	crop_w=$(_even $((canvas_w / 2)))
	crop_h=$(_even $((canvas_h / 2)))
	y=$((WIN_Y + WIN_H - crop_h + CELL_H))
	max_y=$((canvas_h - crop_h))
	[ "$y" -lt 0 ] && y=0
	[ "$y" -gt "$max_y" ] && y=$max_y
	if [ "$side" = right ]; then
		x=$((WIN_X + WIN_W - crop_w))
	else
		x=$WIN_X
	fi
	max_x=$((canvas_w - crop_w))
	[ "$x" -lt 0 ] && x=0
	[ "$x" -gt "$max_x" ] && x=$max_x
	echo "$(_even "$x"),$(_even "$y"),${crop_w},${crop_h}"
}
type_visible() {
	local s="$1"
	local i
	for ((i = 0; i < ${#s}; i++)); do
		t "${s:i:1}"
		pause 0.05
	done
}
emit_cue() {
	printf '%s\n' "$1" >>"${SCENE_OUT}/${SCENE_NAME}-cues.txt"
}

# Operator setup: type `/secret` in the composer so the camera has something to follow.
# The key itself stays in the environment; from-env never echoes it.
: >"${SCENE_OUT}/${SCENE_NAME}-cues.txt"
clear_composer
pause 0.2
emit_cue "zoom-in $(now_frame) $(composer_crop left)"
type_visible "/secret "
pause 0.25
emit_cue "pan $(now_frame) $(composer_crop right)"
type_visible "from-env RELEASE_SIGNATURE release-signature"
pause 0.7
k Escape
pause 0.3
k Return
settle 8
if screen_has "release-signature" || screen_has "Stored" || screen_has "secret"; then
	echo "scene: release signing secret stored" >&2
else
	MISSED="${MISSED:-} secret-stored"
fi
shot secret-stored
# Hold the confirmation in the right-hand crop, then ease out before the short prompt.
settle 2
emit_cue "zoom-out $(now_frame)"
pause 0.6
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
