#!/usr/bin/env bash
# The context report, a compaction, and the report again.
#
# The row exists to show that the window is measured rather than guessed, and that
# compacting it is a visible operation with a before and an after.
#
# Two earlier takes recorded refusals instead, and both were the product being
# right. On the 131k row the session reached 22k and `/compact` answered "nothing to
# compact (session too small)". On a 32k row it reached 25k and compaction stood
# itself down to avoid a loop, because the system prompt and the tool schemas are
# 18.6k of that 25k and the most recent turn alone could not be reduced further.
# What compaction works on is MESSAGES, so the window is not the thing to shrink:
# the message half has to be the large half. Hence the 32k row and a dozen real
# turns, which is the only way a small project fills a window with conversation.
#
# The recorder profile carries the other half of this: a recent-tail budget the 33k
# window can hold, and an auto-compaction threshold at 95% so the fill reaches a
# gauge worth photographing before maintenance takes it. With the shipped auto
# threshold the session compacted itself twice during the fill, and the pair of
# reports either side of `/compact` then differed by a thousand tokens.
settle 20
shot idle

submit "reply with the single word ready"
settle 35

# A dozen turns against the same small project. Each answer is a paragraph, so the
# message total climbs while the system half stays where it is.
for question in \
	"what does clampToWindow in src/utils.ts do at each boundary?" \
	"describe the token bucket in src/rate-limiter.ts in your own words" \
	"what does the first test in src/rate-limiter.test.ts pin?" \
	"what does the second test pin, and why is 0.999 in it?" \
	"what happens in take() when elapsed is zero?" \
	"what happens when a caller passes a cost larger than the capacity?" \
	"what does parse in src/parser.ts reject?" \
	"which of these files has no test, and what would its first test assert?" \
	"if refillPerSecond were zero, which branch would every call take?" \
	"name one edge case none of the tests cover" \
	"summarise the project in three sentences" \
	"which file would you change first to add a sliding window, and why?"; do
	submit "${question}"
	settle 30
done
shot filled

slash "/context"
settle 8
shot context-before

slash "/compact"
settle 90
shot compacted

slash "/context"
settle 8
shot context-after
