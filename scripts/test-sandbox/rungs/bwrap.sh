#!/usr/bin/env bash
# The bwrap rung: bubblewrap with a mount and user namespace.
#
# Usage: sourced by scripts/test-sandbox/run.sh; not run directly. It defines
# probe_bwrap, run_bwrap and binprobe_bwrap and reads REPO_ROOT and HOST_HOME from
# the driver.
#
# It is last on the ladder and it does not work on this workstation. The reason is
# in the LADDER note in run.sh: AppArmor refuses the uid_map write even though the
# sysctls advertise unprivileged user namespaces, so the probe has to RUN bwrap
# rather than look for it on PATH.

probe_bwrap() {
	command -v bwrap >/dev/null 2>&1 || { skip bwrap "bubblewrap not on PATH"; return 1; }
	# Run it. The sysctls claim unprivileged userns is enabled on hosts where
	# AppArmor then refuses the uid_map write, so only an execution is evidence.
	local err
	if ! err="$(bwrap --unshare-user --ro-bind / / --tmpfs /home /bin/true 2>&1)"; then
		skip bwrap "bubblewrap cannot create a user namespace here: ${err%%$'\n'*}"
		return 1
	fi
	return 0
}

run_bwrap() {
	bwrap \
		--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
		--die-with-parent --new-session \
		--ro-bind /usr /usr --ro-bind /etc /etc \
		--symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --symlink usr/sbin /sbin \
		--proc /proc --dev /dev \
		--tmpfs /home --tmpfs /tmp --tmpfs /sandbox --tmpfs /run \
		--bind "${REPO_ROOT}" "${REPO_ROOT}" \
		--chdir "${REPO_ROOT}" \
		--setenv VEYYON_TEST_SANDBOX bwrap-userns \
		--setenv VEYYON_TEST_HOST_HOME "${HOST_HOME}" \
		--setenv HOME /sandbox/home \
		--setenv TMPDIR /tmp \
		--setenv BUN_INSTALL_CACHE_DIR /sandbox/home/.bun/install/cache \
		/bin/sh -c 'mkdir -p "$HOME"; exec "$@"' _ "$@"
}

# Used by --probe to list which binaries the rung provides.
binprobe_bwrap() { bwrap --unshare-user --ro-bind / / --tmpfs /home /bin/sh -c "$1"; }
