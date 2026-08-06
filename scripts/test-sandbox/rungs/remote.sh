#!/usr/bin/env bash
# The remote rung: the docker rung's container boundary, on another machine.
#
# Usage: sourced by scripts/test-sandbox/run.sh, which is the supported way to
# reach it. The one direct entry point is the guest build:
#
#   bash scripts/test-sandbox/run.sh --rung=remote --build
#   bash scripts/test-sandbox/run.sh --rung=remote bun test <paths>
#
# It defines probe_remote, run_remote and binprobe_remote and reads REPO_ROOT,
# GUEST_IMAGE, BUN_VERSION and HOST_HOME from the driver.
#
# WHY IT EXISTS
# -------------
# The suite is the heaviest thing this repo does to the machine a person is typing
# on. Every rung below runs it on that machine. This one runs the identical
# container on a second box over the LAN, so a `bun test` costs the workstation an
# rsync and an ssh session instead of 32 cores of load. It is FIRST in the
# selection order on a workstation and absent from it on GitHub Actions; see the
# SELECTION ORDER note in run.sh.
#
# WHY THE LAN ADDRESS AND NOT THE TAILSCALE NAME
# ----------------------------------------------
# The host is also on Tailscale, and `ssh axiomexec` goes through Tailscale SSH,
# which answers with "Tailscale SSH requires an additional check" and a browser URL
# that a script cannot satisfy. The LAN address reaches the host's ordinary sshd
# with the ordinary key and needs no interactive step. Do not switch this back to
# the Tailscale name; override VEYYON_SANDBOX_REMOTE_HOST instead.
#
# WHAT IS BLOCKED, AND BY WHICH MECHANISM
# ---------------------------------------
# The operator's condition for lending the machine was that catastrophic commands
# be blocked. This is the enumerated list, not a disposition. Each line is a flag
# or a structural fact, and the README repeats it for readers who never open this
# file.
#
#   the host filesystem      Only the synced work tree is bind-mounted, at
#                            /srv/veyyon. No other host path is in the container's
#                            mount table, so `rm -rf /` inside deletes a tmpfs and
#                            the work tree, and nothing else on that box.
#   the remote home          /home is a fresh tmpfs and HOME points into another
#                            one, so the remote user's home is not addressable
#                            either. Asserted at container start, see GUEST_ENTRY.
#   root                     --user <uid>:<gid> runs as the unprivileged remote
#                            account, never root.
#   privilege escalation     --cap-drop=ALL and --security-opt=no-new-privileges,
#                            so a setuid binary in the image grants nothing.
#   --privileged             Never passed. Neither is --cap-add, --device,
#                            --pid=host, --ipc=host or --userns=host.
#   the docker socket        /var/run/docker.sock is not mounted. A container that
#                            can talk to the daemon owns the host, which is the
#                            single most common way a sandbox like this is a lie.
#   the network              --network none. No egress, no LAN, no metadata
#                            service; loopback only.
#   pinning the box          --cpus, --memory and --pids-limit bound what one run
#                            can take, and the whole run is wrapped in
#                            `timeout -k 10 $VEYYON_SANDBOX_TIMEOUT` (default 1800)
#                            with a `docker rm -f` after it, so a wedged suite
#                            cannot hold the machine.
#   filling the disk         The work tree is the only writable host path and it
#                            is one rsync target under the remote user's home, not
#                            a shared location.
#
# What this does NOT block, stated plainly: the ssh account itself is in the
# docker group, so anyone who can run this rung can already run any container on
# that host. The boundary here protects the host from the TEST SUITE, which is the
# thing that actually runs unreviewed code. It is not a boundary against the
# person holding the key.
#
# HOW THE TREE GETS THERE
# -----------------------
# rsync over the same ssh connection, honouring .gitignore, with node_modules,
# target/, .build/, binaries/ and dist/ excluded outright. Dependencies are
# installed once on the remote by a SEPARATE container that has network, keyed on
# the lockfile hash, because the test container has none. That split is deliberate:
# the container that runs unreviewed test code never has a route out.

