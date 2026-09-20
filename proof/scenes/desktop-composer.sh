#!/usr/bin/env bash
# Drive the native GPUI desktop front end window and capture composer interactions.
#
# Records visual evidence for:
#   1. idle (composer in initial idle state)
#   2. typed-draft (draft text typed into composer)
#   3. model-picker-open (model picker palette overlay open)
#   4. model-picker-dismissed (model picker dismissed; draft retained in composer)
#   5. slash-palette-open (slash commands palette overlay open)
#   6. slash-palette-dismissed (slash palette dismissed)
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT,
# and SCENE_LIB already initialized.

set -euo pipefail

# ─── Bounded Window Readiness Check ──────────────────────────────────────────
# Ensure the mapped GPUI desktop window is viewable on the container-private display.
READY=0
for _ in $(seq 1 40); do
	if [ -n "${SCENE_WINDOW:-}" ] && xwininfo -id "${SCENE_WINDOW}" 2>/dev/null | grep -q "Map State: IsViewable"; then
		READY=1
		break
	fi
	sleep 0.25
done

if [ "${READY}" != "1" ]; then
	abandon_take "native-window-viewable" "native desktop window (${SCENE_WINDOW:-none}) was not viewable within 10s"
fi

# Wait for host state without resending an interaction.
native_session_ready() {
python3 - "$1" "${2:-2}" <<'PY'
import json
import os
from pathlib import Path
import socket
import time
import sys

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
baseline_path = Path(os.environ["TMPDIR"]) / "sessions-before.json"
mode = sys.argv[1]
minimum_messages = int(sys.argv[2])
baseline = set(json.loads(baseline_path.read_text())) if mode != "before" else set()
created_path = Path(os.environ["TMPDIR"]) / "created-session.json"
created_id = json.loads(created_path.read_text()) if mode == "finished" else None
deadline = time.monotonic() + (90 if mode == "finished" else 10)
latest_row = None


def report_provider_error(row):
    # A failed turn carries the provider's own message in the transcript rather than in
    # the session index, and a take is diagnosed from the recorder's log after the fact.
    # A transcript that cannot be read is not the failure being reported, so it stays
    # quiet rather than replacing the status this probe stopped on.
    if not row:
        return
    try:
        with Path(row["path"]).open() as transcript:
            for entry_line in transcript:
                message = json.loads(entry_line).get("message", {})
                if message.get("role") == "assistant" and message.get("errorMessage"):
                    print(f"Native provider error: {message['errorMessage']}", file=sys.stderr)
    except (OSError, ValueError):
        pass

while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(b'{"id":1,"action":"ListSessions"}\n')
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("Missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Sessions" in snapshot:
                        sessions, errors = snapshot["Sessions"]
                        if errors:
                            raise RuntimeError("Host session listing reported errors")
                        identities = {session["id"] for session in sessions["value"]}
                        if mode == "before":
                            baseline_path.write_text(json.dumps(sorted(identities)))
                            print("native host returned its session snapshot")
                            raise SystemExit(0)
                        if mode == "created" and identities - baseline:
                            created_path.write_text(json.dumps(next(iter(identities - baseline))))
                            print("native session-creation interaction reached the host")
                            raise SystemExit(0)
                        if mode == "finished":
                            current = next((row for row in sessions["value"] if row["id"] == created_id), None)
                            latest_row = current
                            last_error = (
                                f"session status={current.get('status')}, messages={current.get('message_count', 0)}"
                                if current else "created session missing from host snapshot"
                            )
                            # A session whose last entry is an assistant turn holding an
                            # unanswered tool call reads as `Interrupted`, and that is the state
                            # every turn that calls a tool passes through while the tool runs. A
                            # scene that read it as terminal abandoned a take of a prompt the
                            # model chose to answer with a tool. Only `Error` and `Aborted` end
                            # the wait; a turn that stays `Interrupted` ends on the deadline
                            # below, which states the status it stopped at.
                            if current and current.get("status") in {"Error", "Aborted"}:
                                report_provider_error(current)
                                raise SystemExit(f"Native turn ended with status {current['status']}")
                            if current and current.get("message_count", 0) >= minimum_messages and current.get("status") == "Complete":
                                print("native turn completed with persisted transcript messages")
                                raise SystemExit(0)
                        break
    except (OSError, ValueError, RuntimeError) as error:
        last_error = str(error)
    time.sleep(0.1)
report_provider_error(latest_row)
raise SystemExit(f"Native session readiness timed out ({mode}): {locals().get('last_error', 'no new session')}")
PY
}

# A tool call, not merely a finished turn: a turn that answered in prose drew
# no card and touched no file, and a scene that waits on the turn alone
# photographs whatever the prose left. The host names the session's
# transcript, and the transcript states the block.
#
# A session whose last entry is an assistant turn holding an unanswered tool
# call reads as `Interrupted`, and that is exactly the state a turn passes
# through while the tool runs, so only `Error` and `Aborted` end the wait. What
# the probe waits for is the completed shape: a `toolCall` block, the
# `toolResult` that answered it, and the turn settled at `Complete`.
native_tool_call_recorded() {
python3 - <<'PY'
import json
import os
from pathlib import Path
import socket
import sys
import time

profile = os.environ.get("VEYYON_PROFILE") or "default"
endpoint = Path.home() / ".veyyon" / "profiles" / profile / "agent" / "gui-host.sock"
created = json.loads((Path(os.environ["TMPDIR"]) / "created-session.json").read_text())
deadline = time.monotonic() + 240
last = "no session snapshot"
while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(max(0.01, deadline - time.monotonic()))
            connection.connect(str(endpoint))
            connection.sendall(b'{"id":1,"action":"ListSessions"}\n')
            with connection.makefile("rb") as stream:
                for _ in range(32):
                    connection.settimeout(max(0.01, deadline - time.monotonic()))
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line or len(line) > 8 * 1024 * 1024:
                        raise RuntimeError("missing or oversized host frame")
                    snapshot = json.loads(line).get("Snapshot", {})
                    if "Sessions" not in snapshot:
                        continue
                    sessions, errors = snapshot["Sessions"]
                    if errors:
                        raise RuntimeError("host session listing reported errors")
                    row = next((r for r in sessions["value"] if r["id"] == created), None)
                    if not row:
                        raise RuntimeError("created session missing from host snapshot")
                    last = f"status={row.get('status')}, messages={row.get('message_count', 0)}"
                    if row.get("status") in {"Error", "Aborted"}:
                        raise SystemExit(f"native turn ended with status {row['status']}")
                    calls = 0
                    results = 0
                    with Path(row["path"]).open() as transcript:
                        for entry_line in transcript:
                            message = json.loads(entry_line).get("message", {})
                            if message.get("role") == "toolResult":
                                results += 1
                            content = message.get("content")
                            if isinstance(content, list):
                                calls += sum(
                                    1
                                    for block in content
                                    if isinstance(block, dict) and block.get("type") == "toolCall"
                                )
                    last = f"{last}, calls={calls}, results={results}"
                    if calls and results and row.get("status") == "Complete":
                        print(f"native turn recorded {calls} tool call(s), {results} result(s)")
                        raise SystemExit(0)
                    break
    except (OSError, ValueError, RuntimeError) as error:
        last = str(error)
    time.sleep(0.2)
raise SystemExit(f"no completed tool call within 240s ({last})")
PY
}
if ! native_session_ready before; then
	abandon_take "native-host-ready" "native host returned no session snapshot within 10s"
fi

# Establish input focus on the native window on this private display.
xdotool windowfocus --sync "${SCENE_WINDOW}"

# ─── What The Window Sheds At This Width ─────────────────────────────────────
# Every desktop scene crops by region, and where a region IS depends on the
# breakpoint row the window's width resolves to: the rail is 256, 208 or gone,
# and the panel is a column of 540 or 360 or a float over the session surface.
# The rows are read from the token files this checkout ships rather than
# restated here, so a scene recorded at a new width crops what the product
# actually drew instead of what one width happened to make true.
read -r RAIL_W QUEUE_MODE QUEUE_W PANEL_MODE PANEL_W DRAWER_PLACEMENT LABELS COMPOSER_MAX_W GUTTER_PX SHEET_INSET SHEET_PX COMPOSER_BAND_H TRANSCRIPT_MAX_W CARD_FOOT_PX CARD_PAD_H CARD_PAD_BOTTOM TITLEBAR_H RUN_BAR_H < <(
	python3 - "${BASH_SOURCE[0]%/*}" "${WIN_W}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

width = float(sys.argv[2])
surface = token_px.load("surface/breakpoints.toml")
panels = token_px.load("surface/panels.toml")["right_panel"]
composer_tokens = token_px.load("surface/composer.toml")
composer = composer_tokens["geometry"]
transcript = token_px.load("surface/transcript.toml")["layout"]
shell = token_px.load("surface/shell.toml")
# The run bar is a row of medium controls and is exactly as tall as one
# (§6.10), so its height is the control table's rather than a second copy of
# the measure in the composer's own file.
run_bar_h = token_px.px(token_px.load("controls.toml")["height"]["medium_px"])
# §5.4 measures the composer against the session surface it sits in, insetting
# it by one spacing step on each side. Both numbers are authored, so the scene
# reads them rather than deciding what a card should measure. A geometry value
# states a scale name as often as a number, and token_px is where either one
# becomes a measure.
gutter = token_px.px("s4")
# A float draws as a sheet, which frames its body with one spacing step and a
# hairline on every side; a column has no such frame. Every crop of an
# overlaid panel starts inside it.
sheet = token_px.px("s4") + token_px.px("hairline")
# A floor on the band the composer owns at the window's lower edge: the card's
# authored minimum, the gap under it, the run bar, and the column's own bottom
# padding. `rest_height_px` is a minimum rather than a measure, and the card
# draws taller than it -- 86px at rest against an authored 70 at scale 1, since
# the editor line, the footer row and the card's padding are what decide it --
# so this number lies strictly inside the card. A crop of the band therefore
# omits its topmost rows, and a crop of the transcript above it takes a few of
# the card's; both are conservative for a float that is entitled to the
# transcript and nothing under it, which a generous band would read as a panel
# drawn over the draft.
band = (
    token_px.px(composer["rest_height_px"])
    + token_px.px("s3")
    + run_bar_h
    + token_px.px("s3")
)

# What the session column places under the composer card, from the card's lower
# edge to the window's: the gap, the run bar, and the column's own bottom
# padding. A scene that aims at a control inside the card measures up from the
# window's foot through this, since the card is bottom-anchored and its own
# height is whatever its contents came to.
foot = (
    token_px.px("s3")
    + run_bar_h
    + token_px.px("s3")
)

rows = sorted(
    surface["breakpoint"].values(), key=lambda row: token_px.px(row["min_width_px"])
)
row = rows[0]
for candidate in rows:
    if width >= token_px.px(candidate["min_width_px"]):
        row = candidate

# The rail's declared measure, and the width it takes out of the columns row.
# A row that floats the rail draws it over the transcript at that measure and
# takes nothing, so every region left of it stays where a railless window puts
# it: a scene that crops at RAIL_W crops the column, and one that aims at the
# floated rail aims inside SHEET_PX..QUEUE_W.
queue_mode = row["queue_mode"]
queue = token_px.px(row["queue_width_px"])
rail = queue if queue_mode == "inline" else 0
share = width * panels["max_viewport_ratio"]
overlay = max(
    min(token_px.px(panels["default_width_px"]), share),
    min(token_px.px(panels["min_width_px"]), width),
)
mode = row["right_panel_mode"]
if mode.startswith("inline_"):
    asked = float(mode.removeprefix("inline_"))
    ceiling = width - rail - token_px.px(panels["container_margin_px"])
    inline = min(asked, share, ceiling)
    if inline < token_px.px(panels["min_width_px"]):
        placement, panel = "overlay", overlay
    else:
        placement, panel = "inline", inline
else:
    placement, panel = "overlay", overlay

print(
    int(rail),
    queue_mode,
    int(queue),
    placement,
    int(panel),
    row["terminal_drawer_placement"],
    "labels" if row["composer_footer_labels"] else "no-labels",
    token_px.px(composer["max_width_px"]),
    int(gutter),
    int(sheet) if placement == "overlay" else 0,
    int(sheet),
    int(band),
    token_px.px(transcript["column_width_px"]),
    int(foot),
    token_px.px(composer["padding_horizontal"]),
    token_px.px(composer["padding_bottom"]),
    token_px.px(shell["titlebar"]["height_px"]),
    run_bar_h,
)
PY
)
if [ -z "${PANEL_MODE:-}" ]; then
	abandon_take "the-shed-is-known" "no breakpoint row resolved for a ${WIN_W}px window"
fi
echo "scene: ${WIN_W}px sheds to a ${QUEUE_MODE} queue of ${QUEUE_W}px taking ${RAIL_W}px," \
	"panel ${PANEL_MODE} ${PANEL_W}px, drawer ${DRAWER_PLACEMENT}, ${LABELS}" >&2

# Where the transcript's own column is, in root coordinates. Every turn draws
# inside it: the operator's bubble, a tool card's chevron and a row's trailing
# controls are all placed against its edges rather than the window's, so a
# scene that aims at one of them aims here. The column is centred in the
# session surface -- the window less the queue rail -- at the authored width,
# or takes the whole surface when that is narrower.
#
# The panel is closed at the defaults a take starts from (§8.10), so the
# surface is the whole row. A scene that opens the panel and then aims at a
# turn recomputes this against the surface the panel leaves.
TRANSCRIPT_SURFACE_W=$(( WIN_W - RAIL_W ))
TRANSCRIPT_COLUMN_W=$(( TRANSCRIPT_MAX_W < TRANSCRIPT_SURFACE_W ? TRANSCRIPT_MAX_W : TRANSCRIPT_SURFACE_W ))
TRANSCRIPT_COLUMN_LEFT=$(( WIN_X + RAIL_W + (TRANSCRIPT_SURFACE_W - TRANSCRIPT_COLUMN_W) / 2 ))
TRANSCRIPT_COLUMN_RIGHT=$(( TRANSCRIPT_COLUMN_LEFT + TRANSCRIPT_COLUMN_W ))

# WHERE THE COMPOSER CARD IS, READ OFF THE WINDOW. §5.4 gives the card two
# restings: bottom-anchored under a transcript, and centred with the opening
# line over it on a session that holds no turns. A derivation that measures up
# from the window's foot is right in the first and aims at bare ground in the
# second, and the second is the state every take starts in: the click landed
# below the card, the editor never took focus, and the draft the preamble types
# reached nothing. So the card is measured rather than assumed, which also
# holds when an approval or a plan attaches over it and grows the object
# upward.
#
# The reading is the lowest tall band of the card's own ground in a strip down
# the middle of the session surface. The card is elevated ground, one flat tone
# across its whole measure; the surface behind it is one flatter, darker tone;
# the opening line over it is glyphs, which ink a few rows and leave the tone
# between them at the surface's. So a row of the card is a row where most of
# the strip sits a step above the surface tone and none of it is at a glyph's,
# and the run bar under the card draws no ground of its own to be confused
# with one.
COMPOSER_CARD_PY="${TMPDIR}/composer-card.py"
cat >"${COMPOSER_CARD_PY}" <<'PY'
import sys
from collections import Counter

width, height, strip_left, strip_width, surface_left, surface_width = (
	int(argument) for argument in sys.argv[1:7]
)
pixels = sys.stdin.buffer.read()
if len(pixels) < width * height:
	raise SystemExit(f"the capture read {len(pixels)} bytes, short of {width * height}")


def strip_of(row: int) -> bytes:
	start = row * width + strip_left
	return pixels[start : start + strip_width]


# The surface's own tone, as the tone most of the strip is: ground is the
# majority of any state's column, and a mode never lands between two tones the
# way a mean does.
ground = Counter(value for row in range(height) for value in strip_of(row)).most_common(1)[0][0]
low, high = ground + 8, ground + 90
carded = [
	sum(1 for value in strip_of(row) if low <= value <= high) * 2 >= strip_width
	for row in range(height)
]
bands: list[tuple[int, int]] = []
start = None
for row, lit in enumerate(carded):
	if lit and start is None:
		start = row
	elif not lit and start is not None:
		bands.append((start, row))
		start = None
if start is not None:
	bands.append((start, height))
tall = [band for band in bands if band[1] - band[0] >= 40]
if not tall:
	raise SystemExit(
		f"no band of the card's ground (tone {ground} + 8..90) is 40 rows tall in the strip at +{strip_left}"
	)
top, bottom = tall[-1]

# The card's own measure, across the row through the middle of that band.
middle = (top + bottom) // 2
row = pixels[middle * width + surface_left : middle * width + surface_left + surface_width]
centre = strip_left + strip_width // 2 - surface_left
left = centre
while left > 0 and low <= row[left - 1] <= high:
	left -= 1
right = centre
while right < surface_width - 1 and low <= row[right + 1] <= high:
	right += 1
print(top, bottom, surface_left + left, surface_left + right)
PY

# Sets COMPOSER_CARD_LEFT, COMPOSER_CARD_W and COMPOSER_CARD_BOTTOM from the
# window as it stands, and every aim placed against the card with them. Called
# once the session is on screen, and again by a scene that changed what the
# card holds -- an attachment row, an attached approval -- before it aims at
# the card again.
measure_composer_card() {
	local probe="${TMPDIR}/composer-card.png"
	probe_frame "${probe}"
	local strip_w=200
	local surface_left=$(( WIN_X + RAIL_W ))
	if (( strip_w > TRANSCRIPT_SURFACE_W / 3 )); then strip_w=$(( TRANSCRIPT_SURFACE_W / 3 )); fi
	local strip_left=$(( surface_left + (TRANSCRIPT_SURFACE_W - strip_w) / 2 ))
	# The capture's own dimensions, because a themed take insets the window in
	# a larger screen and every offset below is a pixel of that screen.
	local screen
	screen="$(magick identify -format '%w %h' "${probe}")"
	local reading
	if ! reading="$(magick "${probe}" -colorspace Gray -depth 8 gray:- |
		python3 "${COMPOSER_CARD_PY}" ${screen} \
			"${strip_left}" "${strip_w}" "${surface_left}" "${TRANSCRIPT_SURFACE_W}")"; then
		abandon_take "the-composer-card-is-locatable" \
			"the composer card was not found in the window: ${reading:-the reader printed nothing}"
	fi
	read -r CARD_TOP COMPOSER_CARD_BOTTOM CARD_LEFT CARD_RIGHT <<<"${reading}"
	COMPOSER_CARD_LEFT="${CARD_LEFT}"
	COMPOSER_CARD_W=$(( CARD_RIGHT - CARD_LEFT ))
	if (( COMPOSER_CARD_W < 200 )); then
		abandon_take "the-composer-card-is-locatable" \
			"the card measured ${COMPOSER_CARD_W}px across at row $(( (CARD_TOP + COMPOSER_CARD_BOTTOM) / 2 )), narrower than any authored composer"
	fi
	echo "scene: the composer card is ${COMPOSER_CARD_W}x$(( COMPOSER_CARD_BOTTOM - CARD_TOP ))" \
		"at +${COMPOSER_CARD_LEFT}+${CARD_TOP}" >&2

	# Where the run bar's own stop is, in root coordinates. The bar is the row
	# the session column places under the card, centred at the card's measure,
	# so its right edge is the card's; the stop is the bar's trailing child,
	# and the aim is one spacing step in from that edge, which is inside the
	# word at any authored label size rather than at a width this scene
	# decides. Vertically it is the middle of the authored bar height, in the
	# gap the column leaves under the card.
	RUN_BAR_Y=$(( COMPOSER_CARD_BOTTOM + (CARD_FOOT_PX - RUN_BAR_H) / 2 + RUN_BAR_H / 2 ))
	RUN_BAR_STOP_X=$(( COMPOSER_CARD_LEFT + COMPOSER_CARD_W - GUTTER_PX ))
	if (( RUN_BAR_Y <= COMPOSER_CARD_BOTTOM || RUN_BAR_Y >= WIN_Y + WIN_H )); then
		abandon_take "the-run-bar-is-locatable" \
			"the derived run bar aim ${RUN_BAR_Y} is not between the card's lower edge ${COMPOSER_CARD_BOTTOM} and the window's foot"
	fi

	# The model chip: the leading control of the card's footer row, which is
	# the last row inside the card. Vertically the aim is one spacing step
	# above the card's own lower edge, which is inside a row of any authored
	# control height; horizontally one spacing step into the chip, past its
	# rounded corner and onto the model's name.
	MODEL_CHIP_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H + GUTTER_PX ))
	MODEL_CHIP_Y=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - GUTTER_PX ))

	# Where the draft is typed: the editor line, above the footer row the chip
	# sits in. The card's authored resting height is a minimum and it draws
	# taller, so the aim is one spacing step below the card's own upper edge
	# when the card has grown past that resting height.
	COMPOSER_EDITOR_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H + GUTTER_PX ))
	COMPOSER_EDITOR_Y=$(( COMPOSER_CARD_BOTTOM - COMPOSER_BAND_H + CARD_FOOT_PX + GUTTER_PX ))
	if (( COMPOSER_EDITOR_Y <= CARD_TOP )); then
		COMPOSER_EDITOR_Y=$(( CARD_TOP + GUTTER_PX ))
	fi
	if (( COMPOSER_EDITOR_Y >= MODEL_CHIP_Y || COMPOSER_EDITOR_Y <= WIN_Y )); then
		abandon_take "the-editor-line-is-locatable" \
			"the derived editor aim ${COMPOSER_EDITOR_Y} is not above the footer row ${MODEL_CHIP_Y} inside the card at +${COMPOSER_CARD_LEFT}+${CARD_TOP}"
	fi
}

