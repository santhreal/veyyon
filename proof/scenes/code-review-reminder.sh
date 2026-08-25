#!/usr/bin/env bash
# The same scene records the setting at its default and with
# `edit.critiqueCodeMutations: true` seeded before launch. It then drives two
# real code-file writes in one model turn so the enabled arm reaches the
# post-edit review continuation.
settle 16
submit "/settings"
settle 4

t "post-edit code review"
settle 3
shot setting

k Escape
settle 1
k Escape
settle 2

submit "Create src/review-alpha.ts and src/review-beta.ts with one distinct exported string constant in each file. After both writes, report implementation complete without reviewing the files unless a system reminder requests a review."
settle 90
shot outcome
