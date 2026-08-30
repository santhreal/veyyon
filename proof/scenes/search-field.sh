#!/usr/bin/env bash
# One search field, on the row a list draws for itself.
#
# Before: a list long enough to filter writes `Type to search`, and `Search: `
#         with the query, from inside the tui component. Every wizard step and
#         every picker in the product shows that row, in the hint colour, with
#         no mark saying a keystroke lands there.
# After:  the same row is the product's one field: the search glyph in the
#         theme's state accent, then the query. No caret here, because the card
#         that opens a field of its own owns the terminal's one cursor.
#
# The surface is the theme submenu inside `/settings`, which lists every bundled
# theme: ninety-odd rows against ten visible, so the status row is drawn on both
# arms and the frames differ only in what it says.
#
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/search-field.sh
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11-before.sh proof/scenes/search-field.sh
#
# The floor is zero because the take is deliberately still: one card, one
# submenu, four keystrokes and no animation.
#
# No model, no network and no credentials: the theme list is what the build
# carries. `titanium` is the control — it is a match for `tita` and the rows that
# are not are what say the filter did something.

ARM="${SCENE_ARM:-after}"

# The other half of `expect_screen`: a guard that must NOT be on screen. A row
# that kept the old label, or a list that never overflowed, renders a plausible
# frame and publishes.
expect_missing() {
	local needle="$1" mark="$2"
	if screen_text | grep -qF -- "${needle}"; then
		abandon_take "${mark}" "'${needle}' is on screen and this arm must not show it"
	fi
}

settle 18
shot idle

# --- 1. the settings card ---------------------------------------------------
slash "/settings"
expect_screen "Settings" 30 "the-settings-card-never-opened"
settle 4
shot settings-open

# --- 2. down to the theme row, and into its list ----------------------------
#
# The card's own field narrows the rows; the row this scene wants is the dark
# theme, whose submenu is the long list.
# needle-source: Dark Theme -- the label of the `theme.dark` setting, from
# config/settings-domains/appearance.ts.
t "dark theme"
settle 3
expect_screen "Dark Theme" 20 "the-theme-row-never-survived-the-query"
k Return
settle 4

# --- 3. the row the list draws for itself -----------------------------------
#
# Idle, before anything is typed into the submenu. This is the frame the change
# is about: the same row, in two grammars.
# needle-source: Type to search -- the idle status row select-list.ts writes in
# packages/tui when no field is supplied, which is the before arm.
if [ "${ARM}" = "before" ]; then
	expect_screen "Type to search" 20 "before-arm-drew-no-status-row"
else
	expect_screen "type to search" 20 "after-arm-drew-no-field"
	expect_missing "Type to search" "after-arm-still-writes-the-library-label"
fi
shot list-idle

# --- 4. the query, on the same row ------------------------------------------
#
# needle-source: Search: tita -- the filtered status row select-list.ts writes
# in packages/tui when no field is supplied, which is the before arm.
# needle-source: ⌕ tita -- the field: `icon.search` from modes/theme/symbols.ts
# followed by the query this scene types.
t "tita"
settle 3
if [ "${ARM}" = "before" ]; then
	expect_screen "Search: tita" 20 "before-arm-never-filtered"
else
	expect_screen "⌕ tita" 20 "after-arm-never-drew-the-field"
	expect_missing "Search: tita" "after-arm-still-writes-the-library-label-filtered"
fi
expect_screen "titanium" 20 "the-filter-left-no-matching-row"
shot list-typed

# --- 5. out, without disturbing the setting ---------------------------------
k Escape
settle 2
k Escape
settle 2
shot closed