# ─── The Rectangles Every Frame Is Read Through ──────────────────────────────
# Two, because the session list prints each row's age: the composer band a
# draft is typed into, and the session surface above it, which is the
# transcript together with whatever an overlay or a panel draws over it. Every
# scene sourcing this preamble reads its own frames through them.
#
# The band is the card's own box together with the run bar under it, from the
# measurement rather than from the window's foot: on a session that holds no
# turns the card is centred (§5.4), and a band at the foot then reads the
# ground under it, which is still whatever the draft did not change.
SESSION_REGION_X=$(( WIN_X + RAIL_W ))
SESSION_REGION_W=$(( WIN_W - RAIL_W ))
composer_band_top() {
	local top=$(( COMPOSER_CARD_BOTTOM + CARD_FOOT_PX - COMPOSER_BAND_H ))
	if (( top > CARD_TOP )); then top="${CARD_TOP}"; fi
	printf '%s' "${top}"
}
composer_band_bottom() {
	local bottom=$(( COMPOSER_CARD_BOTTOM + CARD_FOOT_PX ))
	if (( bottom > WIN_Y + WIN_H )); then bottom=$(( WIN_Y + WIN_H )); fi
	printf '%s' "${bottom}"
}
composer_band_region() {
	local top bottom
	top="$(composer_band_top)"
	bottom="$(composer_band_bottom)"
	use_crop "${SESSION_REGION_X}" "${top}" "${SESSION_REGION_W}" "$(( bottom - top ))"
}
transcript_region() {
	local top
	top="$(composer_band_top)"
	use_crop "${SESSION_REGION_X}" "$(( WIN_Y + TITLEBAR_H ))" \
		"${SESSION_REGION_W}" "$(( top - WIN_Y - TITLEBAR_H ))"
}

