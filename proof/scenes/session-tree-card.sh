#!/usr/bin/env bash
# The session tree card, on a session that actually forked.
#
# Nothing here waits for a model. `proof/docker/seed-session-tree.ts` writes a
# branched session through the product's own SessionManager before the terminal
# starts -- a trunk, an abandoned attempt under a label, and the branch that was
# kept -- and the recorder is launched with `--continue`, so the CLI resumes it
# and `/tree` opens on the tree the seeder left:
#
#   SCENE_MOTION_FLOOR=0 \
#     SCENE_COMMAND="bun /repo/packages/coding-agent/src/cli.ts --continue \
#     --model local/qwen2.5-1.5b" proof/record.sh --pair proof/scenes/session-tree-card.sh
#
# The card does not animate, so every frame after the open is identical and the
# motion gate reads the take as a stutter; SCENE_MOTION_FLOOR=0 accepts it. The
# frames are the evidence here, and the clip only carries them.
#
# Five frames, each a state the card can be in: the card as it opens, one row
# down from the leaf, the same tree with tool rows filtered out, a typed query
# over every entry, and the cursor at the last row. The keys are the same in both
# arms, so a pair differs only where the card does.

settle 20

# --- open the card ---------------------------------------------------------
# Escape dismisses the completion popup, which owns Return while it is open, and
# leaves the typed command for Return to submit.
slash "/tree"
expect_screen "Session Tree" 30 "tree-card"
settle 3
shot open

# --- one row off the leaf --------------------------------------------------
# The cursor starts on the current leaf. Moving up puts the cursor and the leaf
# mark on different rows, which is the only way a frame shows that they are two
# marks and not one.
k Up
settle 1
k Up
settle 2
shot cursor-off-leaf

# --- the same tree, narrowed ------------------------------------------------
# ctrl+O steps the filter forward one mode, to `no-tools`.
k ctrl+o
settle 2
shot filter-no-tools

# --- a query over the whole tree --------------------------------------------
# alt+a takes the filter to `all`, so the frame carries bookkeeping rows as well
# as messages and tool calls. `parse` occurs in a user prompt, in an assistant
# turn and in a tool argument, which is what shows that a match is painted
# wherever it falls on a row.
k alt+a
settle 2
t "parse"
settle 3
shot search-parse

# --- a query the kind column answers ----------------------------------------
# `read` is a tool name, so the only place it occurs on that row is the kind
# column: a frame of this query is the one that shows the column is searched and
# painted like the rest of the row.
k Escape
settle 1
t "read"
settle 3
shot search-kind

# --- the last row, in one key ------------------------------------------------
# Escape clears the query and leaves the card open. End goes to the last visible
# entry, which Left/Right reach only a screen at a time.
k Escape
settle 2
k End
settle 2
shot at-last-row

# --- out --------------------------------------------------------------------
k Escape
settle 3
