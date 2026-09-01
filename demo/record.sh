#!/usr/bin/env bash
# Canonical Demo Recording & Post-Processing Pipeline
# Usage:
#   DEMO_MODEL=google-antigravity/gemini-3.7-flash DEMO_THINKING=high ./demo/record.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

DEMO_MODEL="${DEMO_MODEL:-google-antigravity/gemini-3.7-flash}"
DEMO_THINKING="${DEMO_THINKING:-high}"
PROOF_AUTH_DIR="${PROOF_AUTH_DIR:-${REPO_ROOT}/.internal/recording-auth}"

echo "=== 1. Building Standalone Binary & Native Addons ==="
if [[ ! -f packages/natives/native/veyyon_natives.linux-x64-modern.node && ! -f packages/natives/native/veyyon_natives.linux-x64-baseline.node ]]; then
	bun --cwd=packages/natives run ensure
fi
if [[ ! -f packages/coding-agent/src/export/html/tool-views.generated.js ]]; then
	bun --cwd=packages/collab-web run gen:tool-views
fi
bun --cwd=packages/coding-agent run build
echo "=== 2. Setting Up Recording Workspace ==="
WORK_BASE=".captures"
mkdir -p "${WORK_BASE}"
WORK="$(mktemp -d "${WORK_BASE}/veyyon-demo.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

RECORDER_IMAGE="veyyon-proof-recorder:bun1.4.0"
if ! docker image inspect "${RECORDER_IMAGE}" >/dev/null 2>&1; then
	docker build -t "${RECORDER_IMAGE}" -f proof/docker/Dockerfile.recorder proof/docker
fi

SIGNING_NUMBER="$(printf '%04d-%04d-%04d' $((RANDOM % 10000)) $((RANDOM % 10000)) $((RANDOM % 10000)))"

echo "=== 3. Recording Session at 2560x1440 with Night Theme ==="
AUTH_MOUNTS=()
if [[ -d "${PROOF_AUTH_DIR}" ]]; then
	AUTH_MOUNTS+=(--mount "type=bind,src=${PROOF_AUTH_DIR},dst=/host-auth,readonly")
fi

GPU_ARGS=()
if [ -d /dev/dri ]; then
	GPU_ARGS+=(--device /dev/dri)
	if [ -e /dev/dri/renderD128 ]; then
		RENDER_GID="$(stat -c %g /dev/dri/renderD128 2>/dev/null || echo 992)"
		GPU_ARGS+=(--group-add "${RENDER_GID}")
	fi
fi

docker run --rm \
	"${AUTH_MOUNTS[@]}" \
	"${GPU_ARGS[@]}" \
	--network "veyyon-proof" \
	--add-host "host.docker.internal:host-gateway" \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo" \
	--mount "type=bind,src=${REPO_ROOT}/proof/docker/home-seed,dst=/seed,readonly" \
	--mount "type=bind,src=$(cd "${WORK}" && pwd),dst=/out" \
	--tmpfs /sandbox/home:exec,size=1g \
	--tmpfs /tmp:exec,size=2g \
	--shm-size=512m \
	-e HOME=/sandbox/home \
	-e TERM=xterm-kitty \
	-e COLORTERM=truecolor \
	-e LANG=C.UTF-8 \
	-e LC_ALL=C.UTF-8 \
	-e SCENE_HIDE_THINKING=1 \
	-e "SCENE_COMMAND=/repo/packages/coding-agent/dist/vey --model ${DEMO_MODEL} --thinking ${DEMO_THINKING}" \
	-e SCENE_THEME=night \
	-e SCENE_WIDTH=2560 \
	-e SCENE_HEIGHT=1440 \
	-e SCENE_FPS=30 \
	-e SCENE_MARGIN=128 \
	-e SCENE_FONT_SIZE=15 \
	-e SCENE_BG="#171b22" \
	-e SCENE_FG="#d3dae6" \
	-e SCENE_CWD=/sandbox/home/demo/ship-sim \
	-e "SCENE_SIGNING_NUMBER=${SIGNING_NUMBER}" \
	-e OUT_DIR=/out \
	-w /repo \
	"${RECORDER_IMAGE}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /seed/. /sandbox/home/.veyyon/
		if [ -d /host-auth ]; then
			mkdir -p /sandbox/home/.veyyon/shared-auth /sandbox/home/.veyyon/profiles/default/agent
			cp -a /host-auth/. /sandbox/home/.veyyon/shared-auth/
			cp -a /host-auth/. /sandbox/home/.veyyon/profiles/default/agent/
		fi
		chown -R "$(id -u):$(id -g)" /sandbox/home || true
		chmod -R 777 /sandbox/home/.veyyon || true
		printf "hideThinkingBlock: true\n" >> /sandbox/home/.veyyon/profiles/default/agent/config.yml
		printf "todo.reminders: false\n" >> /sandbox/home/.veyyon/profiles/default/agent/config.yml
		bash /repo/proof/docker/seed-demo.sh /sandbox/home/demo
		exec /repo/proof/docker/xsession.sh /repo/demo/scene.sh
	'

