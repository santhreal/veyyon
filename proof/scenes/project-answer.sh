#!/usr/bin/env bash
# A question about the project, answered from the project.
#
# The gallery row this replaces was a 1.5B answering from the prompt alone on a
# black terminal, which proves nothing about a coding tool: any chat window can
# print a paragraph. Here the model has to find the file, read it, and answer
# about the boundary the file actually implements, so the recording carries a read
# block with its rail and then an answer that names what the code does.
settle 20
shot idle

# The first turn pays for prompt evaluation. A demo should not open on a spinner.
# The server is warmed by the runner before the recording starts, with a request that
# never reaches the screen. This scene used to spend its first turn asking the model to
# say "ready", which paid for prompt evaluation in full view: the published row opened
# on a question nobody asked and an answer that means nothing.

submit "read src/rate-limiter.ts and its test, then answer in one short paragraph: what does RateLimiter do, and who owns the refill boundary?"
settle 50
shot reading
settle 45
shot answer

# End on the transcript rather than an empty composer.
wheel_up 6
sleep 1.5
shot scrolled
