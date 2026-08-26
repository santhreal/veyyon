#!/usr/bin/env bash
# The `/providers` account card gains a provider filter and loses its balancing toggle.
#
# Before: the sidebar lists every provider and there is no way to narrow it. The
#         footer carries `b balancing`, a second writer for a value the settings
#         screen already owns, and typing a letter fires whatever the card binds
#         it to.
# After:  `ctrl+s` enters a filter, the query row appears above the list, typing
#         narrows the sidebar, and the footer swaps its chips for the ones the
#         mode answers. `b balancing` is gone: Settings -> Providers -> Accounts
#         is the one place the value is edited.
#
# The differential lives in three pairs of frames, and each guard is written in
# the direction its own arm is true in, because no assertion here holds on both
# sides:
#
#   card-open        the footer, which is where the two chip sets differ.
#   search-open      the query row, which exists on one arm only.
#   search-filtered  the sidebar with one provider left, against the full list.
#
# The before arm types nothing into the card: on main the same keystrokes are
# shortcuts, so `anth` would fire add-account and then two more actions on top of
# it, and the frame would photograph a modal instead of the list it is there to
# show. It holds the unfiltered list instead, which is exactly what main does
# with the filter its operator cannot reach.
#
#   proof/docker/record-x11.sh proof/scenes/providers-search.sh
#   proof/docker/record-x11-before.sh proof/scenes/providers-search.sh
#
# No model, no network and no credentials: the sidebar lists the providers the
# build knows about whether or not any of them holds an account, which is the
# list the filter acts on.

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
if [ "${ARM}" = "before" ]; then
	expect_screen "b balancing" 30 "before-arm-has-no-balancing-chip"
else
	expect_screen "ctrl+s search" 30 "after-arm-has-no-search-chip"
	expect_missing "b balancing" "after-arm-still-offers-the-balancing-toggle"
fi
shot card-open

# --- 2. ctrl+s, and the query row it opens ----------------------------------
#
# The before arm sends the same key. Nothing on main is bound to it, so the card
# stands still, which is the frame that makes the pair mean something.
k ctrl+s
settle 3
if [ "${ARM}" = "before" ]; then
	expect_missing "Search:" "before-arm-opened-a-filter"
	expect_missing "type to filter" "before-arm-opened-a-filter"
else
	expect_screen "type to filter" 30 "after-arm-never-opened-the-filter"
	expect_screen "esc exit search" 30 "after-arm-kept-the-idle-footer"
fi
shot search-open

# --- 3. the query, and the sidebar it leaves behind -------------------------
if [ "${ARM}" = "before" ]; then
	# Main has no filter, so this arm photographs the list the operator is stuck
	# with. Typing here would fire shortcuts, so it types nothing.
	expect_screen "Anthropic" 30 "before-arm-lost-the-provider-list"
	expect_screen "OpenAI" 30 "before-arm-lost-the-provider-list"
else
	t "anth"
	settle 3
	expect_screen "Search: anth" 30 "after-arm-dropped-the-query"
	expect_screen "Anthropic" 30 "after-arm-filtered-away-the-match"
	expect_missing "OpenAI" "after-arm-kept-a-provider-the-query-excludes"
fi
shot search-filtered

# --- 4. esc leaves the filter, and the card is still open -------------------
#
# The chip says `esc exit search`, and the first escape has to mean that rather
# than closing the card underneath it.
k Escape
settle 3
expect_screen "Accounts" 30 "escape-closed-the-card-instead-of-the-filter"
if [ "${ARM}" != "before" ]; then
	expect_screen "OpenAI" 30 "leaving-the-filter-did-not-restore-the-list"
	expect_missing "Search:" "the-filter-survived-its-own-exit"
fi
shot search-closed
