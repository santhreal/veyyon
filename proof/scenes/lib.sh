#!/usr/bin/env bash
# Helpers a scene uses to drive the terminal: keys, text, a real pointer, and
# stills cut out of the same display ffmpeg is recording.
#
# Sourced by proof/docker/xsession.sh with DISPLAY, SCENE_WINDOW, SCENE_NAME and
# SCENE_OUT already exported.

# The grid comes from the shell (`stty size`), and the pixel size of a cell from
# the window divided by that grid. Asking the terminal directly (CSI 16t) only
# works where window operations are enabled, which xterm disables by default.
read -r TERM_ROWS TERM_COLS <<<"$(sed -n 's/^stty=//p' /tmp/geom)"
PAD="${SCENE_PADDING:-8}"
: "${TERM_ROWS:=40}" "${TERM_COLS:=150}"
_win_px() { xdotool getwindowgeometry "${SCENE_WINDOW}" | sed -n 's/.*Geometry: \([0-9]*\)x\([0-9]*\)/\1 \2/p'; }
read -r WIN_W WIN_H <<<"$(_win_px)"
: "${WIN_W:=1600}" "${WIN_H:=1000}"
# A themed capture insets the window so the backdrop and the compositor's shadow
# are visible, so the window's own origin is no longer the screen's. Every
# pointer target is a pixel on the ROOT window, which is what xdotool moves and
# what ffmpeg records, so the origin has to be added back. It is 0,0 for a plain
# full-screen capture, which leaves those scenes aiming at exactly the pixels
# they did before.
_win_origin() { xdotool getwindowgeometry "${SCENE_WINDOW}" | sed -n 's/.*Position: \([0-9]*\),\([0-9]*\).*/\1 \2/p'; }
read -r WIN_X WIN_Y <<<"$(_win_origin)"
: "${WIN_X:=0}" "${WIN_Y:=0}"
CELL_W=$(((WIN_W - 2 * PAD) / TERM_COLS))
CELL_H=$(((WIN_H - 2 * PAD) / TERM_ROWS))
: "${CELL_W:=9}" "${CELL_H:=18}"
echo "scene ${SCENE_NAME}: ${TERM_COLS}x${TERM_ROWS} cells of ${CELL_W}x${CELL_H}px at +${WIN_X}+${WIN_Y}"

# Row and column are 1-based, the way the terminal counts them.
px_x() { echo $((WIN_X + (${1} - 1) * CELL_W + CELL_W / 2 + PAD)); }
px_y() { echo $((WIN_Y + (${1} - 1) * CELL_H + CELL_H / 2 + PAD)); }

pause() { sleep "${1:-0.5}"; }

# Keys go to the window xsession.sh found. That id can go stale: kitty may map a
# second window during startup and retire the first, and every key after that
# dies of BadWindow -- which under `set -e` takes the recorder down with it,
# leaving a video that stops at the first keystroke and no gif and no stats. The
# whole scene had already run past its load when that happened on the fresh arm
# of the long-session pair. So a send that fails on the id is retried against
# whatever holds the focus, and a send that fails both ways is reported and does
# not abort the run: a scene that loses one key is worth more than no recording.
_xdo() {
	local verb="$1"
	shift
	xdotool "${verb}" --clearmodifiers --window "${SCENE_WINDOW}" "$@" 2>/dev/null && return 0
	xdotool "${verb}" --clearmodifiers "$@" 2>/dev/null && return 0
	echo "scene: ${verb} ${*} reached no window" >&2
	return 0
}

k() { _xdo key "$@"; }
key_repeat() { # key_repeat <key> <count> [delay]
	local key="$1" count="$2" delay="${3:-0.12}"
	for _ in $(seq 1 "${count}"); do
		_xdo key "${key}"
		sleep "${delay}"
	done
}
# TYPED TEXT DOES NOT GO THROUGH X AT ALL, and three lost takes are the reason.
#
# `xdotool type` synthesises a key press and release per character. Under load that
# duplicates characters, and every knob that looks like a fix only moves the failure:
# --delay 0 composed "/sseccret ffrom-env RELEASE_SIGNATURE release-siggnature", X
# autorepeat turned out to be most of the mechanism and is now off, 24ms still produced
# "commmand" while the app repainted a streamed turn, and 60ms produced "src/pparser.tts".
# A recorder that mistypes one character in a slash command loses the whole segment, and
# the frame is the only place it shows.
#
# kitty's remote control writes the bytes straight into the pty. There are no key events
# to duplicate, it is instant, which is what the clip wanted anyway, and what the terminal
# receives is exactly the string the scene asked for. Special keys stay on XTEST below:
# they carry no payload to corrupt, and Return through the pty would submit before the
# completion popup could be dismissed.
#
# The xdotool path remains as a fallback for a terminal without the socket -- an xterm
# scene, or an image built before this -- and it keeps the delay that behaved best.
KITTY_SOCKET="${KITTY_SOCKET:-unix:/tmp/kitty.sock}"

