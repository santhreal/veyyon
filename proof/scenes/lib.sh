#!/usr/bin/env bash
# Helpers a scene uses to drive the terminal: keys, text, a real pointer, and
# stills cut out of the same display the recorder is capturing.
#
# Sourced by proof/docker/xsession.sh (X11) or proof/docker/wlsession.sh
# (Wayland) with SCENE_NAME and SCENE_OUT already exported.
#
# Keys, the pointer and the capture go through six primitives a backend file
# provides, because the two display servers answer them differently and nothing
# above this line should know which one is running. Everything else here --
# typing, the composer, the waits, screen reads -- is already server-independent:
# it goes through kitty's socket into the pty.
SCENE_SERVER="${SCENE_SERVER:-x11}"
# shellcheck disable=SC1090
source "$(dirname "${BASH_SOURCE[0]}")/backend-${SCENE_SERVER}.sh"

# The grid comes from the shell (`stty size`), and the pixel size of a cell from
# the window divided by that grid. Asking the terminal directly (CSI 16t) only
# works where window operations are enabled, which xterm disables by default.
read -r TERM_ROWS TERM_COLS <<<"$(sed -n 's/^stty=//p' /tmp/geom)"
PAD="${SCENE_PADDING:-8}"
: "${TERM_ROWS:=40}" "${TERM_COLS:=150}"
read -r WIN_W WIN_H <<<"$(_be_window_px)"
: "${WIN_W:=1600}" "${WIN_H:=1000}"
# A themed capture insets the window so the backdrop and the compositor's shadow
# are visible, so the window's own origin is no longer the screen's. Every
# pointer target is a pixel on the whole screen, which is what the pointer
# primitive moves and what the recorder captures, so the origin has to be added
# back. It is 0,0 for a plain full-screen capture, which leaves those scenes
# aiming at exactly the pixels they did before.
read -r WIN_X WIN_Y <<<"$(_be_window_origin)"
: "${WIN_X:=0}" "${WIN_Y:=0}"
CELL_W=$(((WIN_W - 2 * PAD) / TERM_COLS))
CELL_H=$(((WIN_H - 2 * PAD) / TERM_ROWS))
: "${CELL_W:=9}" "${CELL_H:=18}"
echo "scene ${SCENE_NAME}: ${TERM_COLS}x${TERM_ROWS} cells of ${CELL_W}x${CELL_H}px at +${WIN_X}+${WIN_Y}"

# A SCENE THAT DIES SAYS WHERE. The session script runs under `set -e`, and the
# scene is sourced into it, so any command that fails outside a condition ends the
# take on the spot. Bash prints nothing for that, and a take costs minutes: the
# first run of pointer-probe.sh died on an assignment whose `grep` matched nothing,
# between two frames that were never written, and looked exactly like a backend
# that could not click. The trap turns that into one line naming the file, the
# line and the status. It reports only what `set -e` was already going to kill --
# a failure inside `if`, `while`, `&&` or `||` is exempt from ERR the same way it
# is exempt from `set -e` -- so a helper that returns 1 as an answer stays silent.
trap 'rc=$?; echo "scene ${SCENE_NAME}: ABORTED at ${BASH_SOURCE[0]}:${LINENO} rc=${rc}" >&2' ERR

# Row and column are 1-based, the way the terminal counts them.
px_x() { echo $((WIN_X + (${1} - 1) * CELL_W + CELL_W / 2 + PAD)); }
px_y() { echo $((WIN_Y + (${1} - 1) * CELL_H + CELL_H / 2 + PAD)); }

pause() { sleep "${1:-0.5}"; }

