#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/test-sandbox/run.sh - run the test suite inside a kernel-enforced
# sandbox whose filesystem view does not contain the operator's home directory
# at all.
#
#   bash scripts/test-sandbox/run.sh bun test packages/utils/test/foo.test.ts
#   bash scripts/test-sandbox/run.sh --probe          # print the rung table and exit
#   bash scripts/test-sandbox/run.sh --build          # build/refresh the guest image
#   bash scripts/test-sandbox/run.sh --rung=docker bun test ...
#
# This directory is the whole subsystem. run.sh is the entry point, rungs/ holds
# one file per boundary, guest/ builds and boots the userland every rung shares,
# leak-proof.sh is the red run that tries to break out, and README.md explains the
# table below in prose. See that README before changing a rung.
#
# WHY THIS EXISTS
# ---------------
# The previous defence was a bunfig preload that moved HOME and armed a write
# tripwire. It is insufficient by construction: it only applies to `bun test`
# runs that load bunfig, a standalone script has neither, and a bare config
# directory name is joined onto os.homedir(), so a new name creates a directory
# in the real home. 136 stray .veyyon* directories in the operator's home are the
# receipts. The fix has to be a boundary the test process cannot talk its way
# past, which means the kernel: a namespace or a virtual machine whose mount
# table simply has no entry that resolves to /home/<operator>.
#
# THE LADDER
# ----------
# Every rung below is a KERNEL boundary and every one of them passes the same
# hostile-write proof in scripts/test-sandbox/leak-proof.sh: nothing reaches the
# host, including a write to the hardcoded literal host home path with no
# expansion involved. They differ in how much of the kernel is shared, in whose
# kernel it is, and in what they cost.
#
# Rungs are tried in the order listed. A rung that is unavailable is announced on
# stderr with the exact reason before the next is tried, and a rung that is
# available but fails to START is announced as broken and the next is tried. It is
# never a silent drop. If a rung is pinned with --rung= or VEYYON_SANDBOX_RUNG, an
# unavailable or broken rung is a nonzero exit rather than a substitution. If no
# rung works at all this script exits nonzero and never runs on the host.
#
#   0. remote    The same container boundary as the docker rung, on ANOTHER
#                MACHINE. It is first in the order on a developer workstation and
#                absent from the order on a GitHub runner, so a local `bun test`
#                costs the operator's machine an rsync and an ssh session instead
#                of 32 cores of test load. The isolation contract is identical to
#                the docker rung and the enumerated host protections are in
#                rungs/remote.sh. See SELECTION ORDER below.
#
#   1. docker    A container with --network none, no host home bind, a fresh empty
#                tmpfs over /home, and HOME on a tmpfs. Mount and user namespaces
#                set up by the daemon; the kernel is shared with the host.
#                Measured: 0.22s of startup, and suite times within noise of a
#                bare host run.
#
#   2. microvm   qemu-system-x86_64 -machine microvm with KVM. Strictly the
#                stronger boundary and the strongest available: a separate
#                kernel, its own page tables, and a mount table built from an empty
#                initramfs. The host home is not merely unmounted, it is not
#                addressable. The repo enters through virtiofs read-only and the
#                suite writes to an overlayfs upper in guest tmpfs.
#
#                WHY IT IS NOT THE DEFAULT, despite being the strongest: measured
#                on this host it adds 2.1s of boot AND roughly 10x on small-file
#                reads, because virtiofsd 1.10 supports exactly one request queue
#                (num-request-queues>1 is rejected outright) so every lookup and
#                open is a serialised round trip to the host daemon. Reading the
#                1731 files of packages/coding-agent/src takes 0.02s under docker
#                and 0.44s here. That is not merely slow, it CHANGES TEST OUTCOMES:
#                packages/coding-agent/test/core/prompt-registry-coverage.test.ts
#                passes in 1.0s under docker and blows the 5000ms per-test default
#                here. A sandbox that turns green suites red is one people switch
#                off, and the boundary it buys over the container rung is not worth
#                that on a host where both rungs demonstrably contain the same
#                hostile writes. Select it deliberately with --rung=microvm.
#
#   3. bwrap     Bubblewrap with a mount + user namespace. Listed for hosts where
#                it works. It does NOT work on this workstation: bubblewrap 0.9.0
#                is installed and kernel.unprivileged_userns_clone=1, but
#                kernel.apparmor_restrict_unprivileged_userns=1 with no bwrap
#                profile in /etc/apparmor.d means the uid_map write is refused
#                ("bwrap: setting up uid map: Permission denied") with or without
#                --unshare-user. The probe detects this by RUNNING bwrap, because
#                the sysctl alone advertises a capability the host does not grant.
#
# NOT AVAILABLE HERE: firecracker, cloud-hypervisor, podman and crun are all
# absent, so the microVM is QEMU's microvm machine type rather than Firecracker.
# Functionally it is the same shape: virtio-mmio only, no PCI, no BIOS, direct
# kernel boot.
#
# SELECTION ORDER
# ---------------
# The remote rung is in the order when VEYYON_SANDBOX_REMOTE is 1, and out of it
# when that is 0. The default is "1 unless GITHUB_ACTIONS is set".
#
# GITHUB_ACTIONS and not CI, deliberately. CI is exported by plenty of things that
# are not a runner, including this repo's own agent harness, and those runs are
# exactly the ones the remote rung exists to move off the workstation.
# GITHUB_ACTIONS is set by one thing only, and one thing is what a gate needs. A
# runner keeps the original local-first order because it is already a disposable
# machine and has no LAN route to the remote host.
#
# MACOS CI
# --------
# macos-14 GitHub runners have no KVM, no Linux container runtime that can run a
# Linux guest without a VM of its own, and nested virtualisation is not offered.
# There is no rung on that runner that is as hard as the Linux ones. This script
# therefore REFUSES on darwin (exit 3) instead of degrading to the bare runner.
# The macOS job's job is to build and typecheck; the TypeScript suites run on the
# ubuntu runner inside the docker rung. That is stated here so nobody later
# mistakes the absence of a macOS test run for an oversight.
#
# WHERE ARTIFACTS LAND
# --------------------
# Everything built by --build goes to scripts/test-sandbox/guest/.build/ inside the
# repo, which is gitignored. Nothing is ever written under the operator's home.
# Remove it with `rm -rf scripts/test-sandbox/guest/.build` or `bash
# scripts/test-sandbox/run.sh --clean`. QEMU's own scratch goes to /dev/shm, a
# tmpfs, not to /tmp.
#
# THE MARKER
# ----------
# The guest exports VEYYON_TEST_SANDBOX=<rung id>. The test bootstrap
# (packages/utils/test/helpers/sandbox-gate.ts, owned by the SandboxGate lane)
# refuses to run when it is absent. The marker is a fast pre-check only: the gate
# also proves the real home is unreachable, and every rung here satisfies that
# proof because in none of them does the host home exist in the mount table.
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"

