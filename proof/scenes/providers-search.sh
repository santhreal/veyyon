#!/usr/bin/env bash
# The `/providers` account card gains a provider filter and loses its balancing toggle.
#
# Before: the sidebar lists every provider and there is no way to narrow it. The
#         footer carries `b balancing`, a second writer for a value the settings
#         screen already owns, and a letter typed at the list fires whatever the
#         card binds it to.
# After:  `ctrl+s` enters a filter, a query row appears above the list, typing
#         narrows the sidebar to the providers that match, and the footer swaps
#         its chips for the ones the mode answers. `b balancing` is gone:
#         Settings -> Providers -> Accounts is the one place the value is edited.
#
# Both arms press the SAME keys, which is what makes the pair a differential
# rather than two takes. Every guard is written in the direction its own arm is
# true in, because no assertion here holds on both sides:
#
#   card-open        the footer, which is where the two chip sets differ.
#   search-open      the query row, which exists on one arm only.
#   search-typed     `anth` as a filter, against `anth` as four shortcuts: on
#                    main the `a` starts a login for the selected provider and
#                    the rest lands in its key prompt, which is the frame that
#                    says what an operator reaching for a filter got instead.
#
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11.sh proof/scenes/providers-search.sh
#   SCENE_MOTION_FLOOR=0 proof/docker/record-x11-before.sh proof/scenes/providers-search.sh
#
# The floor is zero because this take is deliberately still: a card, four
# keystrokes and no animation. Over 35 seconds that is 14 unique frames, which
# the motion gate rounds to 0 fps and would otherwise read as a stutter.
#
# No model, no network and no credentials: the sidebar lists the providers the
# build knows about whether or not any of them holds an account, which is the
# list the filter acts on. `Cerebras` is the control — it is visible in the
# unfiltered list and it is not a match for `anth`, so its absence is what says
# the filter did something and its return is what says the filter let go.

ARM="${SCENE_ARM:-after}"

# The other half of `expect_screen`: a guard that must NOT be on screen. A chip
# that survived the change, or a query row that never opened, renders a
# plausible frame and publishes.
expect_missing() {
	local needle="$1" mark="$2"
	if screen_text | grep -qF -- "${needle}"; then
		abandon_take "${mark}" "'${needle}' is on screen and this arm must not show it"
	fi
}

settle 18
shot idle

# --- 1. the card, and the footer that names what it can do ------------------
slash "/account manager"
expect_screen "Accounts" 30
settle 4
# needle-source: b balancing -- the footer chip this branch deletes from
# account-manager.ts, held at its main content for the before arm.
# needle-source: Cerebras -- a provider label from the catalog the card lists.
if [ "${ARM}" = "before" ]; then
	expect_screen "b balancing" 30 "before-arm-has-no-balancing-chip"
else
	expect_screen "ctrl+s search" 30 "after-arm-has-no-search-chip"
	expect_missing "b balancing" "after-arm-still-offers-the-balancing-toggle"
fi
expect_screen "Cerebras" 30 "the-provider-list-never-rendered"
shot card-open

# --- 2. ctrl+s, and the query row it opens ----------------------------------
#
# The before arm sends the same keys. Nothing on main answers `ctrl+s`, so only
# the focus move and the arrow change that frame, which is what makes this pair
# mean something.
k Left
pause 0.4
k ctrl+s
pause 0.4
k Down
settle 3
if [ "${ARM}" = "before" ]; then
	expect_missing "type to filter" "before-arm-opened-a-filter"
	expect_missing "Search:" "before-arm-opened-a-filter"
else
	expect_screen "type to filter" 30 "after-arm-never-opened-the-filter"
	expect_screen "esc exit search" 30 "after-arm-kept-the-idle-footer"
fi
shot search-open

# --- 3. the query, against the four shortcuts it used to be -----------------
t "anth"
settle 4
if [ "${ARM}" = "before" ]; then
	# On main `a` is add-account, so the query starts a login for the selected
	# provider and the remaining letters land in the prompt it opened.
	expect_missing "Search: anth" "before-arm-filtered-the-list"
else
	expect_screen "Search: anth" 30 "after-arm-dropped-the-query"
	expect_screen "Anthropic" 30 "after-arm-filtered-away-the-match"
	expect_missing "Cerebras" "after-arm-kept-a-provider-the-query-excludes"
fi
shot search-typed

# --- 4. esc leaves the filter and the card stays open -----------------------
#
# The chip says `esc exit search`, and the first escape has to mean that rather
# than closing the card underneath it. The before arm has no filter to leave, so
# there is nothing here for it to prove and no frame to take.
if [ "${ARM}" != "before" ]; then
	k Escape
	settle 3
	expect_screen "Accounts" 30 "escape-closed-the-card-instead-of-the-filter"
	expect_screen "Cerebras" 30 "leaving-the-filter-did-not-restore-the-list"
	expect_missing "Search:" "the-filter-survived-its-own-exit"
fi
