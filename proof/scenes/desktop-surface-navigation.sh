#!/usr/bin/env bash
# Exercise shared command groups and focused destinations with the real GUI host.
set -euo pipefail
source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"
glide_px() {
	local x0="$1" y0="$2" x1="$3" y1="$4" steps="${5:-8}" delay="${6:-0.02}"
	local i
	for i in $(seq 0 "${steps}"); do
		move_px "$((x0 + (x1 - x0) * i / steps))" "$((y0 + (y1 - y0) * i / steps))"
		sleep "${delay}"
	done
}

glide_px "${COMPOSER_X}" "${COMPOSER_Y}" "$(( WIN_X + 120 ))" "$(( WIN_Y + 170 ))"
pause 0.25
shot queue-hover
glide_px "$(( WIN_X + 120 ))" "$(( WIN_Y + 170 ))" "${COMPOSER_X}" "${COMPOSER_Y}"
pause 0.25
shot queue-restored

# Type a multiline draft to verify preservation across shared navigation routes
click
k "ctrl+a"
pause 0.15
k "BackSpace"
pause 0.15
t "Multiline draft across Account, Settings, and Agents"
k "shift+Return"
t "Second row of preserved draft text"
pause 0.3
shot multiline-draft-active
# The capture uses the bundled typography at scale 1. Header target offsets
# are measured from its native frames; placement follows the current window.
read -r PALETTE_W TITLEBAR_H MARGIN < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
palette = tomllib.loads((root / "surface/palette.toml").read_text())
shell = tomllib.loads((root / "surface/shell.toml").read_text())
scale = tomllib.loads((root / "scale.toml").read_text())
print(palette["geometry"]["width_px"], shell["titlebar"]["height_px"], scale["spacing"]["s4"])
PY
)
PALETTE_LEFT=$(( WIN_X + (WIN_W - PALETTE_W) / 2 ))
PALETTE_RIGHT=$(( WIN_X + (WIN_W + PALETTE_W) / 2 ))
COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
COLUMNS_CENTER_Y=$(( WIN_Y + TITLEBAR_H + COLUMNS_H / 2 ))
DEST_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( DEST_H > 560 )); then DEST_H=560; fi
DEST_HEADER_Y=$(( COLUMNS_CENTER_Y - DEST_H / 2 + 26 ))
DEST_BACK_X=$(( PALETTE_LEFT + 43 ))
DEST_CLOSE_X=$(( PALETTE_RIGHT - 38 ))
PALETTE_ACCOUNT_HEADER_Y=$(( COLUMNS_CENTER_Y - 74 ))
PALETTE_ACCOUNT_BACK_X="${DEST_BACK_X}"
PALETTE_SETTINGS_HEADER_Y=$(( COLUMNS_CENTER_Y - 111 ))
PALETTE_SETTINGS_BACK_X="${DEST_BACK_X}"
k "ctrl+k"
pause 0.25
t "account"
pause 0.25
shot account-command
k "Return"
pause 0.25
shot account-group
k "Return"
pause 0.25
shot account-manager
glide_px "${COMPOSER_X}" "${COMPOSER_Y}" "${DEST_BACK_X}" "${DEST_HEADER_Y}"
pause 0.2
click
pause 0.25
shot account-parent-restored

# Click pointer on Back button in Account group palette to ascend to Commands
glide_px "${DEST_BACK_X}" "${DEST_HEADER_Y}" "${PALETTE_ACCOUNT_BACK_X}" "${PALETTE_ACCOUNT_HEADER_Y}"
pause 0.2
click
pause 0.25
shot commands-parent-restored

# Dismiss Commands palette to composer
pause 0.2
k "Escape"
pause 0.25
shot account-dismissed-to-composer
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# 2. Agents route: Commands -> Agents (Extensions) -> Back click -> Re-enter -> Close click
k "ctrl+k"
pause 0.25
t "agents"
pause 0.25
shot agents-command
k "Return"
pause 0.25
shot agents-surface

# Click pointer on Back button in Agents destination
glide_px "${COMPOSER_X}" "${COMPOSER_Y}" "${DEST_BACK_X}" "${DEST_HEADER_Y}"
pause 0.15
click
pause 0.25
shot agents-back-to-commands

# Re-enter Agents and click Close button directly from destination
k "Return"
pause 0.25
glide_px "${DEST_BACK_X}" "${DEST_HEADER_Y}" "${DEST_CLOSE_X}" "${DEST_HEADER_Y}"
pause 0.15
click
pause 0.25
shot agents-dismissed-to-composer
move_px "${COMPOSER_X}" "${COMPOSER_Y}"

# 3. Settings route: Commands -> Settings -> General -> Back pointer clicks -> Close click to composer
k "ctrl+k"
pause 0.25
t "settings"
pause 0.25
shot settings-command
k "Return"
pause 0.25
shot settings-group
k "Return"
pause 3
settings_group_png="${SCENE_LAST_SHOT_PNG:?Settings group frame is required}"
SCENE_LAST_SHOT_PNG=""
shot settings-general
if [ "${SCENE_ARM:-after}" = "before" ]; then
	# The baseline leaves General at the Settings group, so both arms take the
	# frame under one name and only this arm asserts what it holds: requiring the
	# baseline to open a destination it does not have would abandon every before
	# take.
	if ! cmp -s "${settings_group_png}" "${SCENE_LAST_SHOT_PNG}"; then
		abandon_take "settings-general" "baseline unexpectedly opened a different destination"
	fi
	return 0