# A per-mille floor for an overlay, since a palette is a surface rather than a
# control, and the bound a dismissal is waited out against.
OVERLAID_PER_MILLE=40

# Wait until the transcript is the frame the overlay opened over, pressing
# Escape while it is not.
#
# WHY: a fixed pause after the press publishes whatever the frame holds when it
# elapses. An overlay still opening when the press lands keeps that press, so
# the palette is drawn in the frame this scene names "dismissed" and the take
# fails on the reading -- about one run in four, with the palette plainly on
# screen in the published frame. Waiting on the pixels ends as soon as the
# overlay is gone and states what is still drawn when it is not.
#
# The screen is read before each press, because Escape on a composer with
# nothing over it reaches the draft: a dismissal that pressed unconditionally
# would clear the prompt the next reading counts the ink of.
#
# Bounded: three presses, each polled for a second and a half, then the take is
# abandoned. The reading the frames are judged on is taken afterwards and is
# unchanged -- this decides when to shoot, never whether the claim holds.
dismiss_over_transcript() { # <opened-over-shot> <reading-name>
	local baseline="$1" name="$2" press poll gone=""
	transcript_region
	for press in 1 2 3; do
		for poll in 1 2 3 4 5 6; do
			gone="$(screen_differs_from_shot_per_mille "${baseline}")"
			if [ "${gone}" -lt "$(( OVERLAID_PER_MILLE / 4 ))" ]; then
				return 0
			fi
			[ "${poll}" -eq 1 ] && k "Escape"
			pause 0.25
		done
	done
	abandon_take "${name}" \
		"the transcript is ${gone}/1000 from the frame the overlay opened over after three Escapes, so the overlay is still drawn"
}

