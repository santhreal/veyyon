#!/usr/bin/env bash
# scene-terminal: native
# The window with no thread open: the sidebar lists the seeded projects and the
# body holds the empty state.
#
#   proof/record.sh --pair proof/scenes/desktop-empty.sh
#
# Both arms: launch, wait for the host to list the corpus, photograph. No input.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
if desk_driven; then
	desk_expect_target empty 20
fi
shot empty