REMOTE_SSH_DEST="${VEYYON_SANDBOX_REMOTE_HOST:-axiomexec@192.168.0.135}"
REMOTE_SSH_KEY="${VEYYON_SANDBOX_REMOTE_KEY:-${HOME}/.ssh/id_ed25519}"
# Where the repo appears inside the remote container. Always /srv, never the work
# tree's own path: the work tree lives under the remote user's home, and mirroring
# that path would recreate a home directory inside the sandbox.
REMOTE_GUEST_REPO=/srv/veyyon
REMOTE_TREE_REL="veyyon-sandbox/$(basename "${REPO_ROOT}")"

# One multiplexed ssh connection for the probe, the sync and the run. Without it a
# single invocation pays three TCP handshakes and three key exchanges, which is
# most of the rung's fixed cost.
remote_ssh() {
	ssh -o BatchMode=yes \
		-o ConnectTimeout="${VEYYON_SANDBOX_REMOTE_CONNECT_TIMEOUT:-8}" \
		-o StrictHostKeyChecking=accept-new \
		-o ControlMaster=auto \
		-o ControlPath="/dev/shm/veyyon-sandbox-ssh-%r@%h:%p" \
		-o ControlPersist=300 \
		-i "${REMOTE_SSH_KEY}" \
		"$@"
}

# Cached across the probe and the run inside one invocation.
REMOTE_HOME=""
REMOTE_IDS=""

