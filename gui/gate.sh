#!/usr/bin/env bash
# The gui workspace's own gate.
#
# gui/ is outside the root Cargo workspace on purpose, so no root gate compiles
# it and no root gate reports on it. This is the one that does.
#
#   ./gate.sh          format, lint and test
#   ./gate.sh fmt      rewrite formatting instead of checking it
#
# Never sets a cargo target directory: the host's cargo config owns it.

set -euo pipefail

cd "$(dirname "$0")"

if [[ "${1:-}" == "fmt" ]]; then
	cargo fmt --all
	exit 0
fi

# --all-targets so clippy compiles the test targets too. Without it a test file
# that does not build passes both the format and lint gates and fails later.
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
