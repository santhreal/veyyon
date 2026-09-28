#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 24 --rate-ms 20 --first-token-delay-ms 200
# The sidebar and the right panel sliding closed and open over a thread.
#
#   proof/record.sh --pair proof/scenes/desktop-motion.sh
#
# Publishes desktop-motion-slides.webp: sidebar closed, sidebar opened, panel
# opened, panel closed, a second apart. After arm: ToggleSidebar and TogglePanel;
# before arm: Ctrl+B (ToggleQueue) and Ctrl+\ (TogglePanel).
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_turn "Summarize the working tree changes" 1
desk_park
desk_clip_begin slides
pause 0.5
desk_action workspace::ToggleSidebar ctrl+b
pause 1.2
desk_action workspace::ToggleSidebar ctrl+b
pause 1.2
desk_action workspace::TogglePanel ctrl+backslash
pause 1.2
shot motion-panel-open
desk_action workspace::TogglePanel ctrl+backslash
pause 1.2
desk_clip_end
