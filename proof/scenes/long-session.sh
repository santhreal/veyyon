#!/usr/bin/env bash
# A real session of the operator's, resumed, scrolled, and continued.
#
# The session is millions of tokens: tens of thousands of messages, tool calls,
# diffs, subagent transcripts, and eighty-seven earlier compactions. Two things
# are on trial. The first is the LOAD: how long the terminal sits there before
# the transcript is on screen. The second is the STREAM: whether an answer
# arriving token by token at the tail of a transcript that large costs more per
# frame than one at the tail of an empty session -- whether the size of what is
# above the window leaks into every frame.
#
# The model is the 1.5B on the container network, and it is small on purpose: a
# fast model hides a slow renderer behind its own latency.
#
# The same scene runs against a FRESH session as a control (SCENE_ARM=fresh).
# Same keys, same model, same terminal, nothing above the window. The two pty
# captures are what turn "streaming feels fine" into a number.

# The load. A 289MB session is read, parsed and rebuilt into a transcript here.
settle "${LOAD_SETTLE:-30}"

# Walk up into rows the app did not paint this frame -- the path that used to
# erase native scrollback and replay the whole transcript.
key_repeat Prior 6 0.5
sleep 1.5
key_repeat Next 6 0.5
sleep 1.5

# Continue the session. What matters is the tokens coming back, not what they
# say. On the resumed arm the app has to fit a multi-million-token history into
# a 65k window first, and it says so on screen while it does it.
submit "In one sentence: what is this session about?"
settle "${STREAM_SETTLE:-300}"

# Scroll again with the new answer in place: the tail moved, the history did
# not, and the two have to agree about where the boundary is.
key_repeat Prior 4 0.5
sleep 1
key_repeat Next 4 0.5
settle 6

# Quit the app rather than killing the terminal: `script` only returns when the
# app exits, and the byte counters are computed after it returns. A scene that
# ends by closing the window gets a video and no numbers.
submit "/exit"
sleep 6
