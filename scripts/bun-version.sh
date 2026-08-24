#!/usr/bin/env bash
# The bun version this repo runs on, read from the one field that declares it.
#
#   BUN_VERSION="$(bash scripts/bun-version.sh)"
#   source scripts/bun-version.sh   # sets BUN_VERSION in the caller
#
# `packageManager` in the root package.json is the declaration; every image built
# for this repo is tagged from it so a bump cannot leave a stale image behind. It
# did: the recorder image sat on bun 1.3.14 after the repo moved to 1.4.0, and the
# next hero take died inside the container on the product's own runtime check
# after the whole recording rig had already started.

_bun_version_repo_root() {
	cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && /bin/pwd -P
}

BUN_VERSION="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([^"]*\)".*/\1/p' "$(_bun_version_repo_root)/package.json" | head -n1)"
if [ -z "${BUN_VERSION}" ]; then
	echo "scripts/bun-version.sh: package.json declares no \"packageManager\": \"bun@<version>\"" >&2
	exit 2
fi

# Sourced: the caller wanted the variable. Executed: print it.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	printf '%s\n' "${BUN_VERSION}"
fi
