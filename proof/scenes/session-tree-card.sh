#!/usr/bin/env bash
# The session tree card, on a session that actually forked.
#
# Nothing here waits for a model. `proof/docker/seed-session-tree.ts` writes a
# branched session through the product's own SessionManager before the terminal
# starts -- a trunk, an abandoned attempt under a label, and the branch that was
# kept -- and the recorder is launched with `--continue`, so the CLI resumes it
# and `/tree` opens on the tree the seeder left:
#
#   SCENE_COMMAND="bun /repo/packages/coding-agent/src/cli.ts --continue \
#     --model local/qwen2.5-1.5b" proof/record.sh --pair proof/scenes/session-tree-card.sh
#
# Three frames, each a state the card can be in: the card as it opens, one row
# down from the leaf, and the same tree with tool rows filtered out. The keys are
# the same in both arms, so a pair differs only where the card does.

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

# --- out --------------------------------------------------------------------
k Escape
settle 3