fi
SETTINGS_SCROLL_X=$(( PALETTE_LEFT + PALETTE_W / 2 ))
glide_px "${COMPOSER_X}" "${COMPOSER_Y}" "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
wheel_down 12
pause 0.3
shot settings-general-scrolled
wheel_up 12
pause 0.3
shot settings-general-scroll-restored
glide_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}" "${DEST_BACK_X}" "${DEST_HEADER_Y}"
pause 0.15
click
pause 0.25
shot settings-parent-restored

# Click pointer on Back button in Settings group palette
glide_px "${DEST_BACK_X}" "${DEST_HEADER_Y}" "${PALETTE_SETTINGS_BACK_X}" "${PALETTE_SETTINGS_HEADER_Y}"
pause 0.15
click
pause 0.25
shot settings-commands-restored

# Dismiss Commands palette to composer
pause 0.15
k "Escape"
pause 0.25
shot surface-dismissed

# General page Escape ascends through Settings and Commands, then restores typing.
k "ctrl+k"
pause 0.25
t "settings"
pause 0.25
k "Return"
pause 0.25
k "Return"
pause 0.25
shot general-before-escape
k "Escape"
pause 0.25
shot general-escape-to-settings
k "Escape"
pause 0.25
shot settings-escape-to-commands
k "Escape"
pause 0.25
t " (focus restored)"
pause 0.25
shot general-escape-restores-draft-focus

# ─── What The Escape Ladder States ───────────────────────────────────────────
# The frames above are a claim about what Escape does on a focused page, and a
# scene that only writes them leaves the claim to whoever opens the gallery.
# The defect this ladder was written for dismissed the whole surface from the
# General page instead of ascending one step, which looks exactly like a
# working ascent until the two frames are compared.
#
# The palette column is the rectangle, because the session list prints each
# row's age and the composer blinks a caret.
use_crop "${PALETTE_LEFT}" "$(( WIN_Y + TITLEBAR_H ))" "${PALETTE_W}" "$(( COLUMNS_H - 140 ))"
ASCENDED_PER_MILLE=40
DISMISSED_PER_MILLE=40

ASCENT="$(shots_differ_per_mille general-before-escape general-escape-to-settings)"
if [ "${ASCENT}" -lt "${ASCENDED_PER_MILLE}" ]; then
	abandon_take "escape-ascended-off-the-general-page" \
		"the palette column changed ${ASCENT}/1000 on the first Escape, under the ${ASCENDED_PER_MILLE} a changed destination draws"
fi
STILL_OPEN="$(shots_differ_per_mille general-escape-to-settings surface-dismissed)"
if [ "${STILL_OPEN}" -lt "${DISMISSED_PER_MILLE}" ]; then
	abandon_take "escape-ascended-rather-than-dismissed" \
		"the frame after one Escape is within ${STILL_OPEN}/1000 of the dismissed surface, so Escape closed the whole hierarchy instead of ascending to Settings"
fi
SECOND_ASCENT="$(shots_differ_per_mille general-escape-to-settings settings-escape-to-commands)"
if [ "${SECOND_ASCENT}" -lt "${ASCENDED_PER_MILLE}" ]; then
	abandon_take "escape-ascended-from-settings-to-commands" \
		"the palette column changed ${SECOND_ASCENT}/1000 on the second Escape"
fi
ROOT_DISMISSED="$(shots_differ_per_mille settings-escape-to-commands general-escape-restores-draft-focus)"
if [ "${ROOT_DISMISSED}" -lt "${DISMISSED_PER_MILLE}" ]; then
	abandon_take "escape-at-the-root-dismissed-the-surface" \
		"the palette column changed ${ROOT_DISMISSED}/1000 on the third Escape, so the root stayed open"
fi

# The draft is what focus returning means: the text typed after the last
# Escape reached the composer, and nothing above it moved.
use_crop "$(( WIN_X + (WIN_W > 800 ? 256 : 0) ))" "$(( WIN_Y + WIN_H - 140 ))" \
	"$(( WIN_W - (WIN_W > 800 ? 256 : 0) ))" 140
TYPED="$(shots_differ_pixels surface-dismissed general-escape-restores-draft-focus)"
if [ "${TYPED}" -lt 150 ]; then
	abandon_take "the-composer-took-the-keyboard-back" \
		"the composer strip changed ${TYPED} pixels after the surface dismissed, so what was typed did not reach the draft"
fi
echo "scene: ascent ${ASCENT}/1000, still open ${STILL_OPEN}/1000, second ${SECOND_ASCENT}/1000," \
	"dismissed ${ROOT_DISMISSED}/1000, draft ${TYPED}px" >&2
