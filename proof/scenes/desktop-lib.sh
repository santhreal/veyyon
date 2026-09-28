#!/usr/bin/env bash
# The desktop window's scene prelude: how a native scene's window is launched, and
# the helpers a scene drives that window with.
#
#   bash proof/scenes/desktop-lib.sh launch <scene.sh> <veyyon-desktop>   # SCENE_COMMAND
#   source "$(dirname "${BASH_SOURCE[0]}")/desktop-lib.sh"                # a desktop-*.sh scene
#
# LAUNCH runs inside the recorder container before the window exists.
# proof/docker/record-native.sh makes it the session command. It seeds HOME with the
# desktop bench corpus (scripts/desktop-bench/seed.py: three projects of ten threads,
# each project a git repository), starts the bench's scripted model
# (scripts/desktop-bench/fake_llm.py) on loopback, points the profile at it with the
# bench's own provider block, and opens the window in the first project. Both arms of
# a pair therefore list the same threads and receive the same reply word for word.
#
# A scene states what its take needs in header comments the launcher reads:
#
#   # scene-terminal: native           proof/record.sh records the scene with record-native.sh
#   # desktop-llm: <arguments>         extra fake_llm.py arguments (--tokens, --rate-ms, ...)
#   # desktop-config: <yaml line>      one line appended to the profile config.yml
#
# DRIVING. The rebuilt window opens the driver socket named by VEYYON_DESKTOP_DRIVER:
# JSON lines that dispatch an action by name, type text, read the bounds of a named
# target, and wait for the window to go idle or to draw a string. A window built
# before the driver existed opens no socket. Sourcing this file probes the socket
# once; every helper then takes the driver path or the key and pointer position the
# older window answers, and the log states which one the take used. The after arm
# requires the socket, so a rebuilt window whose driver does not answer ends the take
# instead of recording through the fallback.

DESKTOP_REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DESKTOP_BENCH="${DESKTOP_REPO}/scripts/desktop-bench"
DESKTOP_DRIVER_SOCKET="${TMPDIR:?desktop-lib needs the session scratch in TMPDIR}/desktop-driver.sock"
DESKTOP_LLM_LOG="${TMPDIR}/fake-llm.jsonl"

# ─── Launch (container side, before the window) ─────────────────────────────

desktop_launch() { # <scene.sh> <binary>
	local scene="${1:?usage: desktop-lib.sh launch <scene.sh> <binary>}" binary="${2:?missing binary}"
	local line words llm_args=() config_lines=() port="" project="" profile=""
	[ -f "${scene}" ] || {
		echo "desktop-lib: no scene at ${scene}" >&2
		exit 2
	}
	[ -x "${binary}" ] || {
		echo "desktop-lib: ${binary} is not an executable" >&2
		exit 2
	}
	while IFS= read -r line; do
		case "${line}" in
		"# desktop-llm: "*)
			read -r -a words <<<"${line#"# desktop-llm: "}"
			llm_args+=("${words[@]}")
			;;
		"# desktop-config: "*) config_lines+=("${line#"# desktop-config: "}") ;;
		esac
	done <"${scene}"

	rm -f "${TMPDIR}/fake-llm.port"
	python3 "${DESKTOP_BENCH}/fake_llm.py" --host 127.0.0.1 --port 0 \
		--port-file "${TMPDIR}/fake-llm.port" --log "${DESKTOP_LLM_LOG}" "${llm_args[@]}" \
		>"${TMPDIR}/fake-llm.err" 2>&1 &
	for _ in $(seq 1 100); do
		[ -s "${TMPDIR}/fake-llm.port" ] && break
		sleep 0.1
	done
	port="$(cat "${TMPDIR}/fake-llm.port" 2>/dev/null || true)"
	if [ -z "${port}" ]; then
		echo "desktop-lib: the scripted model wrote no port in 10s" >&2
		cat "${TMPDIR}/fake-llm.err" >&2 2>/dev/null || true
		exit 2
	fi

	# The recorder's home seed carries the terminal scenes' own sessions under
	# ~/.veyyon; the window would list them as a fourth project.
	rm -rf "${HOME:?}/.veyyon/profiles/default/agent/sessions"
	read -r project profile < <(
		python3 - "${DESKTOP_BENCH}" "${HOME}" "${port}" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import apps
import corpus
import seed

home, port = Path(sys.argv[2]), int(sys.argv[3])
seed.seed_veyyon(home)
root = home / ".veyyon"
agent = root / "profiles" / seed.PROFILE / "agent"
agent.mkdir(parents=True, exist_ok=True)
(root / "config.yml").write_text(apps.VEYYON_CONFIG.format(model=seed.MODEL_ID), encoding="utf-8")
(agent / "models.yml").write_text(apps.VEYYON_MODELS.format(port=port, model=seed.MODEL_ID), encoding="utf-8")
print(seed.project_dir(home, corpus.PROJECTS[0]), seed.PROFILE)
PY
	)
	[ -n "${project}" ] && [ -d "${project}" ] || {
		echo "desktop-lib: seeding the corpus produced no project directory" >&2
		exit 2
	}
	if [ "${#config_lines[@]}" -gt 0 ]; then
		printf '%s\n' "${config_lines[@]}" >>"${HOME}/.veyyon/profiles/${profile}/agent/config.yml"
	fi

	cd "${project}"
	export VEYYON_PROFILE="${profile}" BENCH_LLM_KEY=bench TZ=UTC
	export VEYYON_DESKTOP_DRIVER="${DESKTOP_DRIVER_SOCKET}"
	exec "${binary}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	set -euo pipefail
	case "${1:-}" in
	launch)
		shift
		desktop_launch "$@"
		;;
	*)
		echo "usage: desktop-lib.sh launch <scene.sh> <binary>" >&2
		exit 2
		;;
	esac
