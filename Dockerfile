# syntax=docker/dockerfile:1.7-labs
###############################################################################
# veyyon — veyyon image
#
# Stages:
#   natives-builder — Rust + Bun → veyyon_natives.linux-<arch>.node
#   wheel-builder   — veyyon_rpc Python wheel
#   base         — python + bun + rustup launcher + natives + veyyon_rpc
#                     + /usr/local/bin/veyyon shim
#   runtime      — base + veyyon source + bun install      (DEFAULT, runnable)
#
# Build:
#     docker build -t veyyon:dev .                          # default = runtime
#     docker build --target base -t veyyon:base .    # base for derived images
#
# Run:
#     docker run --rm veyyon:dev --help
#     docker run --rm -it -v "$PWD":/work veyyon:dev cli    # interactive veyyon
#
# Consume as a base in another Dockerfile (see Dockerfile.veybot):
#     ARG VEYYON_BASE=veyyon:dev
#     FROM ${VEYYON_BASE} AS base
###############################################################################

ARG BUN_VERSION=1.3.14

############################
# 1) natives-builder — Rust + Bun → veyyon_natives.linux-<arch>.node
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION
ENV BUN_INSTALL=/opt/bun \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
    CARGO_TERM_COLOR=never

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates pkg-config libssl-dev unzip git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

WORKDIR /veyyon

# Layer 1 — manifests + lockfiles only. Source edits under packages/*/src and
# crates/*/src won't bust `bun install` below. `--parents` preserves the
# matched path under /veyyon/ (requires syntax 1.7-labs).
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    Cargo.toml Cargo.lock rust-toolchain.toml \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/veybot/web/package.json \
    crates/*/Cargo.toml \
    /veyyon/

# Layer 2 — hydrate node_modules from the manifests above.
RUN bun install --frozen-lockfile --ignore-scripts

# Layer 3 — full source. `Dockerfile.dockerignore` keeps target/, node_modules/,
# dist/, runs/, editor noise, etc. out of the context. node_modules from Layer 2
# is preserved across this COPY because it's never in the build context.
COPY . /veyyon/

# Layer 4 — compile veyyon-natives to a Linux N-API addon. Persistent caches keep
# repeat builds incremental: cargo's package index + git-deps + the workspace
# target dir.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/veyyon/target \
    set -eux; \
    rustup show; \
    bun --cwd=packages/natives run build; \
    mkdir -p /out; \
    cp packages/natives/native/veyyon_natives.linux-*.node /out/

############################
# 2) wheel-builder — veyyon-rpc wheel
############################
FROM python:3.12-slim-bookworm AS wheel-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --upgrade pip build

WORKDIR /src
COPY python/veyyon-rpc /src
RUN python -m build --wheel --outdir /out

############################
# 3) base — python + bun + rustup + natives + veyyon_rpc + veyyon shim
#
# Sharable runtime base. Derived images (runtime below, Dockerfile.veybot)
# extend this and overlay their own source tree. Default VEYYON_ROOT=/work/veyyon is
# friendly to derived images that mount a host veyyon checkout there; runtime
# overrides it to /veyyon because its source is baked in.
############################
FROM python:3.12-slim-bookworm AS base

ARG BUN_VERSION
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BUN_INSTALL=/opt/bun \
    VEYYON_ROOT=/work/veyyon \
    CARGO_HOME=/data/cache/cargo \
    CARGO_TARGET_DIR=/data/cache/cargo-target \
    RUSTUP_HOME=/data/cache/rustup \
    PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git curl ca-certificates unzip openssh-client tini sqlite3 \
        build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && /opt/bun/bin/bun --version

# Rustup launcher only — the real toolchain is fetched lazily into RUSTUP_HOME
# on first cargo invocation, driven by veyyon's `rust-toolchain.toml`. Keeps the
# image small while sharing the toolchain across reboots when /data is mounted.
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup-bootstrap \
       sh /tmp/rustup-init.sh -y --no-modify-path --default-toolchain none --profile minimal \
    && rm -f /tmp/rustup-init.sh \
    && rm -rf /usr/local/rustup-bootstrap \
    && /usr/local/cargo/bin/rustup --version

# veyyon-natives addon: veyyon's loader probes /opt/bun/bin as a fallback path.
COPY --from=natives-builder /out/veyyon_natives.linux-*.node /opt/bun/bin/

# veyyon-rpc Python wheel.
COPY --from=wheel-builder /out/*.whl /tmp/wheels/
RUN pip install /tmp/wheels/veyyon_rpc-*.whl && rm -rf /tmp/wheels

# `veyyon` shim — runs the coding-agent CLI against $VEYYON_ROOT via Bun. Derived
# images override VEYYON_ROOT to point at wherever their veyyon source lives.
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    ': "${VEYYON_ROOT:=/work/veyyon}"' \
    'if [ ! -d "$VEYYON_ROOT/packages/coding-agent" ]; then' \
    '  echo "veyyon: VEYYON_ROOT=$VEYYON_ROOT does not look like a veyyon checkout" >&2' \
    '  exit 127' \
    'fi' \
    'exec bun "$VEYYON_ROOT/packages/coding-agent/src/cli.ts" "$@"' \
    > /usr/local/bin/veyyon \
    && chmod +x /usr/local/bin/veyyon

############################
# 4) runtime — base + veyyon source + bun install (DEFAULT)
#
# A self-contained, runnable veyyon image. `docker run veyyon:dev --help`
# Just Works without a host checkout.
############################
FROM base AS runtime

ENV VEYYON_ROOT=/veyyon
WORKDIR /veyyon

# Same manifests-only layered install pattern as natives-builder — `bun install`
# only re-runs when a package.json / lockfile changes.
COPY --parents \
    package.json bun.lock bunfig.toml \
    patches/*.patch \
    tsconfig.base.json tsconfig.json \
    packages/*/package.json \
    packages/tsconfig.workspace.json \
    python/veybot/web/package.json \
    /veyyon/

RUN bun install --frozen-lockfile --ignore-scripts

# Veyyon source. `Dockerfile.dockerignore` keeps **/node_modules out of the context
# so stale isolated-linker symlinks from a host install can't shadow the
# hoisted node_modules that `bun install` just produced.
COPY . /veyyon/

# Regenerate the tool views that `--ignore-scripts` skipped above. The root
# package.json's `prepare` script normally handles these on a vanilla install.
RUN bun --cwd=packages/coding-agent run gen:tool-views

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/veyyon"]
CMD ["--help"]
