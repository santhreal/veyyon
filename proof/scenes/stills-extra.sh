#!/usr/bin/env bash
# The two surfaces the long take does not reach, captured as frames in the same chrome.
#
# Workers, because the take's session is one agent doing one job and spawning two more
# would double its length for one panel. The prompt inspector is not a session surface at
# all -- it is a subcommand that prints tables -- so it is reached through the shell the
# scene is given rather than the app.
#
# Both are stills. Neither surface moves once it is on screen, and a clip of a table is a
# screenshot with a frame rate.
settle 10

submit "use two task agents in parallel: one inspects src/rate-limiter.ts and one inspects src/rate-limiter.test.ts. Each reports one concise observation. Neither edits anything."
settle_idle 260 8 2 20
shot agents

slash "/agents"
settle 8
shot agent-control
k Escape
sleep 1

# THE INSPECTOR IS NOT HERE ANY MORE. This scene used to type `/exit` and then run
# `veyyon prompt` in "the shell the app was started from" -- but the app IS the window's
# process (xsession.sh execs SCENE_COMMAND), so exiting it closed the terminal, and both
# frames published as a photograph of the empty backdrop. They were byte-identical, which
# is what finally gave it away. `veyyon` was not on PATH in that container either, so the
# commands could not have run even with a shell to run them in.
#
# proof/scenes/prompt-architecture.sh already covers those two surfaces: it is given a
# shell as its window process and calls the CLI through `bun`, which is the path that
# exists in the image.