# ─── Scene Interactions & Captures ───────────────────────────────────────────

# 1. Start a fresh session (primary-n -> ctrl+n) and capture composer idle state.
k "ctrl+n"
if ! native_session_ready created; then
	abandon_take "native-session-created" "native session-creation interaction produced no session within 10s"
fi
pause 2.0
measure_composer_card
COMPOSER_X="${COMPOSER_EDITOR_X}"
COMPOSER_Y="${COMPOSER_EDITOR_Y}"
move_px "${COMPOSER_X}" "${COMPOSER_Y}"
click
pause 0.5
shot idle

# 2. Type a realistic draft into the composer.
t "Summarize the project structure."
pause 1.2
shot typed-draft

# 3. Open the model picker overlay (primary-shift-m -> ctrl+shift+m).
k "ctrl+shift+m"
pause 0.8
shot model-picker-open

# 4. Dismiss the model picker; verify the typed draft is retained.
dismiss_over_transcript typed-draft "the-model-picker-closed"
shot model-picker-dismissed

# Exercise enter, exit, and reversal continuously rather than grading idle frames as motion.
for _ in $(seq 1 24); do
	k "ctrl+shift+m"
	pause 0.2
	k "Escape"
	pause 0.2
done
# The last cycle's Escape is a press like any other, so the slash steps below
# start from a transcript with nothing over it rather than from whatever the
# loop left drawn.
dismiss_over_transcript typed-draft "the-model-picker-closed"

