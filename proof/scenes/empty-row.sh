#!/usr/bin/env bash
# One empty row, in one voice.
#
# Before: the row a list shows when the query matched nothing is painted with the
#         list's keyboard-hint weight, which is what this product uses for `esc
#         to close` and not for a fact about the list, so the sentence reads as a
#         hint rather than as the list's own answer.
# After:  the same row is the product's one empty row: the weight every card's
#         no-match row uses, at the indent the rows it replaced sat at.
#
# Two surfaces, because two list kinds draw this row: the settings card's own
# list, and the theme submenu inside it — ninety-odd rows against ten visible, so
# it filters, and a query nothing matches empties it completely.
#
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/empty-row.sh
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11-before.sh proof/scenes/empty-row.sh
#
# The floor is zero because the take is still: one card, one submenu, a dozen
# keystrokes and no animation.
#
# No model, no network and no credentials: the theme list is what the build
# carries.

settle 18
shot idle

# --- 1. the settings card, filtered down to nothing --------------------------
#
# The card's own list is the surface the defect was worst on: it took the row
# from the list library, which paints it with the weight this product spends on
# keyboard hints.
#
# needle-source: No matching settings -- the row SettingsList draws in
# packages/tui when its filter leaves nothing.
slash "/settings"
expect_screen "Settings" 30 "the-settings-card-never-opened"
settle 4
t "zqxjv"
settle 3
expect_screen "No matching settings" 20 "the-card-filter-left-rows-on-screen"
shot card-empty

# --- 2. back to the rows, and into the theme submenu -------------------------
#
# needle-source: Dark Theme -- the label of the `theme.dark` setting, from
# config/settings-domains/appearance.ts.
key_repeat BackSpace 5 0.08
settle 3
t "dark theme"
settle 3
expect_screen "Dark Theme" 20 "the-theme-row-never-survived-the-query"
k Return
settle 4

# --- 3. a submenu with rows, for the height the empty one replaces -----------
#
# needle-source: titanium -- a bundled theme name, from modes/theme/themes.
expect_screen "titanium" 20 "the-theme-submenu-listed-nothing"
shot list-rows

# --- 4. the same query, on a select list this time ---------------------------
#
# needle-source: No matching items -- the row SelectList draws in packages/tui
# when its filter leaves nothing.
t "zqxjv"
settle 3
expect_screen "No matching items" 20 "the-submenu-filter-left-rows-on-screen"
shot list-empty

# --- 5. out, without disturbing the setting ---------------------------------
k Escape
settle 2
k Escape
settle 2
shot closed
