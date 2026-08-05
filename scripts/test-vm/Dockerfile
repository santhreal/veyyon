# The guest userland shared by BOTH sandbox rungs: it is the image the docker rung
# runs directly, and the filesystem that build-guest.sh exports into the microVM's
# initramfs. One userland means a suite behaves the same whichever rung ran it.
#
# WHY DOCKER BUILDS THIS
# ----------------------
# Nothing else on this host can materialise a Linux root filesystem. debootstrap,
# mkosi, podman and crun are all absent and installing them is out of scope. Docker
# is used here purely as a tarball factory: `docker export` yields a plain rootfs
# tar that build-guest.sh turns into a cpio initramfs. The microVM does not talk to
# the docker daemon at run time and does not need docker to boot.
#
# WHY oven/bun:<version>-debian AS THE BASE
# -----------------------------------------
# Two reasons, both load-bearing. It pins bun to the exact version in the root
# package.json "packageManager" field, so the guest runs the runtime the host
# lockfile was resolved with. And it is glibc: the repo's node_modules on the host
# hold prebuilt glibc native addons (napi-rs @veyyon/natives, and transitively
# others), and those are mounted into the guest rather than rebuilt there, so a
# musl guest would fail to dlopen them. A musl image would be a third of the size
# and is the wrong answer anyway.
#
# WHAT IS ADDED AND WHY
# ---------------------
# The list is not guessed. Each entry is a binary the test suites actually spawn,
# counted by grepping the test trees for it. The failure mode being avoided is
# specific and expensive: a suite that passes on the host and fails in the sandbox
# because a binary is missing reads exactly like a code regression, and a lane will
# spend twenty minutes bisecting its own clean change before suspecting the image.
#
#   git, ca-certificates   Shelled out to by hindsight-bank worktree handling, the
#                          gh tool tests, and the doc-freshness checks. The stock
#                          bun image has no git at all; this was the first thing to
#                          bite, and it cost a lane a misattributed failure.
#   ripgrep                64 test files reference it.
#   openssh-client         20 test files reference the ssh tool.
#   python3                8 test files reference it.
#   util-linux             setpriv, used by the guest init to drop from PID 1 root
#                          to the synthetic account.
#   kmod                   modprobe for virtiofs/overlay in the microVM.
#   cpio                   builds the initramfs from inside this image, as root, so
#                          the archive records root ownership.
#   procps, xz-utils,      ps, decompression, and `ip link set lo up`, all of which
#   iproute2               the suites or the guest init expect to exist.
#
# NOT INSTALLED, deliberately: gh (the GitHub CLI). It is not in Debian's archive,
# and the 36 test files that mention it drive a mocked transport rather than the
# real binary. `bash scripts/test-sandbox.sh --probe` lists what each rung provides
# and what it is missing, so this stays visible rather than becoming folklore.
#
# WHERE IT LANDS
# --------------
# The image is tagged veyyon-test-guest:<bun version>. Build artifacts derived from
# it go to scripts/test-vm/.build/, which is gitignored. Nothing is written under
# the operator's home. `bash scripts/test-sandbox.sh --clean` removes the artifacts;
# `docker image rm veyyon-test-guest:<version>` removes the image.

ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}-debian

RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        git ca-certificates util-linux kmod procps xz-utils cpio iproute2 \
        ripgrep openssh-client python3; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    git --version; \
    bun --version; \
    rg --version; \
    python3 --version; \
    test -x /usr/bin/setpriv

# The kernel opens /dev/console to give PID 1 its stdio, and it does that BEFORE
# /init can mount devtmpfs. So this node has to exist in the initramfs itself.
RUN set -eux; \
    mkdir -p /dev; \
    [ -e /dev/console ] || mknod -m 0600 /dev/console c 5 1; \
    [ -e /dev/null ] || mknod -m 0666 /dev/null c 1 3
# The one and only account inside the guest. Its home is created on a tmpfs at boot
# by /init; this entry exists so getpwuid(1000) resolves and tools that read the
# passwd database see a home that is not the operator's.
RUN set -eux; \
    if ! getent group 1000 >/dev/null; then groupadd -g 1000 veyyon; fi; \
    if ! getent passwd 1000 >/dev/null; then useradd -u 1000 -g 1000 -d /home/veyyon -s /bin/bash veyyon; fi; \
    usermod -d /home/veyyon "$(getent passwd 1000 | cut -d: -f1)"

COPY guest-init.sh /init
RUN chmod 0755 /init
