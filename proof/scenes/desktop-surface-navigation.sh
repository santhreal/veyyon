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
if [ "${SCENE_ARM:-after}" = "before" ]; then
	# The baseline leaves General at the Settings group. Require that failure
	# instead of requiring a destination the baseline cannot open.
	settings_group_png="${SCENE_LAST_SHOT_PNG:?Settings group frame is required}"
	SCENE_LAST_SHOT_PNG=""
	shot settings-general
	if ! cmp -s "${settings_group_png}" "${SCENE_LAST_SHOT_PNG}"; then
		abandon_take "settings-general" "baseline unexpectedly opened a different destination"
	fi
	return 0
fi
shot settings-general
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
