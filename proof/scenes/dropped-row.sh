#!/usr/bin/env bash
# One loss, in one voice.
#
# Before: a row that says content is gone wore the fold row's clothes. The
#         extension inspector wrote `(truncated at line 20)` and `(truncated at
#         line 15)` in the same quiet weight the row above it uses for content
#         that is still held, with no count and no reason, so a reader could not
#         tell the row that expands from the row that never will.
# After:  every one of those rows is the product's one dropped row -- `… 14 lines
#         dropped (preview limit)` -- counted, caused, and in the weight a loss
#         takes, next to a fold row that keeps its own quiet weight and its own
#         key.
#
# Two surfaces, because the inspector draws this row twice under two different
# cuts and both were in the fold row's weight: a context file cut at twenty lines
# and a skill instruction cut at fifteen. The execution footer, which draws the
# loss and the offer one line apart, is asserted in the class's suite instead:
# reaching it in a recording needs a command that streams past the retained cap,
# and the seconds that takes put the footer off the bottom of the panel this
# scene photographs.
#
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_EXTENSION_PREVIEWS=1 \
#     proof/docker/record-x11.sh proof/scenes/dropped-row.sh
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_EXTENSION_PREVIEWS=1 \
#     PROOF_BASE_REF=<the commit>~1 proof/docker/record-x11-before.sh proof/scenes/dropped-row.sh
#
# The floor is zero because the take is still: one panel, a dozen keystrokes and
# one command.
#
# No model and no network: the panel reads the seeded files through the product's
# own discovery, and the command runs in the product's own shell.

settle 18
shot idle

# --- 1. the inspector, on a context file longer than its preview -------------
#
# needle-source: Extension Control Center -- the dashboard title, from
# modes/components/extensions/extension-dashboard.ts.
slash "/extensions"
expect_screen "Extension Control Center" 30 "the-extensions-panel-never-opened"
settle 4

# The list filters as you type, so the query is how a row is reached without
# knowing where the panel put it.
t "AGENTS"
settle 3
# needle-source: Preview: -- the section label #renderFilePreview writes, from
# modes/components/extensions/inspector-panel.ts.
expect_screen "Preview:" 20 "the-inspector-never-previewed-the-context-file"

# The pane is taller than the panel, and it scrolls on the wheel only, so the row
# under the twentieth line of the file is reached with the pointer. The count
# clamps at the bottom, so more notches than the pane has rows is safe.
point 20 90
wheel_down 26
settle 3
# needle-source: ## Tests -- the heading on the twentieth line of the AGENTS.md
# the recorder seeds, from proof/docker/seed-extension-previews.sh. Its presence
# is what puts the row under the cut on screen.
expect_screen "## Tests" 20 "the-context-file-preview-never-reached-its-cut"
shot context-file

# --- 2. the same inspector, on a skill instruction ---------------------------
k Escape
settle 2
slash "/extensions"
expect_screen "Extension Control Center" 30 "the-extensions-panel-never-reopened"
settle 4
t "release-audit"
settle 3
# needle-source: Instruction: -- the section label #renderSkillContent writes,
# from modes/components/extensions/inspector-panel.ts.
expect_screen "Instruction:" 20 "the-inspector-never-previewed-the-skill"

point 20 90
wheel_down 26
settle 3
# needle-source: is what tested it before the tag existed. -- the fifteenth line
# of the seeded skill instruction, the last one the preview keeps.
expect_screen "is what tested it before the tag existed." 20 "the-skill-preview-never-reached-its-cut"
shot skill

k Escape
settle 3
shot closed
