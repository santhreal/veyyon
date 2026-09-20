#!/usr/bin/env bash
# Read a plan again from the native GPUI window, with no agent having asked.
#
# Records visual evidence for:
#   1. plan-unseen   (a session in plan mode with a plan on disk and no card up)
#   2. plan-raised   (the same window after `/plan-review`, the plan above the composer)
#   3. plan-accepted (one press of the card's affirmative answer later)
#
# THE CLAIM. A plan decision was reachable from exactly one place: inside the
# agent's own `resolve` call. A card dismissed, a window attached after it was
# answered, or a plan the agent drafted without calling `resolve` left a plan
# on disk that nothing could bring back up. `/plan-review` is the row that
# brings it up, off the newest plan file the session wrote, and the card it
# raises is the same card `resolve` raises and is answered the same way.
#
# Frame 1 is the state that used to be terminal: plan mode on, a plan written,
# and no way to look at it. Frame 2 is the row doing its work. Frame 3 is the
# answer landing -- the card is gone and the session has left plan mode, which
# is the approval reaching the host rather than a card being dismissed.
#
# Both arms are seeded into plan mode, because that is the state the row acts
# on rather than the claim:
#
#   SCENE_SETTINGS='plan.defaultOnStartup: true' SCENE_MOTION_FLOOR=5 \
#     proof/docker/record-native.sh proof/scenes/desktop-plan-review.sh
#
# The other arm holds the window and the host at the commit before the row
# existed, where the palette has no `/plan-review` to run and the band above
# the composer stays empty:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     <this-commit> plan-review-before
#   SCENE_ARM=before PROOF_BASE_REF=<this-commit>^ \
#     SCENE_SETTINGS='plan.defaultOnStartup: true' SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/plan-review-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-plan-review.sh
#
# WHAT IS MEASURED. Two authored colours over one band of the window.
#   * `tint.plan.fill` is the ring a plan card is bordered with, so a row
#     carrying it across half the card's measure is one of that card's edges,
#     and a band with no such row is a band with no card in it.
#   * `role.accent` fills the affirmative answer the card offers, which is what
#     separates a plan waiting to be answered from any other ringed block.
#   Both come from the theme this checkout ships, read through the preamble's
#   own pass over the band, so a retheme moves each reading with its colour.
#
# NOTHING HERE IS STAGED. The plan file is the session's own artifact, the card
# is the host's, and the acceptance is the composer's own control. What is
# seeded is the plan file itself, for the reason desktop-plan-refine.sh states:
# a model that writes the file somewhere else fails before the surface this
# scene is about is reached.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

# ─── Where A Plan Card Can Be Drawn ──────────────────────────────────────────
# The attached cards share the composer's measure and stack directly above it
# (§5.5), so the band a plan can occupy is everything between the titlebar and
# the composer band, at the composer card's own width and left edge.
CARD_BAND_H=$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))
if (( CARD_BAND_H < 160 )); then
	abandon_take "a-card-band-exists" \
		"the window leaves ${CARD_BAND_H}px between its titlebar and its composer"
fi
CARD_BAND="${COMPOSER_CARD_W}x${CARD_BAND_H}+${COMPOSER_CARD_LEFT}+$(( WIN_Y + TITLEBAR_H ))"
echo "scene: a plan can occupy ${CARD_BAND}" >&2

# The composer's primary control: the box in the card's footer against its
# trailing inset, which reads `Accept` while a plan is up and no draft is under
# it, and is the affirmative answer this scene presses.
PRIMARY_X=$(( COMPOSER_CARD_LEFT + COMPOSER_CARD_W - CARD_PAD_H - GUTTER_PX ))
PRIMARY_Y=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - GUTTER_PX ))

# Somewhere with nothing under the pointer for every reading, so no hover fill
# is in one frame and not another.
PARK_X=$(( SESSION_REGION_X + SESSION_REGION_W / 2 ))
PARK_Y=$(( WIN_Y + TITLEBAR_H + 24 ))

# An affirmative pill is hundreds of pixels of accent; a stray accent-inked
# word is not.
ACCENT_PIXELS_MIN=200

plan_reading() { # <png> -> "RING_PX TOP BOTTOM ACCENT_PX"
	plan_card_reading "$1" "${CARD_BAND}" "${COMPOSER_CARD_W}"
}

# Whether a plan is up in the frame just taken, with the reading printed either
# way: an absence is a reading too, and frames 1 and 3 are written around one.
card_state() { # <png> -> "0" or "1", and the reading on stderr
	local ring top bottom accent
	read -r ring top bottom accent < <(plan_reading "$1")
	echo "scene: $(basename "$1") rings ${ring}px between y ${top} and ${bottom}," \
		"with ${accent}px of accent between them" >&2
	if (( bottom > top && accent >= ACCENT_PIXELS_MIN )); then
		printf '1'
	else
		printf '0'
	fi
}

# Run one row from the palette, by the query that names it.
run_command() { # <query>
	k "ctrl+k"
	pause 0.8
	t "$1"
	pause 0.8
	k "Return"
	pause 1.5
}

