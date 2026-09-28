#!/usr/bin/env bash
# scene-terminal: native
# desktop-llm: --tokens 24 --rate-ms 20 --first-token-delay-ms 200
# The sidebar and the right panel sliding closed and open over a thread, after a
# control span that measures the recorder itself.
#
#   proof/record.sh --before proof/scenes/desktop-motion.sh
#   proof/record.sh proof/scenes/desktop-motion.sh
#
# Publishes two clips, each gated with proof/webp-cadence.py --expect-ms 33:
#
#   desktop-motion-control.webp  the pointer travelling along the window's top
#                                edge while the window is idle
#   desktop-motion-slides.webp   sidebar closed, sidebar opened, panel opened,
#                                panel closed, a second apart
#
# THE CONTROL. x11grab paints the cursor into every frame it grabs, and the pointer
# moves in 10 ms steps, so each captured frame differs from the one before it and the
# encoder merges none of them. The control clip therefore holds the capture interval
# unless the recorder itself drops frames, and a slides clip that fails in the same
# take fails on what the window drew.
#
# After arm: ToggleSidebar and TogglePanel; before arm: Ctrl+B (ToggleQueue) and
# Ctrl+\ (TogglePanel), which show and hide both regions in one frame. Record the
# arms one at a time: a before build whose slides clip fails the gate ends --pair
# before the after arm starts.
# shellcheck source=proof/scenes/desktop-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"

desk_ready
desk_turn "Summarize the working tree changes" 1
desk_park

# Left to right across the middle half of the top edge in 10 ms steps, as one
# xdotool process so no fork lands between two moves.
desk_sweep() { # <seconds>
	local steps=$(($1 * 100)) x0=$((WIN_X + WIN_W / 4)) span=$((WIN_W / 2)) y=$((WIN_Y + 3)) i
	local moves=()
	for i in $(seq 0 "${steps}"); do
		moves+=(mousemove "$((x0 + span * i / steps))" "${y}" sleep 0.01)
	done
	xdotool "${moves[@]}"
}

desk_clip_begin control
desk_sweep 2
desk_clip_end
desk_park

# The rebuilt composer blinks its caret every 530 ms until it has gone a while
# without input, then holds it solid. A blink between two slides splits the still
# screen between them into holds shorter than the gate's still threshold, which
# the gate counts as slow moving frames, so that arm starts the slides once the
# window draws nothing at all. The older window's caret does not blink and its
# thread card counts seconds, so that arm does not wait.
if desk_driven; then
	desk_settle 20 3 1
fi
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
