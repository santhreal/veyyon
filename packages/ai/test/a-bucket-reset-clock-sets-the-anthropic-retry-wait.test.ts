/**
 * WHY: the Anthropic client read `retry-after-ms` and `retry-after` with a parser of its own, so a 429
 * whose only timing signal was a per-bucket reset clock (`anthropic-ratelimit-tokens-reset`) retried on
 * the half-second backoff curve against a window the service had already stated. The class closed here
 * is any server-stated wait the shared reader (`getRetryAfterMsFromHeaders`) understands and the
 * client's retry ladder ignores: every bucket in `ANTHROPIC_RESET_HEADERS` is driven through the real
 * `AnthropicMessagesClient` retry loop, so a bucket added to the registry is covered the moment it
 * lands, and the ladder must also surface a stated window longer than `maxRetryDelayMs` instead of
 * sleeping on it.
 *
 * Not caught: a reset header Anthropic sends that `ANTHROPIC_RESET_HEADERS` does not list, and the
 * stream-level retry in `anthropic.ts`, which reads the same `retryDelayFromHeaders` but is not driven
 * here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import * as AIError from "@veyyon/ai/error";
import { AnthropicMessagesClient } from "@veyyon/ai/providers/anthropic-client";
import type { MessageCreateParamsStreaming } from "@veyyon/ai/providers/anthropic-wire";
import type { FetchImpl } from "@veyyon/ai/types";
import { ANTHROPIC_RESET_HEADERS } from "@veyyon/utils/fetch-retry";

const NOW = 1_800_000_000_000;
const STATED_WAIT_MS = 5_000;
/** The longest wait the backoff curve produces for the first retry: 0.5s before jitter shortens it. */
const FIRST_BACKOFF_CEILING_MS = 500;

const params: MessageCreateParamsStreaming = {
	model: "claude-sonnet-4-5",
	messages: [{ role: "user", content: "hi" }],
	max_tokens: 64,
	stream: true,
};

const PER_MINUTE_RATE_LIMIT_BODY = JSON.stringify({
	type: "error",
	error: {
		type: "rate_limit_error",
		message: "This request would exceed the rate limit for your organization of 30,000 input tokens per minute.",
	},
});

interface Attempt {
	waits: number[];
	fetches: number;
	outcome: unknown;
}

/** A 429 carrying `headers`, then a 200, through the real client retry loop with the clock pinned. */
async function sendThroughRateLimit(headers: Record<string, string>, maxRetryDelayMs?: number): Promise<Attempt> {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const waits: number[] = [];
	vi.spyOn(scheduler, "wait").mockImplementation(async (delay: number) => {
		waits.push(delay);
	});
	let fetches = 0;
	const fetch: FetchImpl = async () => {
		fetches++;
		return fetches === 1
			? new Response(PER_MINUTE_RATE_LIMIT_BODY, { status: 429, headers })
			: new Response("{}", { status: 200 });
	};
	const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 1, fetch });
	const outcome = await client.messages
		.create(params, maxRetryDelayMs === undefined ? undefined : { maxRetryDelayMs })
		.asResponse()
		.catch((error: unknown) => error);
	return { waits, fetches, outcome };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a bucket reset clock sets the Anthropic retry wait", () => {
	it("covers at least one registered bucket", () => {
		expect(ANTHROPIC_RESET_HEADERS.length).toBeGreaterThan(0);
	});

	for (const { reset, remaining } of ANTHROPIC_RESET_HEADERS) {
		it(`waits the window ${reset} states when it is the only timing signal`, async () => {
			const attempt = await sendThroughRateLimit({
				[reset]: new Date(NOW + STATED_WAIT_MS).toISOString(),
				[remaining]: "0",
			});

			expect(attempt.outcome).toBeInstanceOf(Response);
			expect(attempt.fetches).toBe(2);
			expect(attempt.waits).toEqual([STATED_WAIT_MS]);
			expect(attempt.waits[0]).toBeGreaterThan(FIRST_BACKOFF_CEILING_MS);
		});

		it(`surfaces the 429 when ${reset} states a window past maxRetryDelayMs`, async () => {
			const attempt = await sendThroughRateLimit(
				{ [reset]: new Date(NOW + STATED_WAIT_MS).toISOString(), [remaining]: "0" },
				STATED_WAIT_MS - 1,
			);

			expect(attempt.outcome).toBeInstanceOf(AIError.AnthropicApiError);
			expect(attempt.fetches).toBe(1);
			expect(attempt.waits).toEqual([]);
		});
	}

	it("falls back to the backoff curve when no header states a window", async () => {
		const attempt = await sendThroughRateLimit({});

		expect(attempt.outcome).toBeInstanceOf(Response);
		expect(attempt.waits).toHaveLength(1);
		expect(attempt.waits[0]).toBeGreaterThan(FIRST_BACKOFF_CEILING_MS * 0.75);
		expect(attempt.waits[0]).toBeLessThanOrEqual(FIRST_BACKOFF_CEILING_MS);
	});
});
