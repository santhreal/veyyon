#!/usr/bin/env bash
# A turn that recovered through retries says what they cost, and the noun agrees.
#
# Before: `Recovered after 2 retrys` -- the sentence interpolated its noun and
#         appended an s, and the noun is a variable (`retry` or `continuation`).
# After:  `Recovered after 2 retries`.
#
# The provider is proof/docker/stub-flaky-llm.ts, started in this container by
# SCENE_FLAKY_LLM=18: it answers eighteen chat completions with 503, which is in
# the transport family the retry loop retries, and streams the nineteenth. Two
# layers count those failures -- the HTTP client spends six attempts per request
# before it reports one, and the session retries the reported error -- so
# eighteen failures are what it takes for the summary to count more than one
# retry, which is the arm where the noun has to agree. The turn is the product's
# own request, backoff and recovery; only the endpoint is a stub.
#
# needle-source: Recovered after -- modes/retry-display.ts formatRetrySummary, shown by event-controller.ts on auto_retry_end
# needle-source: retries -- modes/retry-display.ts formatRetrySummary through formatCount(retry, 2)
# needle-source: retrys -- the pre-class spelling of the same line, which is what the before arm holds
settle 18
shot idle

submit "Say hello in one short sentence."

# The 503s and their backoffs run for several seconds before the stream starts,
# and the summary lands in the transcript when the turn resolves, so this waits
# out every backoff.
expect_screen "Recovered after" 120

# THE ARM SPLIT IS THE CLAIM. Neither spelling can hold on both sides, so each arm
# asserts its own and a take that recorded the other one aborts instead of shipping
# a frame that proves nothing.
if [ "${SCENE_ARM}" = before ]; then
	expect_screen "retrys" 20
else
	expect_screen "retries" 20
fi

settle 3
shot recovered
