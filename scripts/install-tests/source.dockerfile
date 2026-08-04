# Build and run veyyon from a checkout, which is the manual route every installer
# hard failure names: `git clone … && cd veyyon && bun run setup`. The installer
# itself never does this, so nothing here goes through install.sh.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl ca-certificates unzip build-essential && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Rust (needed to build native addon)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:$PATH"

# Copy local repo
WORKDIR /repo
COPY . .

# Install dependencies, build native addon, and link globally
RUN bun install --frozen-lockfile
RUN bun --cwd=packages/natives run build
RUN cd packages/coding-agent && bun link

# Verify
RUN veyyon --version
