#!/usr/bin/env bash
# Build the guest the sandbox rungs share, into scripts/test-sandbox/guest/.build/.
#
#   bash scripts/test-sandbox/run.sh --build   # the supported way to run this
#
# Two products, one script. The docker and remote rungs need only the userland
# image; the microvm rung additionally needs a kernel and an initramfs. Set
# VEYYON_SANDBOX_USERLAND_ONLY=1 to build the image and stop there, which is what
# the remote rung does over ssh: a microVM kernel on the far side of an ssh
# connection is 390MB of artifact nothing there will ever boot.
#
# WHAT IT PRODUCES
# ----------------
#   .build/vmlinuz      Alpine's linux-virt kernel, extracted from the alpine apk
#                       inside a throwaway container. Small, already configured for
#                       virtio guests, and no host kernel is readable anyway:
#                       /boot/vmlinuz-* on this workstation is mode 0600 root-only.
#   .build/rootfs.img   An uncompressed cpio initramfs of the veyyon-test-guest
#                       image, with Alpine's matching kernel modules grafted in.
#   .build/stamp        The cache key. Rebuild happens only when it changes.
#
# WHY AN INITRAMFS AND NOT AN EXT4 DISK
# -------------------------------------
# An initramfs needs no block driver to be resolved before root is mounted, no
# qemu-img, no loop device and no partition table, and it cannot be written back to
# the host because it only ever exists as guest RAM. A disk image would need the
# kernel to find virtio_blk before it can load the module that provides virtio_blk,
# which on a modular Alpine kernel means shipping a second, smaller initramfs to
# break the cycle. The whole point here is a boundary that is easy to audit, and one
# RAM-resident archive is easier to audit than a boot chain.
#
# WHY THE CPIO IS BUILT INSIDE A CONTAINER
# ----------------------------------------
# The archive has to record root ownership and a /dev/console device node. A
# non-root process on the host can create neither. Rather than ask for sudo, the
# archive is created by a container running as root over its own filesystem and
# written out through a bind mount, then chowned back to the invoking user.
#
# THE CACHE KEY
# -------------
# bun version + the sha256 of Dockerfile and guest-init.sh. Deliberately NOT the
# lockfile: dependencies are never installed inside the guest. node_modules arrives
# over virtiofs from the host tree, already resolved, so a lockfile change cannot
# change a single byte of this image and keying on it would force pointless
# multi-minute rebuilds.
#
# NETWORK
# -------
# This script needs network the first time, to pull alpine and apt-get git into the
# bun base image. After that the layers are in the docker cache and the stamp short
# -circuits the whole thing. The microVM itself has no NIC and never needs network.
set -euo pipefail

GUEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="$(cd -- "${GUEST_DIR}/../../.." && /bin/pwd -P)"
BUILD_DIR="${GUEST_DIR}/.build"

