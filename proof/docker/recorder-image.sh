#!/usr/bin/env bash
# Which recorder image a capture runs in.
#
#   source proof/docker/recorder-image.sh   # sets BUN_VERSION and RECORDER_IMAGE
#
# The tag carries the bun version because the image carries a bun, and the product
# refuses to start on a runtime older than the one it is built for. Hand-numbered
# tags (`:4`, `:5`) could not express that: the repo moved to bun 1.4.0, every
# recorder kept naming an image built against 1.3.14, and the failure surfaced as
# `Bun runtime must be >= 1.4.0` inside the container, after the display server,
# the compositor and the terminal had all come up. A tag derived from the
# declaration means a stale image is a missing image, and docker says so before
# anything else starts.
#
# Build it with proof/docker/build-recorder.sh. RECORDER_IMAGE still overrides,
# for a rebuild under a scratch tag.

# shellcheck source=scripts/bun-version.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && /bin/pwd -P)/scripts/bun-version.sh"

# The image's own revision, bumped whenever Dockerfile.recorder changes what the
# image CONTAINS. The bun version alone could not express that: adding the Vulkan
# ICD the desktop scenes need left every existing `bun1.4.0` image valid by tag
# and short of the package, so a capture failed inside the container after the
# display server had come up. Bumping this makes a stale image a missing one,
# which docker reports before anything else starts.
RECORDER_REVISION=2
RECORDER_IMAGE="${RECORDER_IMAGE:-veyyon-proof-recorder:bun${BUN_VERSION}-r${RECORDER_REVISION}}"