probe_remote() {
	command -v ssh >/dev/null 2>&1 || { skip remote "ssh not on PATH"; return 1; }
	command -v rsync >/dev/null 2>&1 || { skip remote "rsync not on PATH; the work tree cannot be shipped to ${REMOTE_SSH_DEST}"; return 1; }
	[ -r "${REMOTE_SSH_KEY}" ] || { skip remote "ssh key ${REMOTE_SSH_KEY} is not readable; set VEYYON_SANDBOX_REMOTE_KEY"; return 1; }

	# One round trip answers reachability, the remote home, the remote uid/gid and
	# whether docker is usable by that account. Four probes would be four round
	# trips and the same information.
	local out err probe_script
	probe_script='printf "VSHOME=%s\n" "$HOME"; printf "VSIDS=%s:%s\n" "$(id -u)" "$(id -g)"; printf "VSDOCKER=%s\n" "$(docker version --format "{{.Server.Version}}" 2>&1 | head -n1)"'
	if ! out="$(remote_ssh "${REMOTE_SSH_DEST}" "${probe_script}" 2>&1)"; then
		err="$(printf '%s' "$out" | tr '\n' ' ')"
		skip remote "cannot reach ${REMOTE_SSH_DEST} over ssh: ${err:-connection failed}"
		return 1
	fi
	# Keyed lines rather than positions: an ssh banner or a shell rc that prints
	# would otherwise shift every field by one and misreport the remote home.
	REMOTE_HOME="$(printf '%s\n' "$out" | sed -n 's/^VSHOME=//p' | head -n1)"
	REMOTE_IDS="$(printf '%s\n' "$out" | sed -n 's/^VSIDS=//p' | head -n1)"
	local docker_version
	docker_version="$(printf '%s\n' "$out" | sed -n 's/^VSDOCKER=//p' | head -n1)"
	case "$REMOTE_HOME" in
		/*) ;;
		*)  skip remote "${REMOTE_SSH_DEST} did not report an absolute HOME (got '${REMOTE_HOME}')"; return 1 ;;
	esac
	case "$docker_version" in
		[0-9]*) ;;
		*) skip remote "docker is not usable by ${REMOTE_SSH_DEST}: ${docker_version:-no response from 'docker version'}"; return 1 ;;
	esac

	remote_ssh "${REMOTE_SSH_DEST}" "docker image inspect '${GUEST_IMAGE}' >/dev/null 2>&1" || {
		skip remote "guest image ${GUEST_IMAGE} is not built on ${REMOTE_SSH_DEST}; run 'bash scripts/test-sandbox/run.sh --rung=remote --build'"
		return 1
	}
	return 0
}

remote_tree() { printf '%s/%s' "${REMOTE_HOME}" "${REMOTE_TREE_REL}"; }

# Ship the work tree. Incremental by construction: rsync transfers only changed
# blocks, so the second run costs a directory scan and a few kilobytes.
#
# .gitignore is honoured through rsync's own per-directory filter, and the five
# heavy directories are excluded outright as well. Belt and braces on purpose: the
# gitignore filter is rsync's reading of those patterns, not git's, and shipping
# 1.6GB of node_modules or a target/ tree over the LAN on every test run is the
# failure this rung would not survive.
#
# .sandbox-deps-stamp is excluded for a different reason: an excluded path is also
# protected from --delete, and without that the stamp the install step writes is
# deleted by the next sync and every run reinstalls the world.
#
# GENERATED SOURCES ARE PUT BACK. Honouring .gitignore is right for build output
# and wrong for the handful of generated files that live INSIDE a package's src
# tree and are imported at runtime: tool-views.generated.js and the three embedded
# mupdf blobs. A local rung binds the work tree, so it gets them for free; the
# remote rung dropped them and every coding-agent suite died on "Cannot find module
# './tool-views.generated.js'", which reads like a broken import rather than a
# missing file. The list is asked of git rather than written out here, so a new
# generated source is carried the day it is added and nothing else ever is.
#
# The grep is the safety rail, not tidiness. `git ls-files --others --ignored`
# reports a wholly ignored directory as one collapsed entry and ignores the
# pathspec when it does, so an unfiltered list offers to re-include
# packages/deepswe-bench/repo-cache, which is thousands of cloned repositories. Only
# a regular file directly under some packages/<one>/src/ is ever put back.
remote_generated_sources_filter() {
	local out
	out="$(cd "${REPO_ROOT}" && git ls-files --others --ignored --exclude-standard 2>/dev/null)" || return 0
	printf '%s\n' "$out" | grep -E '^packages/[^/]+/src/.*[^/]$' | sed 's|^|+ /|'
	return 0
}

remote_sync() {
	local tree filter
	tree="$(remote_tree)"
	remote_ssh "${REMOTE_SSH_DEST}" "mkdir -p '${tree}'" || return 1
	filter="$(mktemp "${TMPDIR:-/tmp}/veyyon-sandbox-filter.XXXXXX")"
	remote_generated_sources_filter > "${filter}"
	rsync -a --delete \
		--filter="merge ${filter}" \
		--filter=':- .gitignore' \
		--exclude='node_modules/' \
		--exclude='target/' \
		--exclude='.build/' \
		--exclude='binaries/' \
		--exclude='dist/' \
		--exclude='/.sandbox-deps-stamp' \
		--exclude='/scripts/test-sandbox/guest/.build/' \
		-e "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath=/dev/shm/veyyon-sandbox-ssh-%r@%h:%p -o ControlPersist=300 -i ${REMOTE_SSH_KEY}" \
		"${REPO_ROOT}/" "${REMOTE_SSH_DEST}:${tree}/"
	local status=$?
	rm -f "${filter}"
	return $status
}

# node_modules is never synced, so it is installed on the remote by a container
# that HAS network, exactly once per lockfile. The test container never gets a
# network, which is the whole reason these are two containers and not one.
remote_install_deps() {
	local tree stamp
	tree="$(remote_tree)"
	stamp="$(sha256sum "${REPO_ROOT}/bun.lock" 2>/dev/null | cut -d' ' -f1)"
	[ -n "$stamp" ] || stamp="$(sha256sum "${REPO_ROOT}/bun.lockb" 2>/dev/null | cut -d' ' -f1)"
	[ -n "$stamp" ] || { printf '[test-sandbox] error: no bun.lock in %s\n' "${REPO_ROOT}" >&2; return 1; }

	remote_ssh "${REMOTE_SSH_DEST}" "test -d '${tree}/node_modules' && test \"\$(cat '${tree}/.sandbox-deps-stamp' 2>/dev/null)\" = '${stamp}'" && return 0

	log "installing dependencies on ${REMOTE_SSH_DEST} (lockfile changed or first run); this container has network, the test container does not"
	remote_ssh "${REMOTE_SSH_DEST}" "
		set -e
		docker run --rm \
			--user '${REMOTE_IDS}' \
			--cap-drop=ALL --security-opt=no-new-privileges \
			--mount 'type=bind,src=${tree},dst=${REMOTE_GUEST_REPO}' \
			--tmpfs /home:rw,mode=0755 --tmpfs /tmp:rw,mode=1777 --tmpfs /sandbox:rw,mode=1777 \
			-w '${REMOTE_GUEST_REPO}' \
			-e HOME=/sandbox/home -e BUN_INSTALL_CACHE_DIR=/sandbox/home/.bun/install/cache \
			--entrypoint /bin/sh '${GUEST_IMAGE}' \
			-c 'mkdir -p \"\$BUN_INSTALL_CACHE_DIR\"; bun install --frozen-lockfile'
		printf '%s' '${stamp}' > '${tree}/.sandbox-deps-stamp'
	" >&2 || return 1
}

# The container start-up assertion. It runs before the caller's command and proves
# the two homes this rung claims to have removed are genuinely gone. It exits 126,
# the "sandbox could not be established" status, so a failure descends the ladder
# rather than being reported as a red suite.
#
# One line on purpose. It travels through `printf %q` into a remote shell, and a
# multi-line value comes out as bash's $'...\n...' form, which is not POSIX and
# breaks the moment the remote login shell is not bash.
GUEST_ENTRY='for h in "$VEYYON_TEST_HOST_HOME" "$VEYYON_SANDBOX_REMOTE_HOME"; do if [ -n "$h" ] && [ -e "$h" ]; then echo "[remote] FATAL: $h is readable inside the container; the sandbox is not established" >&2; exit 126; fi; done; mkdir -p "$HOME/.bun/install/cache" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"; exec "$@"'

run_remote() {
	# probe_remote populates these. A pinned run always probes first, and so does
	# the ladder, so an empty value here means the rung was called out of order.
	[ -n "${REMOTE_HOME}" ] && [ -n "${REMOTE_IDS}" ] || {
		printf '[test-sandbox] error: the remote rung was run without a successful probe\n' >&2
		return 126
	}

	local tree
	tree="$(remote_tree)"

	remote_sync >&2 || { printf '[test-sandbox] error: rsync to %s failed (output above)\n' "${REMOTE_SSH_DEST}" >&2; return 126; }
	remote_install_deps || { printf '[test-sandbox] error: dependency install on %s failed (output above)\n' "${REMOTE_SSH_DEST}" >&2; return 126; }

	local -a env_args=(
		-e "VEYYON_TEST_SANDBOX=remote-docker"
		-e "VEYYON_TEST_HOST_HOME=${HOST_HOME}"
		-e "VEYYON_SANDBOX_REMOTE_HOME=${REMOTE_HOME}"
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

	local repo_mount="type=bind,src=${tree},dst=${REMOTE_GUEST_REPO}"
	[ "${VEYYON_SANDBOX_REPO_RO:-0}" = "1" ] && repo_mount="${repo_mount},readonly"

	local -a ssh_tty=() docker_tty=()
	if [ -t 0 ] && [ -t 1 ]; then ssh_tty=(-t -t); docker_tty=(-it); fi

	# Assembled here and shipped as one shell command, so the remote side needs no
	# copy of this script and no agreement about where it lives.
	#
	# The container is named and force-removed afterwards. `docker run` under
	# `timeout` detaches on SIGTERM rather than stopping the container, so without
	# the explicit removal a wedged suite would survive its own deadline and go on
	# holding 24 cores.
	local cname remote_cmd
	cname="veyyon-sandbox-$$-$(date +%s)"
	remote_cmd="$(printf '%s ' \
		"timeout -k 10 ${VEYYON_SANDBOX_TIMEOUT:-1800}" \
		"docker run --rm --name ${cname}" \
		"${docker_tty[@]}" \
		"--network none" \
		"--user ${REMOTE_IDS}" \
		"--cap-drop=ALL" \
		"--security-opt=no-new-privileges" \
		"--pids-limit ${VEYYON_SANDBOX_REMOTE_PIDS:-8192}" \
		"--cpus ${VEYYON_SANDBOX_REMOTE_CPUS:-24}" \
		"--memory ${VEYYON_SANDBOX_REMOTE_MEMORY:-32g}" \
		"--mount $(printf '%q' "${repo_mount}")" \
		"--tmpfs /home:rw,mode=0755" \
		"--tmpfs /tmp:rw,mode=1777" \
		"--tmpfs /sandbox:rw,mode=1777" \
		"-w ${REMOTE_GUEST_REPO}")"
	for name in "${env_args[@]}"; do
		[ "$name" = "-e" ] && continue
		remote_cmd="${remote_cmd} -e $(printf '%q' "$name")"
	done
	remote_cmd="${remote_cmd} --entrypoint /bin/sh $(printf '%q' "${GUEST_IMAGE}") -c $(printf '%q' "${GUEST_ENTRY}") _"
	local arg
	for arg in "$@"; do
		remote_cmd="${remote_cmd} $(printf '%q' "$arg")"
	done
	remote_cmd="${remote_cmd}; __s=\$?; docker rm -f ${cname} >/dev/null 2>&1 || true; exit \$__s"

	# ssh exits with the remote command's status, so a red suite is red locally with
	# the same number, and stderr arrives on stderr. Nothing here inspects or
	# rewrites the status: a remote failure has to be indistinguishable from a local
	# one or nobody can trust the rung.
	remote_ssh "${ssh_tty[@]}" "${REMOTE_SSH_DEST}" "${remote_cmd}"
}

# Used by --probe to list which binaries the rung provides.
binprobe_remote() {
	remote_ssh "${REMOTE_SSH_DEST}" "docker run --rm --network none --entrypoint /bin/sh $(printf '%q' "${GUEST_IMAGE}") -c $(printf '%q' "$1")"
}

# --- the guest build, on the remote -----------------------------------------
# Reached as `bash scripts/test-sandbox/run.sh --rung=remote --build`. The image
# has to exist on the remote docker daemon, so it is built there from the same
# guest/Dockerfile after the tree is synced. Only the userland is built: the
# microVM kernel and initramfs are for the local microvm rung and mean nothing on
# the far side of an ssh connection.
remote_build() {
	command -v rsync >/dev/null 2>&1 || die "rsync is required to ship the guest sources to ${REMOTE_SSH_DEST}"
	probe_remote >/dev/null 2>&1 || true
	[ -n "${REMOTE_HOME}" ] || {
		local out
		out="$(remote_ssh "${REMOTE_SSH_DEST}" 'printf "%s\n%s:%s\n" "$HOME" "$(id -u)" "$(id -g)"' 2>&1)" \
			|| die "cannot reach ${REMOTE_SSH_DEST} over ssh: $(printf '%s' "$out" | tr '\n' ' ')"
		REMOTE_HOME="$(printf '%s\n' "$out" | sed -n 1p)"
		REMOTE_IDS="$(printf '%s\n' "$out" | sed -n 2p)"
	}
	local tree
	tree="$(remote_tree)"
	log "syncing the work tree to ${REMOTE_SSH_DEST}:${tree}"
	remote_sync >&2 || die "rsync to ${REMOTE_SSH_DEST} failed"
	log "building the guest userland on ${REMOTE_SSH_DEST}"
	remote_ssh "${REMOTE_SSH_DEST}" \
		"cd '${tree}' && VEYYON_SANDBOX_USERLAND_ONLY=1 bash scripts/test-sandbox/guest/build-guest.sh" >&2 \
		|| die "the guest build failed on ${REMOTE_SSH_DEST} (output above)"
	log "the remote rung is ready on ${REMOTE_SSH_DEST}"
}

# Sourced by run.sh, and executed directly only for --build.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	printf 'This file is a rung of scripts/test-sandbox/run.sh and is not run on its own.\n' >&2
	printf 'Build the remote guest with: bash scripts/test-sandbox/run.sh --rung=remote --build\n' >&2
	exit 2
fi
