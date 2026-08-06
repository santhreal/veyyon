#!/usr/bin/env bash
# The microvm rung: a QEMU microVM with its own kernel.
#
# Usage: sourced by scripts/test-sandbox/run.sh; not run directly. It defines
# probe_microvm, run_microvm and binprobe_microvm and reads REPO_ROOT, GUEST_REPO
# and BUILD_DIR from the driver. The boot itself lives in guest/run-microvm.sh.
#
# This is the strongest rung and not the default. The LADDER note in run.sh
# records the measurement that decided that: virtiofsd serialises every lookup on
# one request queue, small-file reads run about 10x slower, and suites that pass
# under docker blow their per-test timeout here.

probe_microvm() {
	command -v qemu-system-x86_64 >/dev/null 2>&1 || { skip microvm "qemu-system-x86_64 not on PATH"; return 1; }
	qemu-system-x86_64 -machine help 2>/dev/null | grep -q '^microvm' || { skip microvm "this qemu has no 'microvm' machine type"; return 1; }
	[ -r /dev/kvm ] && [ -w /dev/kvm ] || { skip microvm "/dev/kvm is not readable+writable by uid $(id -u); a microVM without KVM is too slow to use"; return 1; }
	[ -x "${VIRTIOFSD:-/usr/libexec/virtiofsd}" ] || { skip microvm "virtiofsd not found at ${VIRTIOFSD:-/usr/libexec/virtiofsd}; the repo cannot be shared into the guest"; return 1; }
	[ -f "${BUILD_DIR}/vmlinuz" ] && [ -f "${BUILD_DIR}/rootfs.img" ] || {
		skip microvm "guest image not built; run 'bash scripts/test-sandbox/run.sh --build' (about 35s, cached afterwards)"
		return 1
	}
	# The artifacts existing is not evidence that they boot. --build writes this file
	# only after the guest has actually come up, mounted the repo and run a command,
	# so a guest that is built but broken reports unavailable here instead of eating
	# a developer's invocation and then descending the ladder anyway.
	[ -f "${BUILD_DIR}/boot-verified" ] || {
		skip microvm "the built guest has not passed a boot check; run 'bash scripts/test-sandbox/run.sh --build' to build and verify it"
		return 1
	}
	return 0
}

run_microvm() {
	VEYYON_SANDBOX_REPO_ROOT="${REPO_ROOT}" VEYYON_SANDBOX_GUEST_REPO="${GUEST_REPO}" \
		bash "${GUEST_DIR}/run-microvm.sh" "$@"
}

# Used by --probe to list which binaries the rung provides.
binprobe_microvm() { bash "${GUEST_DIR}/run-microvm.sh" sh -c "$1"; }