# 5. Clear the composer and open the slash command palette.
# In Editor context, ctrl+a selects all, backspace deletes.
k "ctrl+a"
pause 0.2
k "BackSpace"
pause 0.4
t "/"
pause 0.8
shot slash-palette-open

# 6. Dismiss the slash palette.
dismiss_over_transcript model-picker-dismissed "the-slash-palette-closed"
shot slash-palette-dismissed

# The ink the typing drew. Counted in pixels rather than per mille: a line of
# 13px text inside a 110px band rounds to nothing.
composer_band_region
DRAFT_PX="$(shots_differ_pixels idle typed-draft)"
if [ "${DRAFT_PX}" -lt 150 ]; then
	abandon_take "the-draft-reached-the-composer" \
		"the composer band changed ${DRAFT_PX} pixels while a prompt was typed, so the keystrokes went somewhere else"
fi

# An overlay is read over the transcript, which is the region a picker and a
# slash palette both draw across. A ceiling derived from the open reading,
# since a dismissed overlay returns the region to the frame it opened over and
# an empty session's transcript is otherwise still.
#
# Read before the band, and that order is part of the guard: a picker still on
# screen reaches the footer row the band covers, so a band reading taken first
# reports a moved draft for an overlay that never closed.
transcript_region
PICKER_OPEN="$(shots_differ_per_mille typed-draft model-picker-open)"
if [ "${PICKER_OPEN}" -lt "${OVERLAID_PER_MILLE}" ]; then
	abandon_take "the-model-picker-opened" \
		"the transcript changed ${PICKER_OPEN}/1000 on primary-shift-m, under the ${OVERLAID_PER_MILLE} an overlay draws"