# A key press goes through the backend, which on X11 aims at the window the
# session found and on Wayland writes the bytes the terminal sends for that key
# into the pty. Both report a failure and carry on rather than aborting: a scene
# that loses one key is worth more than no recording, and under `set -e` a stale
# X11 window id once took the recorder down at the first keystroke, leaving a
# video that stopped there with no gif and no stats.
k() {
	_be_key "$@"
	# WHERE A CLIP MAY REACH BACK TO. A cut that shows the work has to start
	# before the surface it is cutting to, and the one thing it must never reach
	# is the request being entered: a four-second lead-in once opened every row on
	# characters appearing one at a time. Every path that enters text ends here --
	# `submit` and `slash` both finish on `k Return`, and `key_repeat` and the
	# wheel are `k` in a loop -- so stamping it here is stamping the end of input,
	# whatever spelling reached it. `glide` deliberately does not pass through:
	# a travelling pointer is a thing a frame exists to show, not input to hide.
	[ -n "${SCENE_T0:-}" ] && SCENE_LAST_INPUT_MS=$(($(date +%s%3N) - SCENE_T0))
	return 0
}
key_repeat() { # key_repeat <key> <count> [delay]
	local key="$1" count="$2" delay="${3:-0.12}"
	for _ in $(seq 1 "${count}"); do
		_be_key "${key}"
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

# XTEST fallback used when kitty remote control does not answer. Named so a
# missing binary fails as `_xdo: command not found` only if this function is
# deleted, not because the fallback was never bound.
_xdo() { xdotool "$@"; }

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
	local x="$1" y="$2" cx cy
	read -r cx cy <<<"$(_be_pointer_at)"
	if [ "${cx}" = "${x}" ] && [ "${cy}" = "${y}" ]; then return 0; fi
	_be_pointer_move "${x}" "${y}"
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
click() { _be_click 1; }
click_at() { point "$1" "$2"; pause 0.3; click; }
wheel_up() { key_repeat_button 4 "${1:-3}"; }
wheel_down() { key_repeat_button 5 "${1:-3}"; }

# Wait for a string to APPEAR while the turn is still running, and return as soon as it does.
#
# WHY THIS EXISTS AND WHY IT IS NOT `scroll_to`. Some surfaces are only on screen while the
# work is happening: the subagent lane list is live state, and the tool block of a search is
# followed by whatever the model writes about it. `scroll_to` was the answer to that and it
# is the wrong one against a model that reports at length -- one fan-out turn ended with a
# verification table, a smoke-test summary and two flagged risks, which put the lane list
# several hundred lines above the bottom. Ninety scroll steps did not reach it, and worse,
# the failed search left the viewport parked mid-history, so the next two needles were
# looking at a screen the session had stopped writing to. One missed needle became three.
#
# So a live surface is waited for, not scrolled back to, and the frame is taken while it is
# genuinely on screen. Bounded like everything else here: returns non-zero when the string
# never arrived, and the scene decides what that means.
wait_for_screen() {
	local needle="$1" ceiling="${2:-300}" waited=0 scale="${SCENE_SETTLE_SCALE:-1}"
	[ "${scale}" = "1" ] || ceiling="$(awk -v w="${ceiling}" -v s="${scale}" 'BEGIN { printf "%.0f", w * s }')"
	while [ "${waited}" -lt "${ceiling}" ]; do
		if screen_has "${needle}"; then
			echo "scene: '${needle}' appeared after ${waited}s" >&2
			return 0
		fi
		sleep 2
		waited=$((waited + 2))
	done
	echo "scene: '${needle}' never appeared in ${ceiling}s" >&2
	return 1
}

# Abandon the take now, naming the guard that did not arrive.
#
# A scene used to record a miss in MISSED and walk on to the next guard. A take with five
# model-dependent guards left after the first miss then spent every remaining ceiling in
# series before anything reported: one run waited out 1200s on a subagent name and 1800s
# on an edit block, ran past an hour, and published two byte-identical frames under two
# names. Abandoning at the first miss costs one ceiling, and the reason file is what the
# host reads to decide whether the scene or the model is at fault.
abandon_take() {
	local guard="$1" reason="$2"
	echo "scene: abandoning the take -- ${guard}: ${reason}" >&2
	if [ -n "${SCENE_OUT:-}" ]; then
		printf '%s\t%s\n' "${guard}" "${reason}" >>"${SCENE_OUT}/abandoned.tsv"
	fi
	exit 2
}

# A guard on output the PRODUCT prints for what the scene already did: chrome, a command
# echo, a slash-command result, a line the scene typed. It cannot depend on a model
# choice, so a miss is a defect in the scene or the build and the take ends here.
expect_screen() {
	local needle="$1" ceiling="${2:-120}"
	wait_for_screen "${needle}" "${ceiling}" ||
		abandon_take "${3:-${needle}}" "deterministic guard '${needle}' never printed in ${ceiling}s"
}

# A guard on output only a MODEL choice produces: a name it picked, a tool it decided to
# call, a sentinel the prompt asked it to print. The ceiling is the whole budget for that
# choice, and running it out ends the take instead of leaving every later guard to spend
# its own. Every such guard is declared here, which is what `scripts/verify-scene.ts`
# reads: a bare `wait_for_screen` in a scene is neither kind and fails verification.
expect_model_screen() {
	local needle="$1" ceiling="${2:-300}"
	wait_for_screen "${needle}" "${ceiling}" ||
		abandon_take "${3:-${needle}}" "model-dependent guard '${needle}' never printed in ${ceiling}s"
}

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
		_be_click "${button}"
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
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	# A CAPTURE THAT FAILED USED TO LOOK LIKE ONE THAT WORKED. `import` writes nothing when the
	# window it is pointed at has gone, and its exit code was dropped here, so the scene carried
	# on and wrote a mark for a frame that does not exist. Downstream that is worse than a
	# missing file: the publish step copies what it finds, so the name keeps whatever an earlier
	# take left under it. The mark is the record of a frame that landed, so it is only written
	# when one did, and a failure says so in the log rather than in the gallery.
	if ! _be_capture "${png}" 2>&1 || [ ! -s "${png}" ]; then
		abandon_take "$1" "shot '$1' captured nothing (the capture failed or wrote an empty file)"
	fi
	if [ -n "${SCENE_LAST_SHOT_PNG:-}" ] && [ -f "${SCENE_LAST_SHOT_PNG}" ]; then
		if cmp -s "${png}" "${SCENE_LAST_SHOT_PNG}"; then
			abandon_take "$1" "shot '$1' is byte-identical to previous shot '$(basename "${SCENE_LAST_SHOT_PNG}" .png)'"
		fi
	fi
	SCENE_LAST_SHOT_PNG="${png}"
	if [ -n "${SCENE_T0:-}" ]; then
		local ms=$(($(date +%s%3N) - SCENE_T0))
		# THE THIRD COLUMN IS HOW MUCH WORK THIS FRAME MAY SHOW. The clip used to
		# keep a flat 1.2s before every mark, which cut out the work that produced
		# the result. The measured lead starts at the most recent input or shot,
		# whichever is later. Using the previous shot matters for a single
		# autonomous goal turn: every milestone belongs to the work since the last
		# milestone, rather than each one reaching back over the entire task and
		# merging the cut into one enormous span.
		#
		# Floored at MARK_LEAD_MIN so a shot taken right after a keystroke still
		# gets a readable run-in. Before the first input there is no work, only an
		# idle session, so an unstamped anchor means the floor and nothing more.
		local lead_ms="${SCENE_MARK_LEAD_MIN_MS:-1200}"
		local anchor_ms="${SCENE_LAST_INPUT_MS:-}"
		if [ -n "${SCENE_LAST_MARK_MS:-}" ] && { [ -z "${anchor_ms}" ] || [ "${SCENE_LAST_MARK_MS}" -gt "${anchor_ms}" ]; }; then
			anchor_ms="${SCENE_LAST_MARK_MS}"
		fi
		if [ -n "${anchor_ms}" ]; then
			lead_ms=$((ms - anchor_ms))
			[ "${lead_ms}" -lt "${SCENE_MARK_LEAD_MIN_MS:-1200}" ] && lead_ms="${SCENE_MARK_LEAD_MIN_MS:-1200}"
		fi
		printf '%s\t%d.%d\t%d.%d\n' "$1" $((ms / 1000)) $((ms % 1000 / 100)) \
			$((lead_ms / 1000)) $((lead_ms % 1000 / 100)) \
			>>"${SCENE_OUT}/${SCENE_NAME}-marks.tsv"
		SCENE_LAST_MARK_MS="${ms}"
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
