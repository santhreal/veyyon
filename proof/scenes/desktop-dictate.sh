#!/usr/bin/env bash
# Photograph the composer's microphone in both states the `stt.enabled`
# setting puts it in, and prove which state the host was in when the frame was
# taken.
#
# Records visual evidence for:
#   1. dictate-rest (the composer footer carrying the microphone control)
#
# THE CLAIM. §4.3 states that a capability the host refuses is drawn greyed
# with the reason on it rather than withheld, because a control that
# disappears states nothing about why dictation cannot start. `stt.enabled` is
# off at the defaults, so the off arm draws the microphone dimmed and the on
# arm draws it at rest, and the control occupies the same place in the footer
# row in both.
#
# WHAT IS MEASURED. The host's own answer, read off the gui-host socket before
# the shot: the `Dictation` entry of the capability snapshot is `Available` on
# the on arm and `Unavailable` naming `stt.enabled` on the off arm. A settings
# differential is two runs and no single run can compare them, so what each arm
# asserts is that the window it photographed was talking to a host in the state
# the arm claims. Two frames from the same state is the failure this catches;
# the reviewer reads the dimming off the pair.
#
# The composer card is measured by the preamble, which abandons the take when
# the card is not on screen, so a frame of bare ground cannot be published as
# a frame of the control.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record the off arm at the defaults:
#
#   proof/record.sh proof/scenes/desktop-dictate.sh
#
# and the on arm with the setting seeded before the session starts:
#
#   proof/record.sh --settings 'stt.enabled: true' proof/scenes/desktop-dictate.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# The reason the host states while speech to text is off. Matched on the
# setting it names rather than on the whole sentence, so rewording the message
# does not fail a take that photographed the right state.
WITHHELD_NAMES="stt.enabled"

# What the host answers for `Dictation` in the capability snapshot it sends on
# connect: `Available`, or `Unavailable: <reason>`.
dictation_capability() {
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
deadline = time.monotonic() + 10
last_error = "no capability frame"

while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("Missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Capabilities" not in snapshot:
                        continue
                    for name, status in snapshot["Capabilities"]:
                        if name != "Dictation":
                            continue
                        if isinstance(status, str):
                            print(status)
                        else:
                            print(f"Unavailable: {status['Unavailable']['reason']}")
                        raise SystemExit(0)
                    raise RuntimeError("the capability snapshot named no Dictation")
    except (OSError, ValueError, RuntimeError) as error:
        last_error = str(error)
    time.sleep(0.1)
raise SystemExit(f"the host stated no Dictation capability: {last_error}")
PY
}

# ─── The Composer The Microphone Sits In ─────────────────────────────────────
# The preamble left a session it created with a dismissed palette in the
# composer. The draft is cleared so the footer row is photographed over an
# empty editor in both arms, and the card is measured again afterwards because
# a cleared draft returns the card to its resting height.
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.6
measure_composer_card
pause 0.4
shot dictate-rest

# ─── Which State The Host Was In ─────────────────────────────────────────────
if ! DICTATION_STATUS="$(dictation_capability)"; then
	abandon_take "the-host-states-dictation" \
		"the host was not reachable for its capability snapshot, so the arm this frame belongs to is unknown"
fi
echo "scene: the host answers Dictation ${DICTATION_STATUS}" >&2

case "${SCENE_SETTINGS:-}" in
	*stt.enabled*true*)
		if [ "${DICTATION_STATUS}" != "Available" ]; then
			abandon_take "the-on-arm-is-on" \
				"the arm seeded stt.enabled true and the host answered '${DICTATION_STATUS}', so this frame is not the on arm"
		fi
		;;
	*)
		case "${DICTATION_STATUS}" in
			Unavailable:*"${WITHHELD_NAMES}"*) ;;
			*)
				abandon_take "the-off-arm-is-off" \
					"the arm ran at the defaults and the host answered '${DICTATION_STATUS}' rather than an Unavailable naming ${WITHHELD_NAMES}, so this frame is not the off arm"
				;;
		esac
		;;
esac