fi
PICKER_GONE="$(shots_differ_per_mille typed-draft model-picker-dismissed)"
if [ "${PICKER_GONE}" -ge "$(( PICKER_OPEN / 4 ))" ]; then
	abandon_take "the-model-picker-closed" \
		"the transcript is ${PICKER_GONE}/1000 from the frame the picker opened over, against ${PICKER_OPEN}/1000 while it was open"
fi

# The draft after the overlay closed, against the empty composer it was typed
# into and against the frame it was typed in. Both readings are needed: a
# cleared draft leaves the band back at idle, and a draft the overlay retyped
# or shifted leaves it at neither.
composer_band_region
KEPT_PX="$(shots_differ_pixels idle model-picker-dismissed)"
if [ "${KEPT_PX}" -lt "$(( DRAFT_PX / 2 ))" ]; then
	abandon_take "the-draft-outlived-the-picker" \
		"the band holds ${KEPT_PX} pixels of ink against the ${DRAFT_PX} the typing drew, so the model picker took the draft with it"
fi
MOVED_PX="$(shots_differ_pixels typed-draft model-picker-dismissed)"
if [ "${MOVED_PX}" -gt "$(( DRAFT_PX / 4 ))" ]; then
	abandon_take "the-draft-came-back-unchanged" \
		"${MOVED_PX} pixels of the band differ from the frame the draft was typed in, over the ${DRAFT_PX} the typing drew"
