#!/usr/bin/env bash
# Exercise native pointer focus and terminal input through the real host PTY.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# The frame the drawer opens over: the preamble ends with its palette dismissed,
# so this is the session at rest with a draft in the composer.
AT_REST="${SCENE_RUNTIME_DIR}/frame-compare/terminal-at-rest.png"
probe_frame "${AT_REST}"

k "ctrl+backslash"
pause 0.25
k "ctrl+j"
pause 2
shot terminal-open

move_px "$(( WIN_X + WIN_W / 2 ))" "$(( WIN_Y + WIN_H - 90 ))"
click
pause 0.25
t "echo terminal-input-ok"
k "Return"
pause 1.5
shot terminal-command-output

# ─── What These Frames State ─────────────────────────────────────────────────
# Two frames named for a drawer and for a command answered inside it. A chord
# the window declined, or a drawer the capability table withheld (§5.13),
# publishes the session it was already drawing under both names, and the pty is
# never reached at all.
transcript_region
DRAWN="$(frames_differ_per_mille "${AT_REST}" "${SCENE_OUT}/${SCENE_NAME}-terminal-open.png")"
if [ "${DRAWN}" -lt 40 ]; then
	abandon_take "the-drawer-answered-its-chord" \
		"the session surface changed ${DRAWN}/1000 on primary-j, so no terminal drawer opened over it"
fi
ANSWERED="$(shots_differ_pixels terminal-open terminal-command-output)"
if [ "${ANSWERED}" -lt 150 ]; then
	abandon_take "the-pty-answered-the-command" \
		"the drawer changed ${ANSWERED} pixels after a command and a Return, so the echo never reached the pty"
fi
echo "scene: drawer ${DRAWN}/1000 open, ${ANSWERED}px answered" >&2