fi

# ─── Driver client ──────────────────────────────────────────────────────────

# One request, one reply. Prints the bounds of a `bounds` reply as integer window
# pixels `x y w h`; exits 1 on an error reply, 2 when no reply arrived in time, 3
# when the socket does not accept.
#
#   _desk_driver <timeout-s> dispatch <action> [<args-json>]
#   _desk_driver <timeout-s> type <text>
#   _desk_driver <timeout-s> bounds <target>
#   _desk_driver <timeout-s> idle
#   _desk_driver <timeout-s> text <target> <needle>
_desk_driver() {
	python3 - "${DESKTOP_DRIVER_SOCKET}" "$@" <<'PY'
import json
import socket
import sys

path, timeout, kind, *rest = sys.argv[1:]
if kind == "dispatch":
    request = {"dispatch": rest[0]}
    if len(rest) > 1 and rest[1]:
        request["args"] = json.loads(rest[1])
elif kind == "type":
    request = {"type": rest[0]}
elif kind == "bounds":
    request = {"bounds": rest[0]}
elif kind == "idle":
    request = {"wait": "idle"}
elif kind == "text":
    request = {"wait": "text", "target": rest[0], "contains": rest[1]}
else:
    sys.exit(f"driver: unknown request kind {kind}")
request["id"] = 1
line = json.dumps(request)
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(float(timeout))
try:
    client.connect(path)
except OSError as error:
    print(f"driver: {path}: {error}", file=sys.stderr)
    sys.exit(3)
client.sendall(line.encode() + b"\n")
pending = b""
try:
    while True:
        chunk = client.recv(65536)
        if not chunk:
            print(f"driver: the socket closed before answering {line}", file=sys.stderr)
            sys.exit(2)
        pending += chunk
        while b"\n" in pending:
            raw, pending = pending.split(b"\n", 1)
            reply = json.loads(raw)
            if reply.get("id") != 1:
                continue
            if "error" in reply:
                print(f"driver: {line} -> {reply['error']}", file=sys.stderr)
                sys.exit(1)
            bounds = reply.get("bounds")
            if bounds is not None:
                print(*(round(bounds[key]) for key in ("x", "y", "w", "h")))
            sys.exit(0)
except socket.timeout:
    print(f"driver: no reply in {timeout}s to {line}", file=sys.stderr)
    sys.exit(2)
PY
}

drv_dispatch() { _desk_driver 30 dispatch "$@"; }            # <action> [<args-json>]
drv_type() { _desk_driver 30 type "$1"; }                    # <text>
drv_bounds() { _desk_driver 10 bounds "$1"; }                # <target> -> x y w h
drv_wait_idle() { _desk_driver "${1:-30}" idle; }            # [<timeout-s>]
drv_wait_text() { _desk_driver "${3:-60}" text "$1" "$2"; }  # <target> <needle> [<timeout-s>]