# WHICH PATH A RUN TOOK IS PART OF THE EVIDENCE. A silent fallback would look exactly
# like a working fix -- green gate, doubled characters in the next take -- so the first
# send says which one it is and the run's log carries it.
_typing_path=""
t() {
	if kitty @ --to "${KITTY_SOCKET}" send-text -- "$1" 2>/dev/null; then
		[ -n "${_typing_path}" ] || {
			_typing_path=injection
			echo "scene: typing through kitty remote control (${KITTY_SOCKET})" >&2
		}
		return 0
	fi
	[ -n "${_typing_path}" ] || {
		_typing_path=xtest
		echo "scene: typing through xdotool at ${TYPE_DELAY:-60}ms; the socket answered nothing" >&2
	}
	_xdo type --delay "${TYPE_DELAY:-60}" -- "$1"
}

# A submit starts from an empty composer, always.
#
# NOT DEFENSIVE POLISH: the take that needed it lost its signing turn to leftover text.
# A slash command whose Return the completion popup swallowed stayed in the composer, and
# the next prompt was typed onto the end of it, so the model received
# "/secret listsign your work: run one bash command that pipes ...". One prompt, one
# unrelated command glued to its front, and nothing on screen says so until a frame is
# read. ctrl+u is the editor's delete-to-line-start, so an empty composer is unchanged
# and a stale one is emptied, which makes every submit independent of the one before it.
clear_composer() {
	k ctrl+u
	pause 0.15
}

submit() {
	clear_composer
	t "$1"
	pause 0.2
	k Return
}

# Submit a slash command. The completion popup owns Return while it is open: it
# takes the highlighted row rather than submitting the line, so a command whose
# name is a prefix of another one gets the wrong one, and a command that matches a
# subcommand row gets accepted into the composer instead of run. The escape dismisses
# the popup and leaves the typed text, which is what the recorded tapes did and for
# this reason.
slash() {
	clear_composer
	t "$1"
	pause 0.7
	k Escape
	pause 0.3
	k Return
}

# What the terminal is showing, as text, or nothing when the socket cannot answer.
screen_text() {
	kitty @ --to "${KITTY_SOCKET}" get-text 2>/dev/null || true
}

# Whether the screen carries a string right now.
screen_has() {
	case "$(screen_text)" in
	*"$1"*) return 0 ;;
	*) return 1 ;;
	esac
}

# Answer every permission dialog the last turn raised, and say how many there were.
#
# WHY A LOOP AND NOT ONE Return. A tool call whose arguments carry a real credential needs
# explicit approval (secret-use-boundary.ts), and a model does not owe the scene one call:
# the signing turn asked for a digest and a file, and this one answered with two bash calls,
# so it raised two dialogs. A single Return approved the first, the second went unanswered,
# and the file the whole recording is about was never written -- three takes in a row, with
# the reason on screen each time. The frame named signature-written was in fact a second
# permission dialog nobody had noticed.
#
# Bounded, and it reports the count, because "no dialog appeared" and "six appeared" are
# different worlds and a scene that cannot tell them apart cannot be trusted about either.
approve_while_asked() {
	local rounds="${1:-6}" approved=0
	while [ "${rounds}" -gt 0 ]; do
		screen_has "Permission required" || break
		k Return
		approved=$((approved + 1))
		settle_idle 200 6 2 20
		rounds=$((rounds - 1))
	done
	echo "scene: approved ${approved} permission dialog(s)" >&2
	if screen_has "Permission required"; then
		echo "scene: a permission dialog is STILL open after ${approved} approvals" >&2
		return 1
	fi
	return 0
}

# Move the real pointer to a pixel. The terminal turns that into the same SGR
# motion report a hand on a mouse produces, which is the only way a hover state
# is real evidence.
#
# A move to the pixel the pointer already occupies is skipped, and that check is
# the difference between a scene that runs and one that does not: `xdotool
# mousemove --sync` waits for a motion event, a move to the current position
# produces none, and it stands there for FIFTEEN SECONDS before giving up. The
# card-bands scene measured 351s against sixty seconds of its own sleeps, all of
# it duplicate moves inside `glide`.
move_px() {
	local x="$1" y="$2" loc cx cy
	loc="$(xdotool getmouselocation --shell)"
	cx="$(printf '%s\n' "${loc}" | sed -n 's/^X=//p')"
	cy="$(printf '%s\n' "${loc}" | sed -n 's/^Y=//p')"
	if [ "${cx}" = "${x}" ] && [ "${cy}" = "${y}" ]; then return 0; fi
	xdotool mousemove --sync "${x}" "${y}"
}

