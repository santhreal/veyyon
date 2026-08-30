#!/usr/bin/env bash
# One overflow row, in one voice.
#
# Before: the anchored todo board counted the rows it stopped drawing as `… 4 more`,
#         a sentence that names no unit, while the surface four rows below it said
#         `… 80 more lines (ctrl+o to expand)` about the same fact.
# After:  the board says `… 4 more stages`, from the one owner every surface that
#         holds content back now draws its row through.
#
# The board is the fold this pair can photograph. Thirty-nine surfaces printed this
# fact and the class normalised every one of them onto the tool block's existing
# sentence, so the fold a user meets most often is byte-identical on both arms --
# deliberately, and the suite pins those bytes. The board is the surface whose own
# spelling moved and that a session reaches with no model in it.
#
#   SCENE_HEIGHT=700 SCENE_MOTION_FLOOR=0 SCENE_SEED_TODO_BOARD=1 \
#     SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --continue' \
#     proof/docker/record-x11.sh proof/scenes/todo-board-fold.sh
#   PROOF_BASE_REF=<fold-commit>~1 <same knobs> proof/docker/record-x11-before.sh …
#
# The height is the point: the anchored region is a third of the viewport, capped at
# fourteen rows, so a plan of nine stages overflows a short terminal and fits a tall
# one. A pair recorded at the default height would photograph a board with nothing
# held back and prove nothing about the row that changed.
#
# The floor is zero because the take is still: a resumed session, a board, and no
# keystrokes. No model, no network and no credentials -- the plan is seeded through
# the product's own session writer by proof/docker/seed-todo-board.ts and resumed
# with `--continue`.

settle 20

# needle-source: Todos -- the anchored board's own header, from
# modes/components/todo-board.ts.
expect_screen "Todos" 30 "the-resumed-session-drew-no-board"

# The row itself, guarded in the direction each arm is true in: the after arm must
# see the noun the class gave the row, and the before arm must see the sentence
# without it. Guarding both on the same needle would let one arm record the other's
# behaviour and call the pair proof.
#
# needle-source: more stages -- foldText(hidden, { noun: "stage" }) in modes/components/todo-board.ts
if [ "${SCENE_ARM}" = "before" ]; then
	expect_screen "more" 20 "the-board-held-nothing-back"
else
	expect_screen "more stages" 20 "the-board-held-nothing-back"
fi

shot board
