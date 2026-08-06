#!/usr/bin/env bash
# Run one command inside the QEMU microVM. Invoked by scripts/test-sandbox.sh; not
# meant to be called directly, because it assumes the probes there already passed.
#
# THE BOUNDARY
# ------------
# This is a virtual machine, so the isolation is not a policy applied to a process,
# it is the absence of a mapping. The guest runs its own kernel with a mount table
# built from an empty initramfs. /home/<operator> is not unmounted in the guest; it
# was never representable there. The only host path that enters is the repo, and it
# enters read-only through a single virtiofs export whose shared directory is the
# repo root, so even a guest process running as root cannot walk out of it: the
# daemon resolves every path relative to that root.
#
# WHY -machine microvm
# --------------------
# No BIOS, no PCI bus, no ACPI tables, no legacy timers. The kernel is loaded
# directly into guest memory and the only devices are virtio-mmio ones we ask for.
# It is the same shape Firecracker gives, which is what the operator asked for;
# Firecracker and cloud-hypervisor are not installed on this host and QEMU is, so
# this is the microVM that can actually run here.
#
# HOW THE COMMAND GETS IN AND THE STATUS GETS OUT
# -----------------------------------------------
# In: base64 on the kernel command line. Base64 has no spaces, quotes or shell
# metacharacters, so an arbitrary test path cannot corrupt the boot arguments.
# Out: the guest prints a sentinel line on the serial console and powers off. There
# is no shared writable channel between guest and host at all, which is the point:
# a writable channel is a hole, and an exit status does not need one.
#
# FAIL CLOSED
# -----------
# If the sentinel never appears, the guest crashed, hung or was killed. That is
# reported as a failure with a distinct status, never as success. A sandbox that
# reports green when it did not run the suite is worse than no sandbox.
set -euo pipefail

VM_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="${VEYYON_SANDBOX_REPO_ROOT:-$(cd -- "${VM_DIR}/../.." && /bin/pwd -P)}"
# Where the repo appears inside the guest. Normally the host path verbatim; the
# caller overrides it when the checkout lives under the home being hidden, because
# recreating that path in the guest would put the home back in reach.
GUEST_REPO="${VEYYON_SANDBOX_GUEST_REPO:-${REPO_ROOT}}"
BUILD_DIR="${VM_DIR}/.build"
VIRTIOFSD="${VIRTIOFSD:-/usr/libexec/virtiofsd}"

SENTINEL_PREFIX='__VEYYON_SANDBOX_EXIT__'
GUEST_MEM="${VEYYON_SANDBOX_MEM:-4096}"
GUEST_CPUS="${VEYYON_SANDBOX_CPUS:-$(nproc)}"
[ "$GUEST_CPUS" -gt 16 ] && GUEST_CPUS=16

log() { printf '[microvm] %s\n' "$*" >&2; }

# 126 means "the sandbox could not be established and NO guest command ran".
# scripts/test-sandbox.sh treats that, and only that, as licence to announce this
# rung as broken and descend the ladder. Every other status is the suite's own and
# is passed straight through, so a failing suite can never be retried somewhere
# weaker and turned green.
setup_failed() { printf '[microvm] error: %s\n' "$*" >&2; exit 126; }
die()          { printf '[microvm] error: %s\n' "$*" >&2; exit "${2:-2}"; }

