#!/usr/bin/env bash
# The docker rung: a container on THIS host, sharing this kernel.
#
# Usage: sourced by scripts/test-sandbox/run.sh; not run directly. It defines
# probe_docker, run_docker and binprobe_docker and reads REPO_ROOT, GUEST_REPO,
# GUEST_IMAGE and HOST_HOME from the driver.
#
# The boundary is the mount and user namespace the daemon sets up. /home is a
# fresh empty tmpfs, HOME points at another tmpfs, and the only host path in the
# container's mount table is the repo. The kernel is shared, which is what makes
# this the fast rung and the microVM the stronger one.

probe_docker() {
	command -v docker >/dev/null 2>&1 || { skip docker "docker not on PATH"; return 1; }
	docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || { skip docker "docker daemon not reachable by uid $(id -u)"; return 1; }
	# The rung runs the SAME image the microVM boots, so a suite behaves identically
	# whichever rung it lands on. The stock oven/bun image is not usable directly: it
	# has no git, and a suite that shells out to git then fails for an environment
	# reason while looking exactly like a code regression.
	docker image inspect "${GUEST_IMAGE}" >/dev/null 2>&1 || {
		skip docker "guest image ${GUEST_IMAGE} is not built; run 'bash scripts/test-sandbox/run.sh --build' (about 35s, cached afterwards)"
		return 1
	}
	return 0
}

run_docker() {
	local repo_mode=rw
	[ "${VEYYON_SANDBOX_REPO_RO:-0}" = "1" ] && repo_mode=ro

	# The repo bind is read-write by default because the suite legitimately writes
	# build output and caches into the tree, and the contract that matters is the
	# home, not the repo. VEYYON_SANDBOX_REPO_RO=1 makes it read-only, which is what
	# the hostile-test proof run uses.
	#
	# The bind names only the repo. /home/<operator> is not in this container's
	# mount table at any path: /home is a fresh empty tmpfs and HOME is elsewhere.
	# VEYYON_TEST_HOST_HOME names the host path the sandbox claims to have removed from
	# the guest's filesystem view. The gate re-derives nothing from it; it simply proves
	# the path is unreadable and refuses if it is not. Declaring it is what turns "a
	# marker was set" into "a specific directory is provably out of reach".
	local -a env_args=(
		-e "VEYYON_TEST_SANDBOX=container-docker"
		-e "VEYYON_TEST_HOST_HOME=${HOST_HOME}"
		-e "HOME=/sandbox/home"
		-e "TMPDIR=/tmp"
		-e "XDG_CONFIG_HOME=/sandbox/home/.config"
		-e "XDG_CACHE_HOME=/sandbox/home/.cache"
		-e "XDG_DATA_HOME=/sandbox/home/.local/share"
		-e "XDG_STATE_HOME=/sandbox/home/.local/state"
		-e "BUN_INSTALL_CACHE_DIR=/sandbox/home/.bun/install/cache"
	)
	local name
	for name in CI GITHUB_ACTIONS TERM FORCE_COLOR NO_COLOR ${VEYYON_SANDBOX_FORWARD:-}; do
		[ -n "${!name:-}" ] && env_args+=(-e "${name}=${!name}")
	done

	local -a mount_args=(--mount "type=bind,src=${REPO_ROOT},dst=${GUEST_REPO}")
	[ "$repo_mode" = ro ] && mount_args=(--mount "type=bind,src=${REPO_ROOT},dst=${GUEST_REPO},readonly")

	local -a tty_args=()
	[ -t 0 ] && [ -t 1 ] && tty_args=(-it)

	docker run --rm "${tty_args[@]}" \
		--network none \
		--user "$(id -u):$(id -g)" \
		"${mount_args[@]}" \
		--tmpfs "/home:rw,mode=0755" \
		--tmpfs "/tmp:rw,mode=1777" \
		--tmpfs "/sandbox:rw,mode=1777" \
		-w "${GUEST_REPO}" \
		"${env_args[@]}" \
		--entrypoint /bin/sh \
		"${GUEST_IMAGE}" \
		-c 'mkdir -p "$HOME/.bun/install/cache" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"; exec "$@"' _ "$@"
}

# Used by --probe to list which binaries the rung provides.
binprobe_docker() { docker run --rm --entrypoint /bin/sh "${GUEST_IMAGE}" -c "$1"; }