# Move the real pointer to a cell.
point() { move_px "$(px_x "$2")" "$(px_y "$1")"; }

# Glide, so the recording shows the pointer travelling and every row it crosses
# lighting up on the way. Interpolated in PIXELS: stepping in cells rounds every
# intermediate step onto one of the endpoint rows, which is a teleport with
# extra sleeps rather than a travelling pointer.
glide() { # glide <row-from> <col-from> <row-to> <col-to> [steps] [delay]
	local r0="$1" c0="$2" r1="$3" c1="$4" steps="${5:-16}" delay="${6:-0.03}"
	local x0 y0 x1 y1 i
	x0="$(px_x "${c0}")"
	y0="$(px_y "${r0}")"
	x1="$(px_x "${c1}")"
	y1="$(px_y "${r1}")"
	for i in $(seq 0 "${steps}"); do
		move_px "$((x0 + (x1 - x0) * i / steps))" "$((y0 + (y1 - y0) * i / steps))"
		sleep "${delay}"
	done
}
click() { xdotool click 1; }
click_at() { point "$1" "$2"; pause 0.3; click; }
wheel_up() { key_repeat_button 4 "${1:-3}"; }
wheel_down() { key_repeat_button 5 "${1:-3}"; }

# Scroll back until a string is on screen, then stop. Says whether it got there.
#
# WHY A SCENE HAS TO SCROLL FOR A SURFACE. A shot named after a surface is only that shot if
# the surface is in the frame, and a turn does not end where the scene assumes: this model
# verifies its own edit unasked, in the same turn, so by the time the screen settled the diff
# had scrolled off the top and the frame published as the edit diff was an eval block. Asking
# the model not to verify did not stop it -- twice -- so the scene stops depending on where a
# turn happens to end and goes to find the surface instead.
#
# Bounded, and it returns non-zero when the string never appeared, so a scene can shoot
# anyway and a reader of the log knows the frame is not what its name says.
scroll_to() {
	local needle="$1" steps="${2:-14}" moved=0
	while [ "${moved}" -lt "${steps}" ]; do
		if screen_has "${needle}"; then
			echo "scene: '${needle}' on screen after ${moved} scroll step(s)" >&2
			return 0
		fi
		wheel_up 2
		pause 0.4
		moved=$((moved + 1))
	done
	if screen_has "${needle}"; then
		echo "scene: '${needle}' on screen after ${moved} scroll step(s)" >&2
		return 0
	fi
	echo "scene: '${needle}' never came into view after ${moved} scroll step(s)" >&2
	return 1
}
key_repeat_button() {
	local button="$1" count="$2"
	for _ in $(seq 1 "${count}"); do
		xdotool click "${button}"
		sleep 0.12
	done
}

# A still, and the second of the recording it was taken at.
#
# The timestamp is what lets a clip be cut around the moments the scene exists to
# show. Nothing else in the take knows where they are: change magnitude finds the
# largest repaints, which in a session against a reasoning model are pages of
# thinking, so a magnitude cut of a feature scene is streamed text with the feature
# in two frames of it. SCENE_T0 is set in milliseconds when the recorder starts
# capturing, so this is an offset into the video and not a wall clock. The
# arithmetic is shell integer maths because the recorder image carries no `bc`.
shot() {
	import -window root "${SCENE_OUT}/${SCENE_NAME}-$1.png"
	if [ -n "${SCENE_T0:-}" ]; then
		local ms=$(($(date +%s%3N) - SCENE_T0))
		printf '%s\t%d.%d\n' "$1" $((ms / 1000)) $((ms % 1000 / 100)) \
			>>"${SCENE_OUT}/${SCENE_NAME}-marks.tsv"
	fi
}

# Wait out a turn. Every wait in every scene passes through here, so one knob
# retimes a scene for a slower model: SCENE_SETTLE_SCALE multiplies it.
#
# The waits in these scenes were measured against a sparse 30B that generates about
# 90 tokens a second. The dense 32B recording them now generates 48, so it wants
# roughly twice the wait. A wait that is too short does not fail loudly: it records
# the next question typed into a composer that is still streaming the last answer,
# which is worse than no recording because it looks like the product dropped a turn.
# Scaling is done in awk because the recorder image carries no bc and a wait can be
# fractional.
settle() {
	local want="${1:-2}" scale="${SCENE_SETTLE_SCALE:-1}"
	[ "${scale}" = "1" ] || want="$(awk -v w="${want}" -v s="${scale}" 'BEGIN { printf "%.1f", w * s }')"
	sleep "${want}"
}