# ─── Which path this take drives ────────────────────────────────────────────
rm -f "${SCENE_OUT}/${SCENE_NAME}-clips.tsv"

DESKTOP_DRIVEN=0
for _ in $(seq 1 40); do
	if [ -S "${DESKTOP_DRIVER_SOCKET}" ] && _desk_driver 10 idle >/dev/null 2>&1; then
		DESKTOP_DRIVEN=1
		break
	fi
	sleep 0.25
done
if [ "${DESKTOP_DRIVEN}" = 1 ]; then
	echo "scene ${SCENE_NAME}: driving the window through the driver socket"
elif [ "${SCENE_ARM:-after}" = "after" ]; then
	abandon_take "driver" "the after arm's window answered nothing on ${DESKTOP_DRIVER_SOCKET} in 10s"
else
	echo "scene ${SCENE_NAME}: no driver socket answered; driving the window with keys and pointer positions"
fi

desk_driven() { [ "${DESKTOP_DRIVEN}" = 1 ]; }

# ─── Input ──────────────────────────────────────────────────────────────────

# The input stamp lib.sh's `k` keeps, so a mark's lead starts at the last input.
_desk_stamp() {
	[ -n "${SCENE_T0:-}" ] && SCENE_LAST_INPUT_MS=$(($(date +%s%3N) - SCENE_T0))
	return 0
}

# A key chord through XTEST to the focused window. No `--window`: xdotool sends a
# synthetic event to a named window, and the X server marks it as one.
desk_key() { # <xdotool-chord>...
	xdotool key --clearmodifiers "$@" || abandon_take "key" "xdotool could not press $*"
	_desk_stamp
}

# The action this arm takes for one step: the rebuilt window's action by name, or
# the chord the older window binds to the same command. `-` states that the older
# window binds no chord for it; the step is skipped there and the log says so.
desk_action() { # <action> <before-chord|-> [<args-json>]
	if desk_driven; then
		drv_dispatch "$1" "${3:-}" || abandon_take "$1" "the window refused action $1"
		_desk_stamp
	elif [ "$2" = "-" ]; then
		echo "scene ${SCENE_NAME}: the older window binds no chord for $1; step skipped" >&2
	else
		desk_key "$2"
	fi
}

# Text into the focused input: the driver's key path, or XTEST typing. XTEST
# autorepeat is off in the session (xsession.sh), so a slow repaint cannot double a
# character.
desk_type() { # <text>
	if desk_driven; then
		drv_type "$1" || abandon_take "type" "the window refused typed text"
	else
		xdotool type --delay 30 -- "$1" || abandon_take "type" "xdotool could not type"
	fi
	_desk_stamp
}

# The centre of a driver target on the root window, or the fallback pixel.
_desk_centre() { # <target> <before-x> <before-y>
	local x y w h
	if desk_driven; then
		read -r x y w h <<<"$(drv_bounds "$1")" || true
		[ -n "${h:-}" ] || abandon_take "$1" "no target $1 is laid out"
		echo "$((WIN_X + x + w / 2)) $((WIN_Y + y + h / 2))"
	else
		echo "$((WIN_X + $2)) $((WIN_Y + $3))"
	fi
}

# Move the real pointer onto a target and click it, so the frame shows the
# pointer where the click landed.
desk_click() { # <target> <before-x> <before-y>
	local px py
	read -r px py <<<"$(_desk_centre "$@")"
	move_px "${px}" "${py}"
	pause 0.25
	click
	_desk_stamp
}

# Park the pointer on the window's top edge, where neither window draws a hover
# state, so a frame is not judged on what the pointer last touched.
desk_park() {
	move_px "$((WIN_X + WIN_W / 2))" "$((WIN_Y + 3))"
}

# ─── Waits ──────────────────────────────────────────────────────────────────