echo "=== 4. Compositing Post-Processing Chrome (Backdrop, Curves, Shadows) ==="
docker run --rm \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo" \
	--mount "type=bind,src=$(cd "${WORK}" && pwd),dst=/out" \
	-w /repo \
	"${RECORDER_IMAGE}" \
	bash -c "SCENE_WIDTH=2560 SCENE_HEIGHT=1440 SCENE_MARGIN=128 SCENE_RADIUS=26 bash proof/compose-chrome.sh /out/scene.mp4 /out/demo-hd-composited.mp4"

echo "=== 5. Cutting and Resampling WebP & MP4 Assets ==="
mkdir -p assets website proof/captures/x11

python3 proof/hero-cut.py "${WORK}/demo-hd-composited.mp4" \
	--mp4 "${WORK}/demo-hd-cut.mp4" \
	--webp "${WORK}/demo-hd.webp" \
	--width 1920 --webp-width 1920 \
	--marks "${WORK}/scene-marks.tsv" \
	--speed 6 \
	--edge-speed 1.0 \
	--real-through-mark agent-lanes \
	--real-from-mark build-verified \
	--mark-lead-max 90 \
	--hold 5 \
	--crf 26 \
	--still-keep 5 \
	--still-min 4 \
	--speed-badge \
	--fps 30 \
	--webp-fps 30

# Apply smooth slow fadeaway (1.5s) to the end of the video
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "${WORK}/demo-hd-cut.mp4" 2>/dev/null || echo 0)"
if (( $(echo "${DURATION} > 2.0" | bc -l) )); then
	FADE_START="$(python3 -c "print(max(0.0, float('${DURATION}') - 1.5))")"
	ffmpeg -loglevel error -y -i "${WORK}/demo-hd-cut.mp4" -vf "fade=t=out:st=${FADE_START}:d=1.5" -c:v libx264 -preset slow -crf 22 "${WORK}/demo-hd-faded.mp4"
	mv "${WORK}/demo-hd-faded.mp4" "${WORK}/demo-hd-cut.mp4"
fi

python3 proof/webp-cadence.py "${WORK}/demo-hd.webp" --expect-ms 33 || true

cp "${WORK}/demo-hd.webp" assets/demo-hd.webp
cp "${WORK}/demo-hd.webp" website/demo-hd.webp
cp "${WORK}/demo-hd-cut.mp4" assets/demo-hd.mp4
cp "${WORK}/demo-hd-cut.mp4" proof/captures/x11/demo-hd-cut.mp4
cp "${WORK}/scene.mp4" proof/captures/x11/demo-hd.mp4

for still in "${WORK}/scene"-*.png; do
	[ -f "${still}" ] || continue
	base="$(basename "${still}" .png)"
	out_name="demo-hd-${base#scene-}"
	cp "${still}" "proof/captures/x11/${out_name}.png"
	convert "${still}" -resize 1920x -strip "assets/${out_name}.png"
done

echo "=== Demo Recording & Compositing Complete ==="
echo "Artifacts generated successfully."
