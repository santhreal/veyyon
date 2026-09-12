#!/usr/bin/env bash
# Send a plan back for revision from the native GPUI window, with the
# refinement the operator typed under it.
#
# Records visual evidence for:
#   1. plan-raised        (a plan the agent asked approval for, above the composer)
#   2. refinement-typed   (the revision written into the composer under that plan)
#   3. refinement-sent    (the same window one press of the composer's control later)
#
# THE CLAIM. The composer's control reads `Refine` the moment a draft exists
# under a plan, so the draft IS the refinement, and pressing it sends the plan
# back with those words. Once the host has taken them the composer is empty:
# the refinement went out, and the rail no longer states it as text nobody
# sent.
#
# In the other arm the same press answered with a bare refusal. The agent was
# told a revision had been asked for and never what it was, and the words
# stayed in the composer -- the frame that arm records is a composer still
# holding a refinement that reached nothing.
#
# WHERE THE PLAN COMES FROM. `plan.defaultOnStartup` starts a fresh session in
# plan mode, so the agent drafts its plan to a file and asks for approval
# through `resolve { action: "apply" }`, which is the one seam a plan decision
# crosses. The card is the host's own and no model is persuaded to draw one.
# Both arms are seeded the same way:
#
#   SCENE_SETTINGS='plan.defaultOnStartup: true' SCENE_MOTION_FLOOR=5 \
#     proof/docker/record-native.sh proof/scenes/desktop-plan-refine.sh
#
# and the other arm against a build that answered a plan without its
# refinement. That change is entirely inside the executable, so the arm holds
# no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_SETTINGS='plan.defaultOnStartup: true' \
#     SCENE_MOTION_FLOOR=5 PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-plan-refine.sh
#
# WHAT IS MEASURED. Two authored colours and one band of the window.
#   * `tint.plan.fill` is the ring a plan card is bordered with, so a row
#     carrying it across half the card's measure is one of that card's edges.
#   * `role.accent` fills the affirmative answer the card offers, which is the
#     acceptance beside the revision.
#   * The composer band is compared against the same band photographed while
#     the composer was empty under this very card, so the reading is whether
#     the refinement is still drawn there and nothing else.
# Both colours come from the theme this checkout ships, so a retheme moves
# each reading with its colour.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

THEME="${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/themes/dark.toml"

role_colour() { # <name> -> the [role] colour of that name
	local found
	found="$(sed -n "/^\[role\]/,/^\[/ s/^$1 = \"\(#[0-9a-fA-F]\{6\}\)\".*/\1/p" "${THEME}" | head -1)"
	if [ -z "${found}" ]; then
		abandon_take "the-theme-is-readable" "no [role] $1 in ${THEME}"
	fi
	printf '%s' "${found}"
}

tint_colour() { # <section> -> the fill of that tint section
	local found
	found="$(sed -n "/^\[tint\.$1\]/,/^\[/ s/^fill = \"\(#[0-9a-fA-F]\{6\}\)\".*/\1/p" "${THEME}" | head -1)"
	if [ -z "${found}" ]; then
		abandon_take "the-theme-is-readable" "no [tint.$1] fill in ${THEME}"
	fi
	printf '%s' "${found}"
}

RING="$(tint_colour plan)"
ACCENT="$(role_colour accent)"
echo "scene: a plan rings in ${RING} and affirms in ${ACCENT}" >&2

# ─── Where A Plan Card Can Be Drawn ──────────────────────────────────────────
# The attached cards share the composer's measure and stack directly above it
# (§5.5), so the band a plan can occupy is everything between the titlebar and
# the composer band, at the composer card's own width and left edge.
CARD_BAND_Y=$(( WIN_Y + TITLEBAR_H ))
CARD_BAND_H=$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))
if (( CARD_BAND_H < 160 )); then
	abandon_take "a-card-band-exists" \
		"the window leaves ${CARD_BAND_H}px between its titlebar and its composer"
fi
CARD_BAND="${COMPOSER_CARD_W}x${CARD_BAND_H}+${COMPOSER_CARD_LEFT}+${CARD_BAND_Y}"
echo "scene: a plan can occupy ${CARD_BAND}" >&2

# The composer's primary control: a 28px box in the card's footer, against the
# card's trailing inset, mirroring the model chip on the other side.
PRIMARY_X=$(( COMPOSER_CARD_LEFT + COMPOSER_CARD_W - CARD_PAD_H - GUTTER_PX ))
PRIMARY_Y=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - GUTTER_PX ))

