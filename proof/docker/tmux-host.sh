#!/usr/bin/env bash
# Run the product inside tmux for a capture, so a scene can check behaviour that depends on
# the multiplexer rather than on the emulator underneath it.
#
#   SCENE_COMMAND="bash /repo/proof/docker/tmux-host.sh on bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"
#
# The first argument is tmux's own `mouse` option, and it is the whole reason this exists.
# With `mouse off` tmux forwards a terminal's mouse report to the pane's application. With
# `mouse on` tmux consumes the report for its own pane and copy-mode bindings, except while
# the application in the pane has enabled mouse reporting itself, in which case the report is
# delivered to the application instead. The footline's click handler rests on that exception,
# and a capture is how it is established rather than quoted: both arms are recorded, and the
# clicks either land or they do not.
#
# The pane is one row shorter than the window, because tmux keeps a status line at the bottom.
# A scene aims at the footline by finding the row its text is on, so the offset needs no
# arithmetic here; a scene that hard-coded a row from the window height would need it.
set -euo pipefail

MOUSE="${1:?usage: tmux-host.sh <on|off> <command...>}"
shift
case "${MOUSE}" in
on | off) ;;
*)
	echo "tmux-host.sh: mouse must be on or off, got ${MOUSE}" >&2
	exit 2
	;;
esac

CONF="$(mktemp "${TMPDIR:-/tmp}/tmux-proof.XXXXXX")"
{
	printf 'set -g mouse %s\n' "${MOUSE}"
	# Truecolor through the pane, so a frame recorded inside tmux is comparable with the
	# frames recorded without it. tmux advertises a conservative terminal to the pane
	# otherwise, and the row's colours would differ for a reason that is not the change.
	printf 'set -ga terminal-features ",*:RGB"\n'
	# An escape sequence split across reads is the multiplexer's failure mode, not the
	# product's; 10ms is short enough that a real key never waits on it.
	printf 'set -s escape-time 10\n'
} >"${CONF}"

exec tmux -f "${CONF}" new-session -s proof -- "$@"
