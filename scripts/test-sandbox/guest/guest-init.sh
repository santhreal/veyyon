#!/bin/sh
# PID 1 inside the test microVM. Runs before anything else exists: no /proc, no
# writable filesystem beyond the initramfs, no users logged in, no network.
#
# Its job, in order: build a filesystem view that contains the repo and nothing
# else of the host's, drop to the synthetic account, run the command it was given
# on the kernel command line, and report the exit status back over the serial
# console where the host script can read it.
#
# There is deliberately no shell, no getty and no login here. The VM exists to run
# one command and power off.
set -eu

SENTINEL_PREFIX='__VEYYON_SANDBOX_EXIT__'

# How the VM stops, which on a machine booted with acpi=off is not obvious.
#
# There is no power button, so `poweroff` has nothing to talk to; it returns and
# PID 1 falls through. Debian slim has no `reboot` binary at all, so that returns
# too. Both were tried and both left the VM sitting there until the host timeout
# killed it, which reads to the caller as a wedged sandbox rather than a finished
# run.
#
# What always works is the kernel itself: when PID 1 exits, the kernel panics with
# "Attempted to kill init", panic=-1 makes that reboot immediately, reboot=t turns
# the reboot into a triple fault, and QEMU's -no-reboot turns the triple fault into
# process exit. That path needs no userland tooling and no ACPI. sysrq is tried
# first because it is the tidier of the two and costs nothing when unavailable.
HALTING=0
halt_vm() {
	[ "$HALTING" = 1 ] && return
	HALTING=1
	trap - EXIT
	sync
	echo 1 > /proc/sys/kernel/sysrq 2>/dev/null || :
	echo o > /proc/sysrq-trigger 2>/dev/null || :
	echo b > /proc/sysrq-trigger 2>/dev/null || :
	exit 0
}

# A failure anywhere in setup must not leave a VM that hangs forever holding the
# developer's terminal, and must not be mistaken for a passing suite. 126 is the
# agreed "the sandbox could not be established and NO guest command ran" status;
# scripts/test-sandbox/run.sh reads it as licence to announce this rung as broken and
# try the next one down the ladder. Any other status is the suite's own.
fail() {
	printf '\n[guest-init] FATAL: %s\n' "$*" >&2
	printf '%s:%s\n' "$SENTINEL_PREFIX" 126
	halt_vm
}
trap 'fail "guest-init exited unexpectedly"' EXIT

mount -t proc     proc     /proc
mount -t sysfs    sysfs    /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || :
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts 2>/dev/null || :
mount -t tmpfs   tmpfs  /dev/shm
mount -t tmpfs   tmpfs  /run
mount -t tmpfs   tmpfs  /tmp -o mode=1777

# Kernel command line carries the request. Everything is base64 so no quoting,
# spaces or shell metacharacters in a test path can break the boot arguments.
b64get() {
	sed -n "s/.*veyyon\\.$1=\\([^ ]*\\).*/\\1/p" /proc/cmdline | head -n1
}
GUEST_CMD_B64="$(b64get cmd)"
GUEST_CWD_B64="$(b64get cwd)"
REPO_B64="$(b64get repo)"
HOST_HOME_B64="$(b64get hosthome)"

[ -n "$GUEST_CMD_B64" ] || fail "no veyyon.cmd= on the kernel command line"
[ -n "$REPO_B64" ] || fail "no veyyon.repo= on the kernel command line"

GUEST_CMD="$(printf '%s' "$GUEST_CMD_B64" | base64 -d)"
GUEST_CWD="$(printf '%s' "$GUEST_CWD_B64" | base64 -d 2>/dev/null || :)"
REPO="$(printf '%s' "$REPO_B64" | base64 -d)"
HOST_HOME="$(printf '%s' "$HOST_HOME_B64" | base64 -d 2>/dev/null || :)"

# virtiofs needs its module on the Alpine linux-virt kernel; overlay and fuse too.
# Failures are tolerated here because a kernel with them built in has no module to
# load, and the mount below is the real test of whether they are present.
for m in fuse virtiofs overlay; do modprobe "$m" 2>/dev/null || :; done