fi

transcript_region
SLASH_OPEN="$(shots_differ_per_mille model-picker-dismissed slash-palette-open)"
if [ "${SLASH_OPEN}" -lt "${OVERLAID_PER_MILLE}" ]; then
	abandon_take "a-slash-opened-the-commands" \
		"the transcript changed ${SLASH_OPEN}/1000 when the draft opened with a slash, under the ${OVERLAID_PER_MILLE} an overlay draws"
fi
SLASH_GONE="$(shots_differ_per_mille model-picker-dismissed slash-palette-dismissed)"
if [ "${SLASH_GONE}" -ge "$(( SLASH_OPEN / 4 ))" ]; then
	abandon_take "the-slash-palette-closed" \
		"the transcript is ${SLASH_GONE}/1000 from the frame the palette opened over, against ${SLASH_OPEN}/1000 while it was open"
fi
echo "scene: draft ${DRAFT_PX}px, kept ${KEPT_PX}px, moved ${MOVED_PX}px," \
	"picker ${PICKER_OPEN}/1000 open ${PICKER_GONE}/1000 closed," \
	"slash ${SLASH_OPEN}/1000 open ${SLASH_GONE}/1000 closed" >&2

# ─── Typing A Prompt Where The Composer Actually Is ──────────────────────────
# Every scene that runs a turn types a prompt into the composer, and the aim it
# clicks first decides whether the keystrokes reach the editor at all. A click
# that lands outside the card focuses the region it hit — the transcript
# carries a key context of its own — and the typing then goes to a surface with
# no draft, so `Return` submits nothing and the take fails ninety seconds later
# reporting a turn that never ran. A scene that restated the aim as a number
# recorded exactly that: a click 270px above the card, `status=Unknown,
# messages=0`, and a composer still holding the slash the preamble left.
#
# So the aim is the one the preamble derived from the token files, the draft is
# read back before it is sent, and the reading is what fails: the guard names
# the keystrokes, not the model.
COMPOSER_BAND_CROP="${SESSION_REGION_W}x${COMPOSER_BAND_H}+${SESSION_REGION_X}+$(( WIN_Y + WIN_H - COMPOSER_BAND_H ))"

type_prompt() { # <text> [floor-pixels]
	local text="$1" floor="${2:-400}" empty="${TMPDIR}/frame-compare/prompt-empty.png" drew
	move_px "${COMPOSER_X}" "${COMPOSER_Y}"
	click
	k "ctrl+a"
	k "BackSpace"
	pause 0.3
	probe_frame "${empty}"
	t "${text}"
	pause 0.6
	drew="$(screen_differs_from_frame_pixels_at "${empty}" "${COMPOSER_BAND_CROP}")"
	echo "scene: the prompt drew ${drew} pixels of draft" >&2
	if [ "${drew}" -lt "${floor}" ]; then
		abandon_take "the-prompt-reached-the-draft" \
			"the composer band changed ${drew} pixels while the prompt was typed, under the ${floor} a line of prose inks, so the keystrokes reached something other than the editor"
	fi
}

submit_prompt() { # <text> [floor-pixels]
	type_prompt "$@"
	k "Return"
}