# The editor itself, which is the band less its footer row and less the hint
# on its trailing side: the draft is drawn here, and the run bar, the model
# chip, the primary control and the hint that names what the turn takes are
# not. A turn that starts on the press repaints all four -- the hint alone
# goes from `Refine plan` to `Steer turn` -- so a reading of the whole band
# would report a running turn as a refinement still on screen.
EDITOR_TOP=$(( COMPOSER_EDITOR_Y - GUTTER_PX ))
EDITOR_H=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - 2 * GUTTER_PX - EDITOR_TOP ))
HINT_W=128
EDITOR_W=$(( COMPOSER_CARD_W - HINT_W ))
if (( EDITOR_H < 20 || EDITOR_W < 200 )); then
	abandon_take "an-editor-area-exists" \
		"the composer leaves ${EDITOR_W}x${EDITOR_H} for a draft, which is not a line of one"
fi
EDITOR_CROP="${EDITOR_W}x${EDITOR_H}+${COMPOSER_CARD_LEFT}+${EDITOR_TOP}"
echo "scene: the draft is drawn in ${EDITOR_CROP}" >&2

# A ring row is a straight edge across the card, so half the measure is the
# floor there. An affirmative pill is hundreds of pixels of accent; a stray
# accent-inked word is not. A refinement of the length typed below inks
# thousands of pixels into the editor, so a floor of 300 separates an editor
# that still holds it from one repainted by a cursor.
ACCENT_PIXELS_MIN=200
DRAFT_PIXELS_MIN=300

# One reading of one frame: the plan's ring edges and the accent-filled answer
# between them. Everything is counted between the ring's own edges, so a
# transcript block behind the card cannot be read as part of it.
plan_reading() { # <png> -> "RING_PX TOP BOTTOM ACCENT_PX"
	local dump="${TMPDIR}/frame-compare/plan-reading.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "$1" -crop "${CARD_BAND}" +repage txt:- >"${dump}"
	python3 - "${dump}" "${RING#\#}" "${ACCENT#\#}" "${COMPOSER_CARD_W}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")


def rgb(text):
	return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def near(colour, wanted, tolerance):
	return all(abs(a - b) <= tolerance for a, b in zip(colour, wanted))


ring, accent = (rgb(argument.upper()) for argument in sys.argv[2:4])
width = int(sys.argv[4])
# The hairline sits seven steps from the plan ring on its nearest channel, so
# three is under it and cannot collect the neighbour. The accent's nearest
# neighbour is the focus colour, twenty-seven away on one channel.
ring_rows, accent_rows, ring_total = {}, {}, 0
for line in open(sys.argv[1], encoding="ascii"):
	found = PIXEL.match(line)
	if not found:
		continue
	row, colour = int(found.group(2)), rgb(found.group(3).upper())
	if near(colour, ring, 3):
		ring_rows[row] = ring_rows.get(row, 0) + 1
		ring_total += 1
	elif near(colour, accent, 10):
		accent_rows[row] = accent_rows.get(row, 0) + 1

edges = sorted(row for row, count in ring_rows.items() if count >= width // 2)
if not edges:
	print(f"{ring_total} 0 0 0")
	raise SystemExit(0)

top, bottom = edges[0], edges[-1]
accent_pixels = sum(count for row, count in accent_rows.items() if top < row < bottom)
print(f"{ring_total} {top} {bottom} {accent_pixels}")
PY
}

# Wait until a plan card is drawn, or say what was there instead. The agent
# writes its plan and asks for approval, so the wait is on the window rather
# than on a timer.
await_plan() { # <seconds> -> 0 once a plan is ringed and offers its answers
	local deadline=$(( SECONDS + $1 )) probe="${TMPDIR}/awaiting-plan.png"
	local top=0 bottom=0 accent=0
	while (( SECONDS < deadline )); do
		probe_frame "${probe}"
		read -r _ top bottom accent < <(plan_reading "${probe}")
		if (( bottom > top && accent >= ACCENT_PIXELS_MIN )); then
			echo "scene: a plan is up, ringed y ${top}..${bottom} with ${accent}px of accent" >&2
			return 0
		fi
		pause 2.0
	done
	echo "scene: no plan card after $1s" >&2
	return 1
}

# ─── The Model The Session Runs On ───────────────────────────────────────────
# The plan is the model's own, so the session states which model drafted it and
# a picker left at whatever the profile held would put a different chip in
# every frame.
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

# ─── The Plan File The Session's Own Plan Mode Approves ─────────────────────
# The session was seeded into plan mode, so the way out of it is the approval
# below. The plan file is written here rather than asked for as a turn of its
# own: `resolve` reads whatever path it derives from the call it was given, and
# a model that writes the file somewhere else -- or names it back in prose with
# a space in the scheme -- fails the approval before the card this scene is
# about is ever raised. Seeding the file leaves the submission, the card, the
# answer and the refinement to the product.
seed_plan_file() { # -> path of the plan the approval will read
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
plan = local / "PLAN.md"
plan.write_text(
    "# Add a README\n\n"
    "- Create a README file with instructions on how to use the project.\n"
    "- Update the README file with information on how to contribute to the project.\n"
)
print(plan, end="")
PY
}

PLAN_FILE="$(seed_plan_file)" || abandon_take "a-plan-file-exists" \
	"the session's own local root took no plan file, so there is nothing to submit"