# The repo root, which every rung binds at this exact path. Normally derived, but a
# shell whose working directory sits outside its own root (some containers, some
# sandboxed harnesses) makes getcwd() return "." and NO in-process trick recovers
# the real path from there. VEYYON_SANDBOX_REPO_ROOT is the way out of that, and it
# is also how CI pins the checkout path explicitly rather than inferring it.
REPO_ROOT="${VEYYON_SANDBOX_REPO_ROOT:-$(cd -- "${SCRIPT_DIR}/../.." && /bin/pwd -P)}"
RUNGS_DIR="${SCRIPT_DIR}/rungs"
GUEST_DIR="${SCRIPT_DIR}/guest"
BUILD_DIR="${GUEST_DIR}/.build"

# Same shape as HOST_HOME below, same `|| true` for the same reason: `sed` exits 2
# when the file is not there, and the default on the next line is the whole point
# of reading the manifest optionally.
BUN_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([^"]*\)".*/\1/p' "${REPO_ROOT}/package.json" 2>/dev/null | head -n1 || true)"
: "${BUN_VERSION:=1.3.14}"
GUEST_IMAGE="veyyon-test-guest:${BUN_VERSION}"

# The host home this sandbox removes from the guest's view. Taken from the passwd
# database rather than $HOME so a caller who already redirected HOME cannot narrow
# what gets declared. The gate requires this exact path to be unreadable inside.
#
# `|| true` is load-bearing. `getent` exits 2 with NO output when the uid has no
# passwd entry, which is the ordinary state of a container running as a mapped
# host uid, and under `set -e` with `pipefail` that killed the driver at load with
# an empty exit 2. The HOME fallback below, written for exactly this case, could
# never run: every invocation died before reaching it, so in CI the five tests of
# the refusal contract could not execute at all and the sandbox said nothing
# rather than refusing. A boundary that dies silently is indistinguishable from
# one nobody asked for.
HOST_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6 || true)"
: "${HOST_HOME:=${HOME:-}}"

log()  { printf '[test-sandbox] %s\n' "$*" >&2; }
die()  { printf '[test-sandbox] error: %s\n' "$*" >&2; exit "${2:-2}"; }
skip() { printf '[test-sandbox] rung %-8s unavailable: %s\n' "$1" "$2" >&2; }

# An empty value is not a default, it is a refusal. The mount-relocation case
# below tests "${HOST_HOME}"/* against the repo root, so an empty home makes that
# pattern /*, which matches every absolute path and would silently relocate the
# mount. This variable decides what gets hidden; not knowing it has to stop the
# run. Checked here rather than beside the assignment because `die` is defined
# just above.
[ -n "${HOST_HOME}" ] || die "cannot tell which home to remove from the guest: no passwd entry for uid $(id -u) and HOME is unset"

# Where the repo appears INSIDE the sandbox.
#
# By default it is the host path, verbatim. Mirroring it means any absolute path
# baked into the tree resolves to the same string inside and out, and it avoids a
# short synthetic prefix like /repo colliding with a fixture literal (a real bug:
# a per-project-tagged test derives a project label from the directory name, and
# under /repo it labelled everything "repo").
#
# But mirroring is wrong when the checkout lives UNDER the home being hidden, which
# is exactly the CI case: a GitHub runner checks out to /home/runner/work/<repo>,
# so binding that path verbatim recreates /home/runner inside the sandbox and the
# gate correctly refuses, because a directory named as removed is readable again.
# In that case the repo goes somewhere outside every home instead. /srv is chosen
# because it is not a home root, not /tmp, and not short enough to collide.
case "${REPO_ROOT}/" in
	"${HOST_HOME}"/*)
		GUEST_REPO="/srv/veyyon"
		log "the checkout is inside ${HOST_HOME}, so it is mounted at ${GUEST_REPO} in the sandbox rather than at its host path: mirroring it would put ${HOST_HOME} back in reach"
		;;
	*)
		GUEST_REPO="${REPO_ROOT}"
		;;
esac

# Exit status a runner uses to say "the sandbox could not be established and NO
# guest command ran". It is the ONLY status that lets the driver descend the
# ladder. A suite that ran and failed returns its own status and is never retried
# somewhere weaker, because retrying a red suite on a different boundary until it
# goes green is how a sandbox becomes a liar.
RUNG_SETUP_FAILED=126

# One file per rung. Each defines probe_<id>, run_<id> and binprobe_<id>, and reads
# the variables above. They are separate files because a rung is the unit people
# add, read and delete, and because a 400-line driver with four boundaries inlined
# is where the reasoning for each one goes to die.
# shellcheck source=rungs/remote.sh
. "${RUNGS_DIR}/remote.sh"
# shellcheck source=rungs/docker.sh
. "${RUNGS_DIR}/docker.sh"
# shellcheck source=rungs/microvm.sh
. "${RUNGS_DIR}/microvm.sh"
# shellcheck source=rungs/bwrap.sh
. "${RUNGS_DIR}/bwrap.sh"

# --- driver ----------------------------------------------------------------

# Selection order. See the SELECTION ORDER note above for why GITHUB_ACTIONS is the signal.
if [ "${VEYYON_SANDBOX_REMOTE:-$([ -n "${GITHUB_ACTIONS:-}" ] && echo 0 || echo 1)}" = "1" ]; then
	RUNGS=(remote docker microvm bwrap)
else
	RUNGS=(docker microvm bwrap)
fi

# Every rung that exists, whether or not it is in the selection order. --rung= can
# name any of these: pinning a rung is a deliberate act and must not be refused
# because the automatic order happens to leave it out today.
KNOWN_RUNGS=(remote docker microvm bwrap)

# The binaries the suites spawn. Reported by --probe so a lane can see the gap
# before it spends twenty minutes attributing an environment failure to its own
# change. git is the one that actually bit: the stock bun image has no git, and
# `Executable not found in $PATH: "git"` reads exactly like a code regression.
REQUIRED_BINS=(bun git sh)
OPTIONAL_BINS=(node python3 rg ssh gh)

usage() {
	cat <<'EOF'
Run a command inside a kernel-enforced sandbox with no path to the operator's home.

  bash scripts/test-sandbox/run.sh bun test <paths>   run a suite in the first available rung
  bash scripts/test-sandbox/run.sh --probe            print the rung table and exit
  bash scripts/test-sandbox/run.sh --build            build and verify the guest for the selected rung
  bash scripts/test-sandbox/run.sh --clean            remove the built guest artifacts
  bash scripts/test-sandbox/run.sh --rung=<name> ...  pin a rung; fail rather than substitute
  bash scripts/test-sandbox/run.sh --help             this text

Rungs: remote, docker, microvm, bwrap. An unavailable rung is announced on stderr
with its reason and the next one is tried. If none is available the command is NOT
run on the host; the script exits nonzero.

Environment:
  VEYYON_SANDBOX_RUNG       pin a rung, same as --rung=
  VEYYON_SANDBOX_REMOTE     1 to put the remote rung first, 0 to leave it out
                            (default: 0 on GitHub Actions, 1 otherwise)
  VEYYON_SANDBOX_REMOTE_HOST  ssh destination for the remote rung
  VEYYON_SANDBOX_REPO_RO    1 to mount the repo read-only (used by the leak proof)
  VEYYON_SANDBOX_TIMEOUT    seconds before a wedged guest is killed (default 1800)
  VEYYON_SANDBOX_FORWARD    extra env var names to carry into the sandbox
EOF
}

report_bins() {
	local rung="$1" b out
	out="$("binprobe_${rung}" 'for b in '"${REQUIRED_BINS[*]} ${OPTIONAL_BINS[*]}"'; do command -v "$b" >/dev/null && echo "+$b" || echo "-$b"; done' 2>/dev/null || true)"
	[ -n "$out" ] || { printf '      (could not probe binaries in this rung)\n'; return 0; }
	local have="" missing_req="" missing_opt=""
	for b in "${REQUIRED_BINS[@]}" "${OPTIONAL_BINS[@]}"; do
		if printf '%s\n' "$out" | grep -qx -- "+$b"; then
			have="${have}${b} "
		elif printf '%s ' "${REQUIRED_BINS[@]}" | grep -qw -- "$b"; then
			missing_req="${missing_req}${b} "
		else
			missing_opt="${missing_opt}${b} "
		fi
	done
	printf '      provides:          %s\n' "${have:-(none)}"
	[ -n "$missing_req" ] && printf '      MISSING (required): %s  <- suites that spawn these will fail for an environment reason\n' "$missing_req"
	[ -n "$missing_opt" ] && printf '      missing (optional): %s\n' "$missing_opt"
	return 0
}

print_probe_table() {
	printf '%s\n' "host:   $(uname -s) $(uname -r) $(uname -m)"
	printf '%s\n' "bun:    ${BUN_VERSION} (from package.json packageManager)"
	printf '%s\n' "repo:   ${REPO_ROOT}  (bound at ${GUEST_REPO} inside every rung)"
	printf '%s\n' "home:   ${HOST_HOME}  (declared removed; each rung is checked against it)"
	printf '%s\n' "--- rung availability, in selection order (see the LADDER note in this file) ---"
	local r reason
	for r in "${RUNGS[@]}"; do
		if reason="$("probe_${r}" 2>&1 >/dev/null)"; then
			printf '  %-8s AVAILABLE\n' "$r"
			report_bins "$r"
		else
			printf '  %-8s unavailable\n' "$r"
			printf '%s\n' "${reason#*unavailable: }" | sed 's/^/      /'
		fi
	done
	local k listed
	for k in "${KNOWN_RUNGS[@]}"; do
		listed=0
		for r in "${RUNGS[@]}"; do [ "$r" = "$k" ] && listed=1; done
		[ "$listed" = 1 ] || printf '  %-8s not in the selection order here; pin it with --rung=%s\n' "$k" "$k"
	done
}

# --build targets whichever rung the caller pinned, because a remote rung's guest
# image lives on the remote host and building it locally would leave the pinned
# rung just as unavailable as before.
build_for() {
	case "${1:-}" in
		remote) remote_build; exit 0 ;;
		*)      exec bash "${GUEST_DIR}/build-guest.sh" ;;
	esac
}

main() {
	local pinned="${VEYYON_SANDBOX_RUNG:-}"
	local action=""
	local -a cmd=()

	# Argv that does not run a suite is answered before any rung is touched. A tool
	# whose --help cannot be reached because its default backend is down is broken
	# for everyone who has not already learned the workaround. The action is
	# recorded rather than executed here so `--build --rung=remote` and
	# `--rung=remote --build` mean the same thing.
	while [ $# -gt 0 ]; do
		case "$1" in
			-h|--help) usage; exit 0 ;;
			--probe)   action=probe; shift ;;
			--build)   action=build; shift ;;
			--clean)   action=clean; shift ;;
			--remote-shell) shift; action=remote-shell; cmd=("$@"); break ;;
			--rung=*)  pinned="${1#--rung=}"; shift ;;
			--rung)    pinned="${2:-}"; shift 2 ;;
			--)        shift; cmd=("$@"); break ;;
			*)         cmd=("$@"); break ;;
		esac
	done

	if [ -n "$pinned" ]; then
		local found=0 r
		for r in "${KNOWN_RUNGS[@]}"; do [ "$r" = "$pinned" ] && found=1; done
		[ "$found" = 1 ] || die "unknown rung '${pinned}'. Known rungs: ${KNOWN_RUNGS[*]}"
	fi

	case "$action" in
		probe) print_probe_table; exit 0 ;;
		build) build_for "$pinned" ;;
		clean) rm -rf "${BUILD_DIR}"; log "removed ${BUILD_DIR}"; exit 0 ;;
		# A diagnostic, not part of the sandbox. leak-proof.sh uses it to inspect the
		# REMOTE host's own home after a hostile run, which is the one thing the local
		# before/after listing cannot see. It reuses the rung's ssh settings so the
		# destination and the key are configured in exactly one place.
		remote-shell)
			[ ${#cmd[@]} -gt 0 ] || die "--remote-shell needs a command"
			remote_ssh "${REMOTE_SSH_DEST}" "${cmd[@]}"; exit $? ;;
	esac

	[ ${#cmd[@]} -gt 0 ] || { usage >&2; die "no command given"; }

	# THE BOOTSTRAP ESCAPE HATCH. Inside a guest the marker is already set, by the
	# guest itself, so this invocation is the sandbox's own bootstrap running the
	# command it was created to run. Without this, `bun run test` inside the guest
	# would start another guest, forever.
	#
	# This is not a bypass. A developer who exports VEYYON_TEST_SANDBOX on the host
	# to get past it lands straight on the test bootstrap's gate, which reads the
	# filesystem and refuses while a real home is reachable. No environment variable
	# can make a directory unreadable.
	if [ -n "${VEYYON_TEST_SANDBOX:-}" ]; then
		log "already inside the '${VEYYON_TEST_SANDBOX}' sandbox; running directly"
		exec "${cmd[@]}"
	fi
	if [ "$(uname -s)" != "Linux" ]; then
		die "no kernel-level isolation rung exists on $(uname -s). This script refuses to run the suite on the bare host. On macOS CI the TypeScript suites are expected to run on the ubuntu runner; see the MACOS CI note in this file." 3
	fi

	local r status

	if [ -n "$pinned" ]; then
		"probe_${pinned}" || die "rung '${pinned}' was pinned but is not available on this host (reason above). Refusing to substitute a weaker boundary."
		log "rung ${pinned} (pinned)"
		set +e; "run_${pinned}" "${cmd[@]}"; status=$?; set -e
		[ "$status" = "$RUNG_SETUP_FAILED" ] && die "rung '${pinned}' was pinned but failed to establish the sandbox (reason above). Refusing to substitute a weaker boundary."
		exit "$status"
	fi

	for r in "${RUNGS[@]}"; do
		"probe_${r}" || continue
		log "rung ${r}"
		set +e; "run_${r}" "${cmd[@]}"; status=$?; set -e
		if [ "$status" = "$RUNG_SETUP_FAILED" ]; then
			# The rung was available but could not establish the sandbox, and no guest
			# command ran. Say so loudly and try the next one. This is a reported
			# degradation, not a silent one, and it is what keeps one broken rung from
			# being a single point of failure for the whole repo.
			log "rung ${r} FAILED TO START (reason above); descending to the next rung"
			continue
		fi
		exit "$status"
	done

	die "no isolation rung could run this command, so there is nowhere safe to run the suite and this script will not run it on the host.
  Tried, in selection order: ${RUNGS[*]} (each rung's reason is printed above).
  To get the primary rung working:  bash scripts/test-sandbox/run.sh --build
  To see the full probe table:      bash scripts/test-sandbox/run.sh --probe"
}

main "$@"
