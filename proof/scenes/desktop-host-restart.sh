#!/usr/bin/env bash
# Kill the GUI host under the native window, restart it, and read whether the
# window found it again -- ten times over.
#
# Records visual evidence for:
#   1. attached           (the window with its host up, before the first kill)
#   2. host-killed        (the same window in the moment the host is gone)
#   3. restarts-survived  (the window after the last restart)
#
# THE PAIR IS TWO BUILDS, not two settings. The window's reconnection ceiling is
# ten attempts inside two minutes (§8.13), and until the fix the count was never
# cleared: a disconnection that recovered still spent an attempt, so the tenth
# one across the window's whole life was refused on its first try with
# `Connection failed after 10 retry attempts (120s elapsed)`. Both arms run this
# same scene; the executable is the differential.
#
#   cargo build -p veyyon-desktop
#   SCENE_MOTION_FLOOR=4 \
#     proof/docker/record-native.sh proof/scenes/desktop-host-restart.sh
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback 9f3762c42d host-restart
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY="${PWD}/.internal/captures/host-restart/veyyon-desktop" \
#     proof/docker/record-native.sh proof/scenes/desktop-host-restart.sh
#
# Both arms carry a lowered motion floor and both arms mean it. A window
# waiting on a scheduled retry repaints one countdown line a second and nothing
# else, and the recorder's default floor reads a take that spends half its
# length waiting as a stuttering capture.
#
# WHAT IS MEASURED. A window that lost its host draws a banner under the
# titlebar and pushes everything below it down (§8.12), so the strip that sits
# there is the whole reading: it holds the rail's header and the top of the
# transcript while the window is attached, and a banner the moment it is not.
# The scene photographs that strip attached, counts it changing when the host is
# killed, and counts it returning when the host is back. A cycle that never
# changed is a kill that missed; a cycle that never returned is a window that
# gave up.
#
# The two arms end in different places, which is the point. The after arm
# requires all ten restarts to be recovered from and ends on a window with no
# banner. The before arm stops at the first restart the window refused, restarts
# the host once more, and requires the banner to still be there after a wait
# longer than any backoff the policy schedules -- a refusal is permanent, where
# a slow reconnection is not. An arm that reaches the end of the loop with every
# cycle recovered has not reproduced the defect and is abandoned rather than
# published as a before frame of the same state as the after one.
#
# NOT RECORDED HERE: which event clears the count, and that a host in a crash
# loop still reaches the refusal, which
# `crates/veyyon-desktop/tests/a-connection-that-came-back-starts-the-next-retry-from-the-first-attempt.rs`
# drives through the real transport over a real socket; and the schedule's own
# bounds, which `reconnect_backoff_schedule_bounds_and_terminates.rs` pins.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"

# ─── The Host This Scene Restarts ────────────────────────────────────────────
# The window spawns its host once, as `<veyyon> gui` in its own process group,
# and nothing spawns it again: the transport reconnects to the socket, it does
# not resurrect what was listening on it. So the scene owns the restarts, and it
# starts the host the same way the window did -- same executable, same working
# directory, same profile -- rather than something that merely opens the socket.
HOST_BIN="${VEYYON_BIN:-/repo/packages/coding-agent/src/cli.ts}"
if [ ! -x "${HOST_BIN}" ]; then
	abandon_take "the-host-is-startable" "no executable GUI host at ${HOST_BIN}, so a killed host cannot be restarted"
fi
HOST_LOG="${TMPDIR}/host-restart.log"

# Killing the host is the one destructive thing this scene does, and the first
# take of it killed the X server: a process matched by command line alone, and
# its group turned out to be the recording session's own -- the display server,
# the encoder and the window all went with it, and every frame after that was an
# empty root. So a candidate is matched by command line AND by group. The window
# spawns its host into a group of its own, and everything the recorder started
# shares one group with this scene, so a match inside this scene's group is a
# mis-match by definition and is skipped rather than signalled. The table is
# printed either way: a take that killed nothing says which processes it looked
# at.
host_table() { # <label>
	python3 - "$1" <<'PY'
import os
import sys

label = sys.argv[1]
own = os.getpgid(0)
for entry in sorted(os.listdir("/proc"), key=lambda name: int(name) if name.isdigit() else 0):
	if not entry.isdigit():
		continue
	pid = int(entry)
	try:
		with open(f"/proc/{entry}/cmdline", "rb") as handle:
			argv = handle.read().decode("utf-8", "replace").split("\0")
	except OSError:
		continue
	if not any("cli.ts" in arg for arg in argv):
		continue
	if any(arg.startswith("__omp_worker") for arg in argv):
		continue
	if "gui" not in argv:
		continue
	try:
		group = os.getpgid(pid)
	except (ProcessLookupError, PermissionError):
		continue
	verdict = "recorder" if group == own or pid in (1, os.getpid()) else "host"
	print(f"{label}: pid={pid} pgid={group} scene-pgid={own} {verdict}: {' '.join(a for a in argv if a)}", file=sys.stderr)
	if verdict == "host":
		print(pid)
PY
}

