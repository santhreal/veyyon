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
settle 100
shot agents

slash "/agents"
settle 8
shot agent-control
k Escape
sleep 1

slash "/exit"
settle 6

# The app is gone and the shell it was started from is back, which is where the inspector
# lives.
# A login shell has no input debounce of its own, so the rate the app tolerates doubles
# characters here. The two commands below are typed at the shell rate instead.
TYPE_DELAY=70
submit "veyyon prompt --sections --cwd ."
settle 10
shot prompt-sections

submit "veyyon prompt --statements --cwd . | head -30"
settle 10
shot prompt-statements
