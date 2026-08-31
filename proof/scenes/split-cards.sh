#!/usr/bin/env bash
# The cards that split into a column and a pane, at whatever width the recorder
# was given.
#
#   /settings         a category column beside the rows of the active category.
#   /account manager  a provider column beside the accounts stored for it.
#   /advisor          the advisor roster beside the preview of the selected one.
#   /extensions       the extension list beside the inspector.
#
# The model hub is the fifth card of that shape and is NOT here. It has no command
# path: `/models` is an alias of `/model`, which opens the compact session picker,
# and `ModelHubComponent` is constructed at one site — the `/login` round-trip in
# selector-controller.ts, which reopens the hub after a provider login stores a
# credential. A scene cannot reach it without a real login, so the hub's geometry
# is held by test/a-model-hub-pane-is-never-starved-by-its-scope-column.test.ts,
# which drives the component itself across every width.
#
# WHY THIS SCENE EXISTS. Each of these cards used to size its column from its own
# names and hand the pane the remainder, which is invisible on a wide terminal and
# starves both halves on a narrow one. The column now yields its surplus down to a
# floor, and a card too narrow for both draws one full-width pane with the scope
# named in its title. That is a DEGRADATION change: two frames of a wide terminal
# say nothing about it, so this scene is written to be recorded once per width and
# reports the width it ran at in its own log line.
#
#   for px in 720 960 1200 1440; do
#     SCENE_WIDTH=${px} SCENE_MOTION_FLOOR=2 SCENE_SEED_ADVISORS=1 \
#       OUT_DIR="${PWD}/proof/captures/x11/w${px}" \
#       proof/docker/record-x11.sh proof/scenes/split-cards.sh
#     SCENE_WIDTH=${px} SCENE_MOTION_FLOOR=2 SCENE_SEED_ADVISORS=1 \
#       OUT_DIR="${PWD}/proof/captures/x11/before/w${px}" \
#       proof/docker/record-x11-before.sh proof/scenes/split-cards.sh
#   done
#
# OUT_DIR is per width in both arms: one directory cannot hold two takes whose
# frames share these mark names. The motion floor is lowered because the scene is
# deliberately still — it holds each card long enough to photograph it — and the
# default gate reads a still take as a stutter. SCENE_SEED_ADVISORS gives the
# advisor overlay a roster; its empty state has no preview pane to starve.
#
# Every guard is a card TITLE, or the stem of one. A title is the one string on
# these surfaces that survives every width in the sweep and both arms of the pair:
# a row label is cut by the narrow arm, and a footer chip is a different chip once
# the strip wraps. The titles come from the components themselves —
# `renderModalShell({ title: … })` in settings-selector.ts, model-hub.ts,
# account-manager.ts, advisor-config.ts and extensions/extension-dashboard.ts —
# and the stacked variants prefix the same stem (`Accounts › Anthropic`), so the
# stem is what is matched rather than the whole line.

settle 18

# --- /settings: the category column ---------------------------------------
slash "/settings"
# needle-source: Settings -- the card title, settings-selector.ts.
expect_screen "Settings" 30 "the-settings-card-never-opened"
settle 4
shot settings

# Left asks for the categories. On a stacked card that swaps which pane holds the
# frame, and the title states the category the rows belonged to; on a split card it
# moves the focus and nothing reflows. Both are the claim.
k Left
settle 3
shot settings-categories
k Escape
settle 2

# --- /account manager: the provider column --------------------------------
slash "/account manager"
# needle-source: Accounts -- the card title, account-manager.ts, and the stem of
# the stacked `Accounts › <provider>`.
expect_screen "Accounts" 30 "the-account-manager-never-opened"
settle 4
shot accounts
k Escape
settle 2

# --- /advisor: the roster beside its preview ------------------------------
# Needs SCENE_SEED_ADVISORS=1 for a roster with entries; the empty state has no
# preview pane to starve.
slash "/advisor configure"
# needle-source: Advisor -- the stem of `Advisor Configuration`, advisor-config.ts.
expect_screen "Advisor" 30 "the-advisor-overlay-never-opened"
settle 4
shot advisor
k Escape
settle 2

# --- /extensions: the list beside the inspector ---------------------------
slash "/extensions"
# needle-source: Extension -- the stem of `Extension Control Center`,
# extensions/extension-dashboard.ts.
expect_screen "Extension" 30 "the-extension-dashboard-never-opened"
settle 4
shot extensions
k Escape
settle 3
shot closed