# A crash, not a shutdown: the host is killed by signal, with the process group
# it was spawned into, which is what a window has to survive.
kill_host() {
	local pid killed=0
	for pid in $(host_table kill); do
		python3 - "${pid}" <<'PY'
import os
import signal
import sys

pid = int(sys.argv[1])
try:
	os.killpg(os.getpgid(pid), signal.SIGKILL)
except (ProcessLookupError, PermissionError):
	try:
		os.kill(pid, signal.SIGKILL)
	except ProcessLookupError:
		pass
PY
		killed=$(( killed + 1 ))
	done
	echo "${killed}"
}

# The replacement host is started into a session of its own, as the window
# starts it: a host left in this scene's process group is one the next cycle
# refuses to kill, since a process in that group is the recorder rather than the
# host.
start_host() {
	python3 - "${HOST_BIN}" "${SCENE_CWD}" "${HOST_LOG}" <<'PY'
import subprocess
import sys

binary, cwd, log = sys.argv[1], sys.argv[2], sys.argv[3]
with open(log, "ab") as sink:
	subprocess.Popen(
		[binary, "gui"],
		cwd=cwd,
		stdin=subprocess.DEVNULL,
		stdout=sink,
		stderr=sink,
		start_new_session=True,
	)
PY
}

# ─── Where A Lost Host Shows ─────────────────────────────────────────────────
# The banner is a full-width child under the titlebar, so the strip is the
# window's width and the titlebar's height starting at the titlebar's foot. Both
# numbers come from the tokens the preamble read, so a retitled bar moves the
# reading with the surface.
STRIP_CROP="${WIN_W}x${TITLEBAR_H}+${WIN_X}+$(( WIN_Y + TITLEBAR_H ))"

# What a banner does to that strip, and what an attached window is allowed to
# differ from its own baseline by. A banner is a band of about thirty rows
# across the whole window and it pushes the rail header and the transcript down
# behind it, which repaints tens of thousands of pixels; an attached window
# repaints the strip only where a hover or a re-listed session lands in it.
BANNER_MIN_PIXELS=4000
QUIET_MAX_PIXELS=600
# How many times the host is killed and restarted, and how long each half of a
# cycle is given. The schedule runs 500ms, 750ms, 1.1s, 1.7s ... to a 15s
# ceiling, and a cold host takes a few seconds to listen, so a recovery that
# has not happened inside this has not been scheduled.
RESTARTS=10
DISCONNECT_TIMEOUT=20
RECOVERY_TIMEOUT=45
# How long the before arm watches a refused window before calling the refusal
# permanent. Longer than the schedule's own ceiling, so a reconnection that was
# merely slow is not published as one that never came.
PERMANENCE_SECONDS=30

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"
BASE_FRAME="${PROBE_DIR}/host-restart-attached.png"

strip_diff() {
	screen_differs_from_frame_pixels_at "${BASE_FRAME}" "${STRIP_CROP}"
}

# Wait until the strip is above or below a pixel count, and say how long that
# took. A caller reads the elapsed milliseconds either way: a timeout is a
# reading too, and the before arm is written around one.
wait_strip() { # <above|below> <pixels> <timeout-seconds>
	local mode="$1" bound="$2" ceiling="$3" started now diff
	started="$(date +%s%3N)"
	while :; do
		diff="$(strip_diff)"
		if [ "${mode}" = "above" ] && [ "${diff}" -ge "${bound}" ]; then
			break
		fi
		if [ "${mode}" = "below" ] && [ "${diff}" -le "${bound}" ]; then
			break
		fi
		now="$(date +%s%3N)"
		if [ $(( now - started )) -ge $(( ceiling * 1000 )) ]; then
			echo "$(( now - started ))"
			return 1
		fi
		sleep 0.4
	done
	now="$(date +%s%3N)"
	echo "$(( now - started ))"
}

