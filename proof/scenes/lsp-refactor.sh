#!/usr/bin/env bash
# A rename the language server computes, and the suite that says it landed.
#
# The claim the gallery row makes is that a symbol is renamed the way an IDE renames
# it -- the references come from a language server, not from a search for a string --
# so the recording has to show the `lsp` block naming the action and the files it
# rewrote, and then a test run against the renamed code. A recording that stops at
# the block is a recording of a request.
#
# Two things have to be true of the container for this scene to exist at all, and
# both are set up rather than assumed: `typescript-language-server` resolves on PATH
# (Dockerfile.recorder installs it, with typescript pinned to 5.x because the server
# drives tsserver.js) and the fixture carries package.json and tsconfig.json, because
# `loadConfig` offers a server only when its root markers exist in the session's
# directory. Measured against the seeded fixture through the product's own client,
# the rename comes back as four edits over two files: the class declaration, and the
# import plus two constructions in the test.
#
# The prompt names the tool, its action and its arguments, and then names what not to
# do, because two earlier takes recorded the model answering the question another way.
# The first was asked to "rename the symbol using the language server": it renamed the
# FILE too, by hand, and left src/token-bucket.ts with a syntax error and a red suite.
# The second was asked for the references first, decided the server's answer looked
# repetitive, offered to search differently, and then reached for ast_edit -- which
# renamed the declaration and nothing else, so the suite went red again. A row about
# a language server cannot be recorded by hoping a model picks one.
#
# Two short turns rather than one long one. This model's window is 32k and the system
# prompt with the tool schemas is about 19k of it, so a turn carrying a references
# dump, a rename and a test run crosses the automatic-maintenance threshold, and both
# earlier takes recorded the product correctly reporting that compaction could not
# free enough to help. The claim needs a rename and a green suite, and neither needs a
# long turn.
settle 20
shot idle

submit "reply with the single word ready"
settle 35

submit "Call the lsp tool once, with action rename, file src/rate-limiter.ts, symbol RateLimiter, new_name TokenBucket, apply true. Use no other tool: no edit, no write, no ast_edit, no bash."
settle 110
shot rename

submit "Now run bun test src/rate-limiter.test.ts with the bash tool and tell me in one sentence whether the suite passes."
settle 90
shot test-run

wheel_up 8
sleep 1.5
shot scrolled