BUN_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([^"]*\)".*/\1/p' "${REPO_ROOT}/package.json" | head -n1)"
: "${BUN_VERSION:=1.3.14}"
GUEST_IMAGE="veyyon-test-guest:${BUN_VERSION}"
KERNEL_IMAGE="veyyon-test-kernel:alpine3.21"

log() { printf '[build-guest] %s\n' "$*" >&2; }
die() { printf '[build-guest] error: %s\n' "$*" >&2; exit 2; }

command -v docker >/dev/null 2>&1 || die "docker is required to build the guest rootfs, and it is the only tool on this host that can (debootstrap, mkosi and podman are absent)"
HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
: "${HOST_HOME:=${HOME}}"
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || die "the docker daemon is not reachable by uid $(id -u)"

STAMP="bun=${BUN_VERSION} dockerfile=$(sha256sum "${GUEST_DIR}/Dockerfile" | cut -d' ' -f1) init=$(sha256sum "${GUEST_DIR}/guest-init.sh" | cut -d' ' -f1)"
# Up to date means: the stamp matches, the userland image the docker rung runs still
# exists, and IF this host can boot the microVM AND was asked for it, its artifacts
# exist and have passed a boot check. A host with no KVM never had those artifacts
# and must not be told it is stale forever because of it, and neither must a
# userland-only build on a host that happens to have KVM, which is the remote case.
microvm_artifacts_ok() {
	[ "${VEYYON_SANDBOX_USERLAND_ONLY:-0}" = "1" ] && return 0
	{ [ -r /dev/kvm ] && [ -w /dev/kvm ] && command -v qemu-system-x86_64 >/dev/null 2>&1; } || return 0
	[ -f "${BUILD_DIR}/vmlinuz" ] && [ -f "${BUILD_DIR}/rootfs.img" ] && [ -f "${BUILD_DIR}/boot-verified" ]
}
if [ -f "${BUILD_DIR}/stamp" ] && [ "$(cat "${BUILD_DIR}/stamp")" = "$STAMP" ] \
	&& docker image inspect "${GUEST_IMAGE}" >/dev/null 2>&1 \
	&& microvm_artifacts_ok; then
	log "up to date (${BUILD_DIR})"
	exit 0
fi

mkdir -p "${BUILD_DIR}"

# --- can this host run the microVM at all? ---------------------------------
# A GitHub-hosted ubuntu runner has docker but no /dev/kvm, and no nested
# virtualisation to enable one. Building a kernel and a 390MB initramfs there
# would burn minutes producing artifacts that can never boot, and then the boot
# check at the end would fail and take CI down with it.
#
# So on a host without KVM this builds the guest USERLAND only. That is the image
# the docker rung runs, so CI gets its sandbox; the microvm rung simply reports
# itself unavailable, out loud, through the same probe as everywhere else. This is
# a narrower build, announced, not a weaker boundary applied silently.
CAN_BOOT_MICROVM=1
if [ "${VEYYON_SANDBOX_USERLAND_ONLY:-0}" = "1" ]; then
	CAN_BOOT_MICROVM=0
	log "VEYYON_SANDBOX_USERLAND_ONLY=1: building the guest userland only, for the docker and remote rungs"
elif ! { [ -r /dev/kvm ] && [ -w /dev/kvm ]; }; then
	CAN_BOOT_MICROVM=0
	log "no usable /dev/kvm on this host: building the guest userland for the docker rung only, and skipping the kernel, the initramfs and the boot check"
elif ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
	CAN_BOOT_MICROVM=0
	log "qemu-system-x86_64 is not installed: building the guest userland for the docker rung only, and skipping the kernel, the initramfs and the boot check"
fi

if [ "$CAN_BOOT_MICROVM" = 0 ]; then
	log "building guest userland (${GUEST_IMAGE})"
	docker build --build-arg "BUN_VERSION=${BUN_VERSION}" -t "${GUEST_IMAGE}" "${GUEST_DIR}" >&2
	rm -f "${BUILD_DIR}/boot-verified" "${BUILD_DIR}/vmlinuz" "${BUILD_DIR}/rootfs.img"
	printf '%s' "$STAMP" > "${BUILD_DIR}/stamp"
	log "done. The docker rung is ready; the microvm rung will report itself unavailable."
	exit 0
fi

# --- 1. kernel + matching modules ------------------------------------------
# Kernel image and modules come out of the same apk so they cannot drift apart.
# Modules are userland-agnostic, so an Alpine kernel under a Debian userland is
# fine and is the smallest thing that boots a virtio guest.
log "building kernel image (${KERNEL_IMAGE})"
printf '%s\n' \
	'FROM alpine:3.21' \
	'RUN apk add --no-cache linux-virt' \
	| docker build -t "${KERNEL_IMAGE}" -f - "${GUEST_DIR}" >&2

log "extracting kernel and modules"
kc="$(docker create "${KERNEL_IMAGE}" /bin/true)"
trap 'docker rm -f "$kc" >/dev/null 2>&1 || :' EXIT
docker cp "${kc}:/boot/vmlinuz-virt" "${BUILD_DIR}/vmlinuz"
rm -rf "${BUILD_DIR}/modules"
mkdir -p "${BUILD_DIR}/modules"
docker cp "${kc}:/lib/modules/." "${BUILD_DIR}/modules/"
docker rm -f "$kc" >/dev/null
trap - EXIT

# --- 2. guest userland ------------------------------------------------------
log "building guest userland (${GUEST_IMAGE})"
docker build --build-arg "BUN_VERSION=${BUN_VERSION}" -t "${GUEST_IMAGE}" "${GUEST_DIR}" >&2

# --- 3. initramfs -----------------------------------------------------------
# Built by a root process inside the guest image itself, over its own filesystem,
# so ownership survives into the archive and the /dev/console node can be created.
#
# Two subtleties, both of which cost a boot to discover:
#
#   -xdev stops find at every mount point, which is what keeps docker's /proc,
#   /sys and /dev out of the archive. It still emits the mount point DIRECTORIES
#   themselves, which is exactly right: the guest needs empty /proc and /sys to
#   mount onto. Pruning them instead removes the directories and the guest dies
#   with "mount: /proc: mount point does not exist".
#
#   /dev is a tmpfs inside `docker run`, so the /dev/console built into the image
#   layer is shadowed and -xdev skips it. But the kernel opens /dev/console to
#   give PID 1 its stdio, before /init can mount devtmpfs. So the nodes are staged
#   separately and appended as a second cpio archive. The kernel's initramfs
#   unpacker reads concatenated archives (that is how early microcode is loaded),
#   so two archives in one file is a supported shape, not a trick.
log "packing initramfs"
docker run --rm \
	--mount "type=bind,src=${BUILD_DIR},dst=/out" \
	-e "HOST_UID=$(id -u)" -e "HOST_GID=$(id -g)" \
	--entrypoint /bin/sh \
	"${GUEST_IMAGE}" -c '
		set -eu

		# Alpine ships modules gzip-compressed, and Debian builds kmod WITHOUT zlib
		# ("kmod version 34.2 +ZSTD +XZ -ZLIB"), so this depmod/modprobe cannot read a
		# single .ko.gz. Left alone it produces an EMPTY modules.dep and every modprobe
		# in the guest silently no-ops, which surfaces two seconds into boot as
		# "unknown filesystem type virtiofs" and nothing pointing at the cause.
		# Decompressing to plain .ko sidesteps the mismatch entirely.
		#
		# Only the subtrees the guest actually needs are carried: virtiofs and its fuse
		# dependency to see the repo, overlayfs to make it writable, and the virtio bus
		# drivers. Taking all 915 modules would add roughly 100MB of uncompressed RAM
		# image to every boot for drivers a VM with three virtio devices will never load.
		rm -rf /lib/modules
		v="$(ls /out/modules | head -n1)"
		mkdir -p "/lib/modules/$v"
		for d in kernel/fs/fuse kernel/fs/overlayfs kernel/drivers/virtio; do
			[ -d "/out/modules/$v/$d" ] || continue
			mkdir -p "/lib/modules/$v/$(dirname "$d")"
			cp -a "/out/modules/$v/$d" "/lib/modules/$v/$d"
		done
		cp -a "/out/modules/$v/modules.builtin" "/lib/modules/$v/" 2>/dev/null || true
		cp -a "/out/modules/$v/modules.order" "/lib/modules/$v/" 2>/dev/null || true
		find "/lib/modules/$v" -name "*.ko.gz" -exec gunzip {} +
		depmod -a "$v"
		grep -q virtiofs "/lib/modules/$v/modules.dep" \
			|| { echo "depmod produced no entry for virtiofs; the guest would not be able to see the repo" >&2; exit 1; }

		# Mount points the guest init needs to exist and be empty.
		mkdir -p /mnt/repo-lower /mnt/ovl /run /tmp

		# Staged device nodes, appended below.
		rm -rf /stage
		mkdir -p /stage/dev
		mknod -m 0600 /stage/dev/console c 5 1
		mknod -m 0666 /stage/dev/null c 1 3

		{
			cd /
			find . -xdev \
				-path ./out -prune -o \
				-path ./stage -prune -o \
				-path ./.dockerenv -prune -o \
				-path ./etc/hosts -prune -o \
				-path ./etc/hostname -prune -o \
				-path ./etc/resolv.conf -prune -o \
				-print \
			| cpio --quiet -o -H newc
			cd /stage
			find . -mindepth 1 -print | cpio --quiet -o -H newc
		} > /out/rootfs.img.tmp

		mv /out/rootfs.img.tmp /out/rootfs.img
		chown "$HOST_UID:$HOST_GID" /out/rootfs.img
	' >&2

rm -rf "${BUILD_DIR}/modules"
rm -f "${BUILD_DIR}/boot-verified"

log "kernel    $(stat -c%s "${BUILD_DIR}/vmlinuz") bytes"
log "initramfs $(stat -c%s "${BUILD_DIR}/rootfs.img") bytes"

# --- 4. boot check ----------------------------------------------------------
# Artifacts existing is not evidence that they boot. Everything that has gone
# wrong here so far (a missing /proc mount point, modules Debian's kmod could not
# read, a guest with no way to power itself off) produced files that looked
# perfectly fine on disk and a guest that died two seconds in. So the guest has to
# demonstrate the whole path once: come up, mount the repo, run a command as the
# synthetic user, and report a status. Only then does the rung advertise itself as
# available, which is what keeps a broken build from eating every caller's
# invocation before descending the ladder anyway.
log "boot check"
probe="$(VEYYON_SANDBOX_TIMEOUT=120 bash "${GUEST_DIR}/run-microvm.sh" \
	sh -c 'test -f package.json && test ! -e "$VEYYON_TEST_HOST_HOME" && echo BOOT_CHECK_OK' 2>&1 || true)"
if ! printf '%s' "$probe" | grep -q BOOT_CHECK_OK; then
	printf '%s\n' "$probe" | tail -n 15 >&2
	die "the guest built but did not pass its boot check (output above). The microvm rung will report itself unavailable until this passes."
fi
printf '%s' "$STAMP" > "${BUILD_DIR}/stamp"
: > "${BUILD_DIR}/boot-verified"

log "boot check passed: the guest mounts the repo and cannot see ${HOST_HOME:-the host home}"
log "done. Artifacts in ${BUILD_DIR} (gitignored). Remove with: bash scripts/test-sandbox/run.sh --clean"