# ─── 1. The Window With Its Host Up ──────────────────────────────────────────
# The pointer is parked in the transcript, away from every control the strip
# holds, so no reading below is a hover arriving or leaving.
move_px "$(( TRANSCRIPT_COLUMN_LEFT + 24 ))" "$(( WIN_Y + WIN_H / 2 ))"
settle 2
shot attached
probe_frame "${BASE_FRAME}"

if [ "$(host_table baseline | wc -l)" -lt 1 ]; then
	abandon_take "a-host-is-running" "no GUI host process is running, so the window is attached to something this scene cannot restart"
fi

# ─── 2. Kill It, Restart It, Ten Times ───────────────────────────────────────
RECOVERED=0
REFUSED_AT=0
for cycle in $(seq 1 "${RESTARTS}"); do
	if [ "$(kill_host)" = "0" ]; then
		abandon_take "the-host-was-killed" "cycle ${cycle} found no host process to kill"
	fi
	if ! LOST_MS="$(wait_strip above "${BANNER_MIN_PIXELS}" "${DISCONNECT_TIMEOUT}")"; then
		abandon_take "the-window-noticed" \
			"the strip under the titlebar stayed within ${BANNER_MIN_PIXELS} pixels of the attached frame for ${LOST_MS}ms after the host was killed, so the window drew no banner for a host that is gone"
	fi
	if [ "${cycle}" = "1" ]; then
		shot host-killed
	fi
	start_host
	if RECOVERY_MS="$(wait_strip below "${QUIET_MAX_PIXELS}" "${RECOVERY_TIMEOUT}")"; then
		RECOVERED=$(( RECOVERED + 1 ))
		echo "scene: restart ${cycle} -- banner in ${LOST_MS}ms, attached again in ${RECOVERY_MS}ms" >&2
	else
		REFUSED_AT="${cycle}"
		echo "scene: restart ${cycle} -- banner in ${LOST_MS}ms, still not attached after ${RECOVERY_MS}ms" >&2
		break
	fi
done

# ─── 3. What The Restarts Came To ────────────────────────────────────────────
# Each arm states its own claim before the frame is taken, since the two end in
# different places: one on a window that kept coming back, one on a window that
# stopped trying.
if [ "${ARM}" = "before" ]; then
	if [ "${REFUSED_AT}" = "0" ]; then
		abandon_take "the-ceiling-was-reached" \
			"the window recovered from all ${RESTARTS} restarts, so this executable does not carry the defect the before arm is for"
	fi
	# A refusal is permanent and a slow reconnection is not, and the frame is
	# named for the first. So the host is put back and left listening for longer
	# than the policy's own ceiling: a window that was going to come back has
	# every chance to, and one that has stopped trying stays as it is.
	start_host
	sleep "${PERMANENCE_SECONDS}"
	STILL_GONE="$(strip_diff)"
	if [ "${STILL_GONE}" -lt "${BANNER_MIN_PIXELS}" ]; then
		abandon_take "the-refusal-is-permanent" \
			"the strip came back to within ${STILL_GONE} pixels of the attached frame ${PERMANENCE_SECONDS}s after the host was restarted, so the window was reconnecting rather than refusing"
	fi
elif [ "${RECOVERED}" != "${RESTARTS}" ]; then
	abandon_take "every-restart-was-recovered-from" \
		"the window recovered from ${RECOVERED} of ${RESTARTS} host restarts and refused restart ${REFUSED_AT}"
fi

settle 2
shot restarts-survived

if [ "${ARM}" = "before" ]; then
	echo "scene: the window refused restart ${REFUSED_AT} of ${RESTARTS} and was still refusing ${PERMANENCE_SECONDS}s later (${STILL_GONE} pixels of banner)" >&2
	exit 0
fi

# The last frame is read against the first rather than against the loop's own
# probes: a window that recovered ten times and then drew something else over
# the strip is not the frame this arm claims.
ATTACHED_AGAIN="$(frames_differ_pixels_at "${SCENE_OUT}/${SCENE_NAME}-attached.png" "${SCENE_OUT}/${SCENE_NAME}-restarts-survived.png" "${STRIP_CROP}")"
if [ "${ATTACHED_AGAIN}" -gt "${QUIET_MAX_PIXELS}" ]; then
	abandon_take "the-window-is-attached" \
		"the strip differs from the attached frame by ${ATTACHED_AGAIN} pixels after the last restart, over the ${QUIET_MAX_PIXELS} an attached window repaints"
fi
echo "scene: the window recovered from ${RESTARTS} of ${RESTARTS} host restarts, ending ${ATTACHED_AGAIN} pixels from the frame it started at" >&2