# Until the window stops changing: under 200 differing pixels (a caret blink) for
# `still` consecutive half-second probes, bounded by the ceiling. The older window
# has no idle signal, so pixels are the only one.
desk_settle() { # [<ceiling-s>] [<still-probes>]
	local ceiling="${1:-20}" still="${2:-3}" quiet=0 half=0
	local crop="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}" previous="${TMPDIR}/settle-a.png" now="${TMPDIR}/settle-b.png"
	probe_frame "${previous}"
	while [ "${half}" -lt $((ceiling * 2)) ]; do
		sleep 0.5
		half=$((half + 1))
		probe_frame "${now}"
		if [ "$(frames_differ_pixels_at "${previous}" "${now}" "${crop}")" -lt 200 ]; then
			quiet=$((quiet + 1))
			[ "${quiet}" -ge "${still}" ] && return 0
		else
			quiet=0
		fi
		mv -f "${now}" "${previous}"
	done
	echo "scene ${SCENE_NAME}: the window still moved at the ${ceiling}s ceiling" >&2
}

# Until the window has nothing left to draw.
desk_idle() { # [<ceiling-s>]
	if desk_driven; then
		drv_wait_idle "${1:-30}" || abandon_take "idle" "the window did not go idle in ${1:-30}s"
	else
		desk_settle "${1:-30}"
	fi
}

# Until a target draws a string. The older window has no text probe, so that arm
# waits for the pixels to hold still instead.
desk_expect() { # <target> <needle> <ceiling-s>
	if desk_driven; then
		drv_wait_text "$1" "$2" "$3" ||
			abandon_take "$1" "target $1 did not draw '$2' in $3s"
		drv_wait_idle 30 || true
	else
		desk_settle "$3"
	fi
}

# Until a driver target is laid out; the older window waits for pixels to settle.
desk_expect_target() { # <target> <ceiling-s>
	local waited=0
	if desk_driven; then
		until drv_bounds "$1" >/dev/null 2>&1; do
			[ "${waited}" -ge $(($2 * 2)) ] && abandon_take "$1" "no target $1 was laid out in $2s"
			sleep 0.5
			waited=$((waited + 1))
		done
		drv_wait_idle 30 || true
	else
		desk_settle "$2"
	fi
}

# The window after launch: the host attached and the sidebar lists the seeded
# threads, every one of which is titled `<project> NN <words>`.
desk_ready() {
	desk_expect sidebar " 09 " 90
	desk_park
	desk_idle 30
}

# ─── Threads and turns ──────────────────────────────────────────────────────

# The older window opens on "Create a session to begin"; Ctrl+N (NewSession)
# starts a session in the launch directory and draws its composer in the body,
# where a click focuses it. The rebuilt window starts a thread in the launch
# project with NewThread. Either way the composer ends up focused and empty.
DESKTOP_BEFORE_COMPOSER=(718 407)
desk_new_thread() {
	if desk_driven; then
		drv_dispatch workspace::NewThread || abandon_take "new-thread" "the window refused NewThread"
		desk_expect_target composer 20
		drv_dispatch workspace::FocusComposer || abandon_take "new-thread" "the window refused FocusComposer"
		_desk_stamp
	else
		desk_key ctrl+n
		desk_settle 10
		desk_click composer "${DESKTOP_BEFORE_COMPOSER[@]}"
	fi
	desk_park
}

# The draft, as a person types it: a line at a time, Shift+Return between lines.
# The rebuilt window takes each prefix through InsertText, which replaces the
# draft, so both arms grow the draft by the same lines at the same pace.
desk_draft() { # <text> [<seconds-per-line>]
	local text="$1" pace="${2:-0.6}" line typed="" first=1
	while IFS= read -r line; do
		if desk_driven; then
			typed="${typed:+${typed}$'\n'}${line}"
			drv_dispatch composer::InsertText "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "${typed}")" ||
				abandon_take "draft" "the window refused InsertText"
			_desk_stamp
		else
			[ "${first}" = 1 ] || desk_key shift+Return
			xdotool type --delay 30 -- "${line}" || abandon_take "draft" "xdotool could not type"
			_desk_stamp
		fi
		first=0
		pause "${pace}"
	done <<<"${text}"
}

desk_submit() {
	desk_action composer::Submit Return
}

# One turn in a new thread: the prompt typed, submitted, and the scripted model's
# reply finished. `replies` is how many finished replies the log holds after it.
desk_turn() { # <prompt> <replies> [<ceiling-s>]
	desk_new_thread
	desk_draft "$1" 0.3
	desk_submit
	desk_model_wait reply "$2" "${3:-60}"
	desk_idle 30
}