# ─── The Model The Session Runs On ───────────────────────────────────────────
# Accepting the plan starts a turn, so the session states which model runs it
# rather than leaving whatever the profile held in the chip of one frame.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
k "ctrl+shift+m"
pause 0.4
t "local/qwen2.5-1.5b"
pause 0.5
k "Return"
pause 0.5

# ─── The Plan Nobody Has Been Shown ──────────────────────────────────────────
# Named for its slug rather than `PLAN.md`: `local://PLAN.md` is the address
# plan-mode state carries until the agent names one, so a row that read state
# alone would find this file by accident. The scan of the session's own plan
# files is what finds this one.
seed_plan_file() { # -> path of the plan the row will read
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text())
with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(10.0)
    connection.connect(str(endpoint))
    connection.sendall(b'{"id":1,"action":"ListSessions"}\n')
    row = None
    with connection.makefile("rb") as stream:
        for _ in range(32):
            line = stream.readline(8 * 1024 * 1024 + 1)
            if not line or len(line) > 8 * 1024 * 1024:
                raise SystemExit("missing or oversized host frame")
            sections = json.loads(line).get("Snapshot", {})
            if "Sessions" not in sections:
                continue
            sessions, errors = sections["Sessions"]
            if errors:
                raise SystemExit("host session listing reported errors")
            row = next((r for r in sessions["value"] if r["id"] == created), None)
            break
if row is None:
    raise SystemExit(f"the created session {created} is in no host listing")
local = Path(row["path"]).with_suffix("") / "local"
local.mkdir(parents=True, exist_ok=True)
plan = local / "readme-plan.md"
plan.write_text(
    "# Add a README\n\n"
    "- Create a README file with instructions on how to use the project.\n"
    "- Update the README file with information on how to contribute to the project.\n"
)
print(plan, end="")
PY
}

PLAN_FILE="$(seed_plan_file)" || abandon_take "a-plan-file-exists" \
	"the session's own local root took no plan file, so there is nothing to review"
echo "scene: the plan to review is at ${PLAN_FILE}" >&2

# ─── The Window With The Plan Unseen ─────────────────────────────────────────
# The model picker left the editor focused and the preamble left a slash in it,
# so the draft is cleared: a draft under a plan card turns the affirmative
# answer into a refinement, which is the other scene.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
k "ctrl+a"
k "BackSpace"
pause 0.4
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot plan-unseen
UNSEEN="$(card_state "${SCENE_OUT}/${SCENE_NAME}-plan-unseen.png")"
if [ "${UNSEEN}" = "1" ]; then
	abandon_take "no-plan-is-up-at-rest" \
		"a plan card is already up before the row was run, so the frames below cannot tell \
a raised plan from the window's own state"
fi

# ─── Reading The Plan Again ──────────────────────────────────────────────────
run_command "plan-review"
move_px "${PARK_X}" "${PARK_Y}"
pause 1.2
shot plan-raised
RAISED="$(card_state "${SCENE_OUT}/${SCENE_NAME}-plan-raised.png")"

# ─── Answering It ────────────────────────────────────────────────────────────
# With nothing in the composer the control reads `Accept`, which is the answer
# that leaves plan mode and starts the work.
if [ "${RAISED}" = "1" ]; then
	move_px "${PRIMARY_X}" "${PRIMARY_Y}"
	pause 0.4
	click
	pause 3.0
fi
move_px "${PARK_X}" "${PARK_Y}"
pause 0.8
shot plan-accepted
ACCEPTED="$(card_state "${SCENE_OUT}/${SCENE_NAME}-plan-accepted.png")"

case "${ARM}" in
after)
	if [ "${RAISED}" != "1" ]; then
		abandon_take "the-row-raises-the-plan" \
			"the band above the composer carries no ringed card offering an answer after \
\`/plan-review\` was run, so the row reached no plan"
	fi
	if [ "${ACCEPTED}" = "1" ]; then
		abandon_take "the-answer-takes-the-card-down" \
			"the card is still up after its affirmative answer was pressed, so the approval \
reached nothing"
	fi
	echo "scene: after arm -- no card, a card, then none: the plan was read again and answered" >&2
	;;
before)
	if [ "${RAISED}" = "1" ]; then
		abandon_take "the-baseline-has-no-such-row" \
			"the baseline raised a plan card, so this arm is not the window from before the \
row existed"
	fi
	echo "scene: before arm -- the palette has no row that reads the plan, and the band stays empty" >&2
	;;
*)
	abandon_take "the-arm-is-named" "SCENE_ARM=${ARM} is neither before nor after"
	;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is a session in plan mode with a plan written and no card up, which
# is where an operator is left every time a card is answered or dismissed.
#
# Frame 2 is that plan, raised by the row rather than by the agent, drawn at
# the composer's measure with the answers it offers.
#
# Frame 3 is the affirmative answer landing: the card is gone.
#
# WHAT IS NOT HERE. The turn the approval starts, which depends on a model
# rather than on this window; the refusal path, which is
# proof/scenes/desktop-plan-refine.sh; and what the host does with either
# answer, which is
# packages/coding-agent/test/gui-host/a-plan-is-raised-again-when-the-desktop-asks-to-see-it.test.ts.