echo "scene: the plan to approve is seeded at ${PLAN_FILE}" >&2

# One ask, retried: the phrasing names the tool and the file, which is what
# this recorder's model answers with a call rather than with a sentence
# describing one. A retry is a resample of the same ask, so a take that lost
# the first one reaches the card on the next.
PLAN_IS_UP=0
for _attempt in 1 2 3; do
	submit_prompt "Use the resolve tool with action apply on local://PLAN.md."
	if await_plan 90; then
		PLAN_IS_UP=1
		break
	fi
done
if (( PLAN_IS_UP == 0 )); then
	abandon_take "a-plan-is-raised" \
		"the session submitted no plan to approve, so there is nothing to send back"
fi
pause 0.6
shot plan-raised
RAISED_FRAME="${SCENE_OUT}/${SCENE_NAME}-plan-raised.png"
read -r RAISED_RING RAISED_TOP RAISED_BOTTOM RAISED_ACCENT < <(plan_reading "${RAISED_FRAME}")
echo "scene: the plan rings ${RAISED_RING}px between y ${RAISED_TOP} and ${RAISED_BOTTOM}," \
	"and offers ${RAISED_ACCENT}px of accent" >&2
if (( RAISED_BOTTOM <= RAISED_TOP )); then
	abandon_take "a-plan-is-ringed" "the plan card drew no edges of its own"
fi

# The editor under that card, with nothing in it: the frame every reading
# below is compared against. Taken with the pointer already resting on the
# control, so arriving there paints no hover fill into the difference.
move_px "${PRIMARY_X}" "${PRIMARY_Y}"
pause 0.4
EMPTY_EDITOR="${TMPDIR}/empty-composer.png"
probe_frame "${EMPTY_EDITOR}"

# ─── The Refinement, Written Under The Plan ─────────────────────────────────
REFINEMENT="Split the second step into its own turn and say which files it touches"
type_prompt "${REFINEMENT}"
move_px "${PRIMARY_X}" "${PRIMARY_Y}"
pause 0.4
shot refinement-typed
TYPED_FRAME="${SCENE_OUT}/${SCENE_NAME}-refinement-typed.png"
TYPED_PX="$(frames_differ_pixels_at "${EMPTY_EDITOR}" "${TYPED_FRAME}" "${EDITOR_CROP}")"
echo "scene: the refinement inks ${TYPED_PX} pixels into the editor" >&2
if (( TYPED_PX < DRAFT_PIXELS_MIN )); then
	abandon_take "a-refinement-is-typed" \
		"the editor moved ${TYPED_PX}px, which is not a refinement written into it"
fi

# ─── One Press Of The Control That Reads `Refine` ───────────────────────────
click
pause 3.0
shot refinement-sent
SENT_FRAME="${SCENE_OUT}/${SCENE_NAME}-refinement-sent.png"
SENT_PX="$(frames_differ_pixels_at "${EMPTY_EDITOR}" "${SENT_FRAME}" "${EDITOR_CROP}")"
echo "scene: after the press the editor differs from empty by ${SENT_PX} pixels" >&2
case "${ARM}" in
after)
	if (( SENT_PX >= DRAFT_PIXELS_MIN )); then
		abandon_take "the-refinement-left-the-composer" \
			"the editor still inks ${SENT_PX}px over its empty state, so the refinement stayed"
	fi
	echo "scene: the refinement went out and the composer is empty again" >&2
	;;
before)
	if (( SENT_PX < DRAFT_PIXELS_MIN )); then
		abandon_take "the-before-arm-kept-the-refinement" \
			"this arm answers with a bare refusal, so the refinement is still drawn;" \
			"the band moved ${SENT_PX}px, which reads as a composer that emptied"
	fi
	echo "scene: the refinement is still in the composer, having reached nothing" >&2
	;;
*)
	abandon_take "the-arm-is-named" "SCENE_ARM=${ARM} is neither before nor after"
	;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is a real plan, drafted by the session's own agent in plan mode and
# raised through the seam every plan decision crosses, drawn at the composer's
# measure with the two answers it offers.
#
# Frame 2 is the refinement written under it, in the composer whose control
# reads `Refine` because a draft exists.
#
# Frame 3 is one press later. Here the composer is empty: the words went to the
# agent as what to change. There they are still on screen, because the press
# answered with a refusal that carried nothing, and the agent was told only
# that a revision had been asked for.
#
# WHAT IS NOT HERE. The plan the agent comes back with, which depends on a
# model rather than on this window; the card's own `Revise` row, which answers
# with the same refinement and is held by
# crates/veyyon-desktop-surface/tests/a-draft-the-host-took-as-an-answer-leaves-the-composer.rs;
# and what the host does with the refinement once it has it, which is
# packages/coding-agent/test/gui-host/a-plan-sent-back-carries-the-refinement-it-was-answered-with.test.ts.