[ $# -gt 0 ] || die "no command given"

# The guest recreates this path and mounts the repo there. A relative path would
# make it recreate something meaningless, so refuse rather than boot a guest whose
# repo is not where the suite expects. 126 lets the caller descend the ladder.
case "$REPO_ROOT" in
	/*) ;;
	*)  setup_failed "the repo root resolved to '${REPO_ROOT}', which is not absolute. This shell's getcwd() cannot name its own working directory. Set VEYYON_SANDBOX_REPO_ROOT to the checkout path." ;;
esac

HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
: "${HOST_HOME:=${HOME}}"

# Scratch lives on /dev/shm, a tmpfs, so the vhost socket and QEMU's own scratch
# never touch a real disk and never touch the operator's home.
RUNDIR="$(mktemp -d /dev/shm/veyyon-microvm.XXXXXXXX)"
VIRTIOFSD_PID=""
QEMU_PID=""
cleanup() {
	[ -n "$QEMU_PID" ] && kill "$QEMU_PID" 2>/dev/null || :
	[ -n "$VIRTIOFSD_PID" ] && kill "$VIRTIOFSD_PID" 2>/dev/null || :
	[ -n "$RUNDIR" ] && rm -rf "$RUNDIR"
}
trap cleanup EXIT INT TERM

# --- share the repo ---------------------------------------------------------
# --sandbox none because virtiofsd's default namespace sandbox needs a user
# namespace, and this host refuses the uid_map write (AppArmor's
# apparmor_restrict_unprivileged_userns). The daemon therefore runs with exactly
# this user's authority and no more, confined to --shared-dir. It is not the
# security boundary; the VM is. The daemon only decides which single host subtree
# is representable inside it, and that subtree is the repo.
"$VIRTIOFSD" \
	--socket-path="${RUNDIR}/vfs.sock" \
	--shared-dir="${REPO_ROOT}" \
	--sandbox none \
	--cache always \
	--thread-pool-size 8 \
	--rlimit-nofile 1048576 \
	--announce-submounts \
	>"${RUNDIR}/virtiofsd.log" 2>&1 &
VIRTIOFSD_PID=$!

for _ in $(seq 1 100); do
	[ -S "${RUNDIR}/vfs.sock" ] && break
	kill -0 "$VIRTIOFSD_PID" 2>/dev/null || setup_failed "virtiofsd exited during startup: $(tail -n3 "${RUNDIR}/virtiofsd.log")"
	sleep 0.05
done
[ -S "${RUNDIR}/vfs.sock" ] || setup_failed "virtiofsd never created its socket: $(tail -n3 "${RUNDIR}/virtiofsd.log")"

# --- assemble the request ---------------------------------------------------
b64() { printf '%s' "$1" | base64 -w0; }

# The command is re-quoted so the guest's `sh -c` sees the same argv the caller
# typed, then base64'd so the kernel command line parser sees one opaque token.
quoted=""
for arg in "$@"; do
	quoted="${quoted}$(printf '%q' "$arg") "
done

CMDLINE="console=ttyS0 reboot=t panic=-1 loglevel=3 quiet"
CMDLINE="${CMDLINE} veyyon.cmd=$(b64 "$quoted")"
CMDLINE="${CMDLINE} veyyon.cwd=$(b64 "$PWD")"
CMDLINE="${CMDLINE} veyyon.repo=$(b64 "$GUEST_REPO")"
CMDLINE="${CMDLINE} veyyon.hosthome=$(b64 "$HOST_HOME")"

# x86 caps the kernel command line at 2048 bytes and silently truncates past it,
# which would show up as an unbootable guest rather than an obvious error.
[ "${#CMDLINE}" -lt 2000 ] || die "the command is too long to pass on the kernel command line (${#CMDLINE} of 2000 bytes). Run fewer test paths per invocation."

# --- boot -------------------------------------------------------------------
# memory-backend-memfd with share=on is what lets virtiofsd map guest memory; a
# vhost-user device cannot work without it.
#
# The whole VM is wrapped in a hard timeout. A guest that wedges must not hold a
# developer's terminal or a CI job forever, and a wedged guest is a sandbox
# failure, not a test failure, so it descends the ladder rather than reporting red.
TIMEOUT="${VEYYON_SANDBOX_TIMEOUT:-1800}"
set +e
timeout --foreground -k 10 "$TIMEOUT" qemu-system-x86_64 \
	-M microvm,acpi=off,pit=off,pic=off,rtc=off,x-option-roms=off \
	-enable-kvm -cpu host -smp "${GUEST_CPUS}" -m "${GUEST_MEM}" \
	-nodefaults -no-user-config -no-reboot -display none \
	-object "memory-backend-memfd,id=mem,size=${GUEST_MEM}M,share=on" -numa node,memdev=mem \
	-chardev "socket,id=vfs,path=${RUNDIR}/vfs.sock" \
	-device vhost-user-fs-device,queue-size=1024,chardev=vfs,tag=repo \
	-kernel "${BUILD_DIR}/vmlinuz" \
	-initrd "${BUILD_DIR}/rootfs.img" \
	-append "${CMDLINE}" \
	-serial stdio \
	2> >(grep -v '^qemu-system-x86_64: warning' >&2) \
	| {
		# Stream the guest console through, minus two things it adds that are not the
		# suite's output: the serial console terminates every line with CR LF, and a
		# caller parsing this stream would otherwise see "+bun\r" and match nothing;
		# and the sentinel itself, which is a protocol detail.
		status_file="${RUNDIR}/status"
		while IFS= read -r line || [ -n "$line" ]; do
			line="${line%$'\r'}"
			case "$line" in
				"${SENTINEL_PREFIX}:"*)
					printf '%s' "${line#"${SENTINEL_PREFIX}":}" > "$status_file"
					# Everything after the sentinel is the guest tearing itself down
					# (sysrq power-off, reset). It is not the suite's output and
					# printing it makes a clean run look like it ended in an error.
					done_marker=1
					;;
				*)
					if [ -z "${done_marker:-}" ]; then printf '%s\n' "$line"; fi
					;;
			esac
		done
	}
set -e

if [ ! -f "${RUNDIR}/status" ]; then
	setup_failed "the guest never reported an exit status within ${TIMEOUT}s: it crashed, hung, or was killed before the suite finished. Treating this as a broken sandbox, not as a passing or failing suite.
  virtiofsd log tail: $(tail -n3 "${RUNDIR}/virtiofsd.log" 2>/dev/null || echo '(none)')"
fi

exit "$(cat "${RUNDIR}/status")"
