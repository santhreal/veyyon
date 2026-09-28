#!/usr/bin/env bash
# Measures one app with every desktop bench probe on a private display.
#
#   scripts/desktop-bench/run.sh <veyyon|t3> [--binary PATH] [--samples N] [--out DIR]
#                                [--name NAME] [--probes LIST] [--survey [X,Y ...]]
#
# Starts a private headless sway session (session.sh), runs probes.py against
# the app on that session's Xwayland display, writes <out>/<name>.json and
# <out>/<name>.md, and stops the session. --binary defaults to $BENCH_VEYYON_BIN
# or $BENCH_T3_APP. bun, codex and node come from $BENCH_BUN, $BENCH_CODEX and
# $BENCH_NODE, else from PATH.
set -euo pipefail

BENCH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="$(cd -- "${BENCH_DIR}/../.." && /bin/pwd -P)"

usage() {
	printf 'usage: %s <veyyon|t3> [--binary PATH] [--samples N] [--out DIR] [--name NAME] [--probes LIST] [--survey [X,Y ...]]\n' "$0" >&2
	exit 2
}

die() {
	printf 'run.sh: %s\n' "$*" >&2
	exit 1
}

app="${1:-}"
[ $# -gt 0 ] && shift
case "${app}" in
veyyon | t3) ;;
*) usage ;;
esac

binary=""
samples=20
out="${REPO_ROOT}/.internal/rebuild/bench"
pass=()
while [ $# -gt 0 ]; do
	case "$1" in
	--binary)
		[ $# -ge 2 ] || usage
		binary="$2"
		shift 2
		;;
	--samples)
		[ $# -ge 2 ] || usage
		samples="$2"
		shift 2
		;;
	--out)
		[ $# -ge 2 ] || usage
		out="$2"
		shift 2
		;;
	-h | --help) usage ;;
	*)
		pass+=("$1")
		shift
		;;
	esac
done

if [ -z "${binary}" ]; then
	case "${app}" in
	veyyon) binary="${BENCH_VEYYON_BIN:-}" ;;
	t3) binary="${BENCH_T3_APP:-}" ;;
	esac
fi
[ -n "${binary}" ] || die "no ${app} binary; pass --binary or set BENCH_VEYYON_BIN / BENCH_T3_APP"
[ -x "${binary}" ] || die "${binary} is not an executable file"
binary="$(realpath -- "${binary}")"
mkdir -p -- "${out}"
out="$(realpath -- "${out}")"

tool() {
	local override="${!1:-}"
	if [ -n "${override}" ]; then
		printf '%s' "${override}"
	else
		command -v "$2" || true
	fi
}

args=(--app "${app}" --binary "${binary}" --samples "${samples}" --out "${out}")
case "${app}" in
veyyon)
	bun="$(tool BENCH_BUN bun)"
	[ -n "${bun}" ] || die "bun is not on PATH; set BENCH_BUN"
	args+=(--bun "${bun}")
	;;
t3)
	codex="$(tool BENCH_CODEX codex)"
	node="$(tool BENCH_NODE node)"
	[ -n "${codex}" ] || die "codex is not on PATH; set BENCH_CODEX"
	[ -n "${node}" ] || die "node is not on PATH; set BENCH_NODE"
	args+=(--codex "${codex}" --node "${node}")
	;;
esac

session_env="$("${BENCH_DIR}/session.sh" start)"
trap '"${BENCH_DIR}/session.sh" stop' EXIT
while IFS='=' read -r key value; do
	case "${key}" in
	DISPLAY | WAYLAND_DISPLAY | SWAYSOCK | XDG_RUNTIME_DIR) export "${key}=${value}" ;;
	esac
done <<<"${session_env}"

export PYTHONDONTWRITEBYTECODE=1
python3 "${BENCH_DIR}/probes.py" "${args[@]}" \
	--display "${DISPLAY}" --runtime-dir "${XDG_RUNTIME_DIR}" --swaysock "${SWAYSOCK}" \
	"${pass[@]}"