# ─── The Tints A Surface Paints While It Holds Something ─────────────────────
# A `[tint.<role>]` fill is painted by one thing and nothing else in the
# window paints it, so a count of that fill inside a crop is a reading of how
# many of them the crop is reporting: `tint.working` is the `Working` chip a
# running turn carries, `tint.approve` is the edge of a decision card waiting
# for an answer. The fill is read from the theme this checkout ships rather
# than restated as a literal, so a retheme cannot make a scene silently stop
# finding what it is counting, and the count is refused rather than defaulted
# when the reading is not a number.
tint_fill_pixels() { # <tint-section> <png> <crop> -> pixels of that fill inside the crop
	local section="$1" png="$2" crop="$3" fill counted
	fill="$(python3 "${BASH_SOURCE[0]%/*}/token_px.py" \
		--text themes/dark.toml "${section}.fill" 2>/dev/null || true)"
	case "${fill}" in
		'#'[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]) ;;
		*)
			abandon_take "tint-known" \
				"the shipped dark theme states no [${section}] fill, and reported '${fill}'"
			;;
	esac
	counted="$(magick "${png}" -crop "${crop}" +repage \
		-fuzz 6% -fill white -opaque "${fill}" -fill black +opaque white \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "tint-countable" \
				"counting [${section}] in ${png} reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

working_tint_pixels() { # <png> <crop> -> pixels of the working fill inside the crop
	tint_fill_pixels "tint.working" "$@"
}

approve_tint_pixels() { # <png> <crop> -> pixels of a waiting decision's edge inside the crop
	tint_fill_pixels "tint.approve" "$@"
}

# ─── What A Plan Card Is On The Screen ───────────────────────────────────────
# Every attached card is grounded in `[role] float` and bordered in the ink of
# the tint that names its kind, so `[tint.plan] ink` is the colour a plan card
# is ringed with and no other card kind carries. It offers its affirmative
# answer filled with `[role] accent`, and nothing else attached above the
# composer paints that pair. So one pass over the band a card can occupy
# reports both: the rows where the ring crosses at least half the card's
# measure, which are the card's own edges, and the accent between those edges,
# which is the answer it offers. A band with no card reports no edges, which is
# how a scene reads the absence of one rather than inferring it from a low
# count.
#
# Both colours are read from the theme this checkout ships, so a retheme moves
# the reading with it.
theme_colour() { # <dotted> -> the colour the shipped dark theme states there
	local found
	found="$(python3 "${BASH_SOURCE[0]%/*}/token_px.py" --text themes/dark.toml "$1" 2>/dev/null || true)"
	if [ -z "${found}" ]; then
		abandon_take "the-theme-is-readable" "the shipped dark theme states no $1"
	fi
	printf '%s' "${found}"
}

plan_card_reading() { # <png> <card-band-crop> <card-width> -> "RING_PX TOP BOTTOM ACCENT_PX"
	local dump="${TMPDIR}/frame-compare/plan-card-reading.txt" ring accent
	mkdir -p "${TMPDIR}/frame-compare"
	ring="$(theme_colour tint.plan.ink)"
	accent="$(theme_colour role.accent)"
	magick "$1" -crop "$2" +repage txt:- >"${dump}"
	python3 - "${dump}" "${ring#\#}" "${accent#\#}" "$3" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")


def rgb(text):
	return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def near(colour, wanted, tolerance):
	return all(abs(a - b) <= tolerance for a, b in zip(colour, wanted))


ring, accent = (rgb(argument.upper()) for argument in sys.argv[2:4])
width = int(sys.argv[4])
# The plan ring's nearest neighbour is the foreground, twenty steps away on
# every channel, so three is far under it and cannot collect a glyph. The
# accent's nearest neighbour is the focus colour, twenty-seven away on one
# channel.
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

# Where the affirmative answer is drawn, so a scene presses the card's own
# control rather than a point it computed from the composer.
#
# The composer is not where it was. A card attaches above it and the stack is
# laid out as one, so a session whose transcript is empty draws that stack
# centred and the composer sits lower with a card up than without one: a press
# aimed at the composer's trailing control from a measurement taken before the
# card arrived lands in the gap between them and answers nothing. The accent
# between the ring's own edges is the answer the card offers, and its middle is
# the only point that moves with the card.
plan_answer_centre() { # <png> <card-band-crop> <card-width> -> "X Y" on the screen
	local dump="${TMPDIR}/frame-compare/plan-answer-centre.txt" accent ring offsets
	mkdir -p "${TMPDIR}/frame-compare"
	ring="$(theme_colour tint.plan.ink)"
	accent="$(theme_colour role.accent)"
	offsets="${2#*+}"
	magick "$1" -crop "$2" +repage txt:- >"${dump}"
	python3 - "${dump}" "${ring#\#}" "${accent#\#}" "$3" \
		"${offsets%%+*}" "${offsets##*+}" <<'PY'
import re
import sys

PIXEL = re.compile(r"^(\d+),(\d+): \([^)]*\)\s+#([0-9A-Fa-f]{6})")


def rgb(text):
	return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def near(colour, wanted, tolerance):
	return all(abs(a - b) <= tolerance for a, b in zip(colour, wanted))


ring, accent = (rgb(argument.upper()) for argument in sys.argv[2:4])
width, left, top_offset = (int(argument) for argument in sys.argv[4:7])
ring_rows, accent_pixels = {}, []
for line in open(sys.argv[1], encoding="ascii"):
	found = PIXEL.match(line)
	if not found:
		continue
	column, row = int(found.group(1)), int(found.group(2))
	colour = rgb(found.group(3).upper())
	if near(colour, ring, 3):
		ring_rows[row] = ring_rows.get(row, 0) + 1
	elif near(colour, accent, 10):
		accent_pixels.append((column, row))

edges = sorted(row for row, count in ring_rows.items() if count >= width // 2)
if not edges:
	raise SystemExit("no ringed card in the band")

inside = [(x, y) for x, y in accent_pixels if edges[0] < y < edges[-1]]
if not inside:
	raise SystemExit("the ringed card offers no accent-filled answer")

columns = [x for x, _ in inside]
rows = [y for _, y in inside]
print(
	(min(columns) + max(columns)) // 2 + left,
	(min(rows) + max(rows)) // 2 + top_offset,
)
PY
}