# The right panel on one tab. The after arm names the tab; the before arm opens
# the panel with Ctrl+\ (TogglePanel), which shows its Diff tab, and clicks the
# tab strip at the given window pixel when another tab is wanted.
desk_panel_tab() { # <tab> [<before-x> <before-y>]
	if desk_driven; then
		drv_dispatch workspace::ShowPanelTab "{\"tab\":\"$1\"}" ||
			abandon_take "panel-$1" "the window refused ShowPanelTab $1"
		_desk_stamp
		desk_expect_target "panel.tab:$1" 15
	else
		desk_key ctrl+backslash
		desk_settle 10
		if [ "$#" -ge 3 ]; then
			desk_click "panel.tab:$1" "$2" "$3"
		fi
	fi
	desk_park
	desk_idle 20
}

# Ends the window's GUI host process. The window's own process is untouched.
desk_kill_host() {
	pkill -f -- '/coding-agent/src/cli.ts' || abandon_take "host" "no GUI host process was running"
	_desk_stamp
}

# ─── The scripted model ─────────────────────────────────────────────────────

# How far the scripted model got, read from its own log: `reply` counts finished
# replies to turns, `tool` counts tool calls it sent, `token` counts streamed words.
desk_model_count() { # <reply|tool|token>
	python3 - "${DESKTOP_LLM_LOG}" "$1" <<'PY'
import json
import sys

path, kind = sys.argv[1], sys.argv[2]
turns, count = set(), 0
try:
    with open(path, encoding="utf-8") as log:
        for raw in log:
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            name = event.get("event")
            if name == "request" and event.get("turn"):
                turns.add(event.get("req"))
            elif kind == "reply" and name == "done" and event.get("req") in turns:
                count += 1
            elif kind == "tool" and name == "tool_call":
                count += 1
            elif kind == "token" and name == "token":
                count += 1
except FileNotFoundError:
    pass
print(count)
PY
}

# Until the scripted model reached a count; ends the take at the ceiling.
desk_model_wait() { # <reply|tool|token> <count> <ceiling-s>
	local half=0
	until [ "$(desk_model_count "$1")" -ge "$2" ]; do
		[ "${half}" -ge $(($3 * 2)) ] &&
			abandon_take "model-$1" "the scripted model did not reach $2 $1 event(s) in $3s"
		sleep 0.5
		half=$((half + 1))
	done
}

# ─── Seeded state ───────────────────────────────────────────────────────────

# The session id seed.py gave a corpus thread, which is the rebuilt sidebar row's
# driver target suffix.
desk_session_id() { # <thread-key>
	python3 - "${DESKTOP_BENCH}" "$1" <<'PY'
import sys

sys.path.insert(0, sys.argv[1])
import seed

print(seed.stable_uuid("veyyon-session", sys.argv[2]))
PY
}

# Working-tree changes in the first project, so the diff has something to show.
desk_dirty_tree() {
	local project="${HOME}/projects/alpha"
	cat >>"${project}/README.md" <<'EOF'

## Queue

The queue reducer folds every host event into one snapshot revision.
A revision older than the one on screen is dropped.
EOF
	mkdir -p "${project}/src"
	cat >"${project}/src/queue.rs" <<'EOF'
pub fn revision(current: u64, incoming: u64) -> u64 {
	current.max(incoming)
}
EOF
	git -C "${project}" add src/queue.rs
}

# ─── Clips ──────────────────────────────────────────────────────────────────

# A span of the take that record-native.sh publishes as its own animated WebP at
# the capture rate, `<scene>-<name>.webp`, and gates with proof/webp-cadence.py.
desk_clip_begin() { # <name>
	DESKTOP_CLIP_NAME="$1"
	DESKTOP_CLIP_START_MS=$(($(date +%s%3N) - SCENE_T0))
}

desk_clip_end() {
	local end_ms=$(($(date +%s%3N) - SCENE_T0))
	printf '%s\t%d.%03d\t%d.%03d\n' "${DESKTOP_CLIP_NAME:?desk_clip_end without desk_clip_begin}" \
		$((DESKTOP_CLIP_START_MS / 1000)) $((DESKTOP_CLIP_START_MS % 1000)) \
		$((end_ms / 1000)) $((end_ms % 1000)) >>"${SCENE_OUT}/${SCENE_NAME}-clips.tsv"
	unset DESKTOP_CLIP_NAME DESKTOP_CLIP_START_MS
}