# --- the filesystem view ---------------------------------------------------
#
# /home is a fresh tmpfs holding exactly one directory. Nothing is bind-mounted
# from the host into it, and the host's /home was never in this kernel's mount
# table to begin with: this is a different kernel with a mount table built from
# an empty initramfs. There is no path from here to the operator's home, so
# there is nothing to forget to unmount.
mount -t tmpfs tmpfs /home -o mode=0755
mkdir -p /home/veyyon
chown 1000:1000 /home/veyyon

# The repo enters read-only over virtiofs and is made writable by an overlay whose
# upper and work layers are guest tmpfs. Tests can write anywhere in the tree; the
# writes live in guest RAM and evaporate at poweroff. The host tree is never
# written, so a suite that scribbles build output cannot dirty the working copy.
mkdir -p /mnt/repo-lower /mnt/ovl
mount -t virtiofs repo /mnt/repo-lower -o ro \
	|| fail "could not mount the repo over virtiofs (tag 'repo')"
mount -t tmpfs tmpfs /mnt/ovl
mkdir -p /mnt/ovl/upper /mnt/ovl/work

# The overlay is mounted at the repo's REAL absolute path so that any absolute
# path baked into the tree (tsconfig references, lockfile metadata, a cached
# build manifest) resolves to the same string inside and out. That path is under
# a data mount, not under a home, so replicating it reaches nothing.
mkdir -p "$REPO"
mount -t overlay overlay "$REPO" \
	-o "lowerdir=/mnt/repo-lower,upperdir=/mnt/ovl/upper,workdir=/mnt/ovl/work" \
	|| fail "could not stack an overlay on the virtiofs repo mount"


# --- the environment -------------------------------------------------------
#
# node_modules and the bun cache: node_modules comes in through the read-only
# lower layer already installed by the host, so the guest never resolves or
# downloads a dependency, and anything written into it lands in the tmpfs upper.
# The bun install cache is pointed at the guest home tmpfs rather than inherited,
# so a `bun install` inside the guest cannot reach or grow the host's cache.
export HOME=/home/veyyon
export TMPDIR=/tmp
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export BUN_INSTALL_CACHE_DIR="$HOME/.bun/install/cache"
# The image PATH, verbatim. Hardcoding a conventional list here silently dropped
# /usr/local/bun-node-fallback-bin, which is where the bun image keeps its `node`
# shim, so the microVM was missing a binary the docker rung had.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin
export VEYYON_TEST_SANDBOX=qemu-microvm
export VEYYON_TEST_HOST_HOME="$HOST_HOME"
export CI="${CI:-}"

install -d -o 1000 -g 1000 \
	"$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" \
	"$HOME/.bun" "$HOME/.bun/install" "$BUN_INSTALL_CACHE_DIR"

# The caller's working directory, but only when it is absolute and inside the repo.
# A shell whose getcwd() cannot name its own directory hands over "." , and cd'ing
# to that would leave the suite running from / with every relative test path broken.
case "$GUEST_CWD" in
	"$REPO"|"$REPO"/*) cd "$GUEST_CWD" 2>/dev/null || cd "$REPO" ;;
	*) cd "$REPO" ;;
esac

# Loopback only. There is no NIC on this VM, so a test that reaches for the
# network fails to connect rather than silently talking to the outside world.
ip link set lo up 2>/dev/null || ifconfig lo up 2>/dev/null || :

# bun's test runner and the TypeScript resolver hold a lot of descriptors open at
# once, and a fresh kernel's default soft limit of 1024 is nowhere near enough:
# the suite dies with "Cannot read file ...: EMFILE" before it runs a single test.
# Nothing inherits a raised limit into this VM, so PID 1 has to set it.
ulimit -n 1048576 2>/dev/null || ulimit -n 65536 2>/dev/null || :

# Kernel chatter after this point (the sysrq lines from halt_vm, most of all) would
# land in the middle of the suite's output and read as test failure noise.
echo 1 > /proc/sys/kernel/printk 2>/dev/null || :
trap - EXIT
set +e
setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all \
	/bin/bash -c "$GUEST_CMD"
status=$?
set -e

printf '%s:%s\n' "$SENTINEL_PREFIX" "$status"
halt_vm