# Wait until the screen stops changing, up to a ceiling.
#
# WHY: settle() is a fixed sleep, and a fixed sleep is a guess about how long a model
# takes. The take that motivated this waited 160 scaled seconds for an edit turn that ran
# 232, so the frame it published shows a half-streamed answer -- and every later shot in
# that take was taken during the turn after the one it was named for. A turn that finishes
# early wastes the remainder of the guess, which is the same mistake in the other
# direction: twenty minutes of recording where two of them are a still screen.
#
# The signal is the terminal's own text, read out of the pty through kitty's socket rather
# than by looking at pixels: a streaming turn rewrites the transcript continuously, so two
# dumps taken a few seconds apart differ. The elapsed clock in the footer ticks on a
# settled screen too, so digits are dropped before comparing -- what is left is the
# transcript, the composer and the spinner, none of which move once a turn is done.
#
# TWO WAYS TO END, and the difference is the whole correctness of this. A screen that has
# not moved is not the same as a turn that is over: for the first seconds after a submit the
# request is in flight and nothing has streamed yet, so a wait that only asked "has the
# screen stopped changing" returned immediately and the shot caught the screen from before
# the answer. That is what the take before this one recorded: an edit turn "settled" in 18
# seconds and published a frame with no diff in it.
#
# So a quick return requires having SEEN the screen change at least once -- the turn
# started, streamed, and stopped. A turn that finished before the floor never provides that
# evidence, so a longer run of unchanged dumps ends the wait as well. The patient path is
# what bounds a scene against a turn that was already over; the observed-change path is what
# stops a shot landing in front of one that had not begun.
#
# Bounded on purpose. If the model never finishes, this returns at the ceiling and the
# scene carries on, which records a slow turn honestly instead of hanging the take.
settle_idle() {
	local ceiling="${1:-180}" floor="${2:-4}" quiet="${3:-2}" patient="${4:-}"
	local scale="${SCENE_SETTLE_SCALE:-1}"
	[ "${scale}" = "1" ] || ceiling="$(awk -v w="${ceiling}" -v s="${scale}" 'BEGIN { printf "%.0f", w * s }')"
	# How long a silence is allowed to end the wait WITHOUT having seen the turn stream.
	# A shell command answers instantly, so a few polls are plenty; a model can think for
	# a while before its first token, and a scene that shoots into that silence publishes
	# the screen from before the answer. Model turns therefore pass their own number.
	patient="${patient:-$((quiet + 5))}"
	sleep "${floor}"
	local prev="" now="" same=0 changed=0 waited="${floor}"
	while [ "${waited}" -lt "${ceiling}" ]; do
		now="$(kitty @ --to "${KITTY_SOCKET}" get-text 2>"${SCENE_OUT:-/tmp}/get-text.err" | tr -d '0-9' || true)"
		if [ -z "${now}" ]; then
			# A WAIT THAT CANNOT SEE IS THE ONE FAILURE THAT MUST NOT BE QUIET. This
			# branch used to spend the ceiling as a sleep and return without a word, so a
			# run where the socket answered nothing looked exactly like a run where every
			# turn settled -- the gate's own late-turn probe sat here for ninety seconds
			# and the reason was invisible in the log. One retry, because a single dump
			# can lose a race with a redraw, and then the reason in the log.
			sleep 2
			now="$(kitty @ --to "${KITTY_SOCKET}" get-text 2>>"${SCENE_OUT:-/tmp}/get-text.err" | tr -d '0-9' || true)"
			if [ -z "${now}" ]; then
				echo "scene: get-text read nothing from ${KITTY_SOCKET}, falling back to a plain sleep: $(tail -1 "${SCENE_OUT:-/tmp}/get-text.err" 2>/dev/null)" >&2
				sleep "$((ceiling - waited))"
				return 0
			fi
		fi
		if [ "${now}" = "${prev}" ]; then
			same=$((same + 1))
			if [ "${changed}" -eq 1 ] && [ "${same}" -ge "${quiet}" ]; then
				echo "scene: settled after ${waited}s, having seen the turn stream (ceiling ${ceiling}s)" >&2
				return 0
			fi
			if [ "${same}" -ge "${patient}" ]; then
				echo "scene: nothing moved for $((same * 3))s, taking the turn as over (ceiling ${ceiling}s)" >&2
				return 0
			fi
		else
			[ -z "${prev}" ] || changed=1
			same=0
		fi
		prev="${now}"
		sleep 3
		waited=$((waited + 3))
	done
	echo "scene: never settled, carrying on at the ${ceiling}s ceiling" >&2
}
