#!/usr/bin/env bash
# Record one arm of one commit, in a real terminal, inside the container.
#
#   record-commit-arm.sh <hash> <before|after> <hold-seconds> <command...>
#
# The arm decides which SOURCE the terminal runs: `after` is the commit's own
# tree, `before` is its first parent's. Nothing else differs -- same image, same
# seeded home, same command, same geometry -- so a difference between the two
# videos is the commit and cannot be anything else.
#
# The tree is a `git archive` extraction rather than a worktree: it costs under
# a second, carries no .git, and cannot be confused with a checkout someone is
# working in. `proof/captures` is excluded because it is 92MB of the branch's
# own recordings and no source depends on it.
#
# node_modules is bind-mounted from the working tree at /repo/node_modules. Its
# `@veyyon/*` entries are RELATIVE symlinks (`../../packages/tui`), so inside
# the container they resolve into the archived tree's own packages, not into the
# working tree. That is the whole reason the mount is safe: the arm runs the
# commit's source, and only its third-party dependencies come from outside.
#
# The rig -- scenes, xsession, seed -- is mounted separately at /rig from the
# CURRENT branch, because a commit from the middle of the branch predates the
# recorder itself. The scene is therefore the same for both arms of every
# commit, whatever the tree under it knows about recording.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HASH="${1:?usage: record-commit-arm.sh <hash> <arm> <hold> <command...>}"
ARM="${2:?arm}"
HOLD="${3:?hold seconds}"
shift 3
COMMAND="${*:?command}"

case "${ARM}" in
before) REF="${HASH}^" ;;
after) REF="${HASH}" ;;
*)
	echo "arm must be before or after" >&2
	exit 2
	;;
esac

TREES="${COMMIT_PROOF_TREES:-/media/mukund-thiru/SanthData/Santh/worktrees/.commit-proof}"
TREE="${TREES}/${HASH}-${ARM}"
OUT="${REPO_ROOT}/proof/captures/x11/commits/${HASH}-${ARM}"

rm -rf "${TREE}"
mkdir -p "${TREE}" "${OUT}"
git -C "${REPO_ROOT}" archive "${REF}" | tar -x -C "${TREE}" --exclude='proof/captures/*' -f -

# A test the commit ADDS does not exist in its parent, so the before arm would
# record a missing file instead of a failing assertion. Every non-shipped file
# the commit touched is copied into the before tree: the test is then identical
# in both arms and the only variable left is the shipped source it is pointed at.
# `packages/simulations` is the whole test-harness package (private, never
# published), so a suite whose harness grew a measurement in the same commit
# still compiles against the parent instead of dying on a missing export.
if [[ "${ARM}" == "before" && "${OVERLAY_TESTS:-1}" == "1" ]]; then
	while IFS= read -r f; do
		[[ -z "${f}" ]] && continue
		case "${f}" in
		*.test.ts | packages/simulations/src/*.ts | packages/simulations/src/*/*.ts | scripts/demos/*.ts | proof/scenes/*.sh) ;;
		*) continue ;;
		esac
		mkdir -p "${TREE}/$(dirname "${f}")"
		git -C "${REPO_ROOT}" show "${HASH}:${f}" >"${TREE}/${f}" 2>/dev/null || true
	done < <(git -C "${REPO_ROOT}" show --pretty= --name-only "${HASH}")
fi

# The command goes in as a FILE, never as an environment string: the terminal's
# bootstrap runs `exec ${SCENE_COMMAND}` unquoted, so a command carrying its own
# quotes is word-split into pieces and the terminal opens on a syntax error. The
# trailing sleep is what keeps the window alive after the command finishes --
# the scene, not the command, decides when the camera stops.
cat >"${OUT}/cmd.sh" <<EOF
cd /repo
${COMMAND}
echo
echo "--- command finished, arm=${ARM} ref=${REF}"
touch /tmp/scene-done
sleep 99999
EOF

docker run --rm \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--mount "type=bind,src=${TREE},dst=/repo" \
	--mount "type=bind,src=${REPO_ROOT}/node_modules,dst=/repo/node_modules,readonly" \
	--mount "type=bind,src=${REPO_ROOT}/proof,dst=/rig,readonly" \
	--mount "type=bind,src=${REPO_ROOT}/packages/natives/native/veyyon_natives.linux-x64-modern.node,dst=/repo/packages/natives/native/veyyon_natives.linux-x64-modern.node,readonly" \
	--mount "type=bind,src=${REPO_ROOT}/packages/natives/native/veyyon_natives.linux-x64-baseline.node,dst=/repo/packages/natives/native/veyyon_natives.linux-x64-baseline.node,readonly" \
	--mount "type=bind,src=${REPO_ROOT}/packages/coding-agent/src/export/html/tool-views.generated.js,dst=/repo/packages/coding-agent/src/export/html/tool-views.generated.js,readonly" \
	--mount "type=bind,src=${OUT},dst=/out" \
	--tmpfs /sandbox/home:exec,size=1g \
	--tmpfs /tmp:exec,size=2g \
	--shm-size=256m \
	-e HOME=/sandbox/home \
	-e TERM=xterm-kitty \
	-e COLORTERM=truecolor \
	-e LANG=C.UTF-8 \
	-e LC_ALL=C.UTF-8 \
	-e LOCAL_LLM_KEY=none \
	-e DISPLAY=:99 \
	-e VEYYON_TEST_HOST_HOME=/home/mukund-thiru \
	-e VEYYON_TEST_SANDBOX=docker-recorder \
	-e SCENE_LIB=/rig/scenes/lib.sh \
	-e "SCENE_COMMAND=bash /out/cmd.sh" \
	-e "SCENE_HOLD=${HOLD}" \
	-e "SCENE_WIDTH=${SCENE_WIDTH:-1280}" \
	-e "SCENE_HEIGHT=${SCENE_HEIGHT:-800}" \
	-e "SCENE_FONT_SIZE=${SCENE_FONT_SIZE:-14}" \
	-e "SCENE_FPS=${SCENE_FPS:-15}" \
	-e "SCENE_GIF_FPS=${SCENE_GIF_FPS:-8}" \
	-e "SCENE_GIF_WIDTH=${SCENE_GIF_WIDTH:-800}" \
	-e SCENE_TERMINAL=kitty \
	-e "SCENE_CWD=${SCENE_CWD:-/repo}" \
	-w /repo \
	"${RECORDER_IMAGE:-veyyon-proof-recorder:2}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /rig/docker/home-seed/. /sandbox/home/.veyyon/
		mkdir -p /sandbox/home/demo/src
		printf "export function parse(s) {\n\tif (!s) throw new Error(\"empty focus string\");\n\treturn s.trim();\n}\n" > /sandbox/home/demo/src/parser.ts
		printf "# demo\n\nA tiny project the recording drives.\n" > /sandbox/home/demo/README.md
		exec /rig/docker/xsession.sh /rig/scenes/'"${SCENE:-hold}"'.sh
	' >"${OUT}/record.log" 2>&1

mv -f "${OUT}/${SCENE:-hold}.mp4" "${OUT}/../${HASH}-${ARM}.mp4"
mv -f "${OUT}/${SCENE:-hold}.gif" "${OUT}/../${HASH}-${ARM}.gif"
rm -rf "${TREE}"
echo "recorded ${HASH}-${ARM}"
