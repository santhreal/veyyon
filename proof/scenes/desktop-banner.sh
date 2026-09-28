#!/usr/bin/env bash
# scene-terminal: native
# The connection banner after the window loses its GUI host: the host process is
# ended under a running window.
#
#   proof/record.sh --pair proof/scenes/desktop-banner.sh
#
# Both arms end the host with pkill on its command line and photograph the
# window once the link is reported lost; the after arm waits for the
# connection-banner target, the before arm for the window to settle.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_kill_host
desk_expect_target connection-banner 20
desk_park
shot banner
