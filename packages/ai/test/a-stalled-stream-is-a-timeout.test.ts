/**
 * WHY: every provider's idle watchdog reports "<provider> stream stalled while
 * waiting for the next event". The timeout vocabulary matched `stream stall`
 * and not `stalled`, so a mid-stream stall carried Flag.Transient and never
 * Flag.Timeout. The auto-compaction candidate loop keys its "do not re-send the
 * same context to the model that just timed out" exit on Flag.Timeout, so a
 * stalled summary was retried on the same model up to `retry.maxRetries`
 * times, each attempt paying the provider ladder in full: observed 2026-09-09
 * as eight retries of one codex summary at thirty minutes apiece.
 *
 * Closes the class: any watchdog message in the shipped wording, whichever
 * provider prefix it carries and whether it stalled before the first event or
 * after it, is a timeout and stays transient.
 *
 * Does not catch: a provider that words its watchdog without `stream` and
 * `stall`/`timed out`/`timeout`. The wording is pinned by the provider suites
 * (`anthropic-stream-timeout`, `openai-codex-stream`, `cursor-exec-handlers`).
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";

const WATCHDOG_MESSAGES = [
	"OpenAI responses stream stalled while waiting for the next event",
	"OpenAI completions stream stalled while waiting for the next event",
	"OpenAI Codex SSE stream stalled while waiting for the next event",
	"Azure OpenAI responses stream stalled while waiting for the next event",
	"Anthropic stream stalled while waiting for the next event",
	"Provider stream stalled while waiting for the next event",
	"OpenAI Codex SSE stream timed out while waiting for the first event",
	"Provider stream timed out while waiting for the first event",
	// The wrapper the summarizer puts around the provider's own message.
	"Summarization failed: OpenAI Codex SSE stream stalled while waiting for the next event",
] as const;

describe("a stalled stream is a timeout", () => {
	for (const message of WATCHDOG_MESSAGES) {
		it(`classifies "${message}" as Timeout and Transient`, () => {
			const id = AIError.classify(new Error(message), "openai-codex-responses");
			expect(AIError.is(id, AIError.Flag.Timeout)).toBe(true);
			expect(AIError.is(id, AIError.Flag.Transient)).toBe(true);
			expect(AIError.retriable(id)).toBe(true);
		});
	}

	it("does not read an unrelated 'stalled' as a stream timeout", () => {
		const id = AIError.classify(new Error("the installer stalled on a prompt"), "openai-responses");
		expect(AIError.is(id, AIError.Flag.Timeout)).toBe(false);
	});
});
