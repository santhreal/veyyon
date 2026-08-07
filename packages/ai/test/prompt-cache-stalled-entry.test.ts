/**
 * A prompt cache that STOPS GROWING, and the provider surface that had no
 * observer at all.
 *
 * Two contracts, both drawn from recorded sessions rather than invented.
 *
 * 1. `verifyCacheUsage` must name a frozen entry. In the recorded corpus a Codex
 *    session read exactly 38,656 tokens on turn 17 and on every turn through
 *    turn 51, while its prompt grew from 46,980 to 106,343. Every one of those
 *    turns was judged `ok`, because `ok` is returned for any non-zero read and
 *    the only regression signal, `degraded`, compares this turn's read against
 *    the previous turn's. A read that never moves cannot differ from itself, so
 *    the most expensive shape available was the one shape reported as healthy.
 *
 * 2. The Codex provider must be observed at all. `packages/ai/src/cache/` had
 *    exactly one production importer, `providers/anthropic.ts`, so on
 *    `openai-codex` the enforcement level resolved and then governed nothing.
 *    That is the provider carrying the recorded loss, so the check existed and
 *    watched the traffic that did not need it.
 *
 * The negative controls matter as much as the positive case. A stall detector
 * that also fires on an ordinary append is a detector people switch off, and
 * 29% of healthy recorded turns read exactly what the previous turn read.
 */
import { describe, expect, it, vi } from "bun:test";
import {
	beginCacheTrackedRequest,
	type CacheExpectation,
	createCacheTrackerState,
	recordCacheOutcome,
	verifyCacheUsage,
} from "@veyyon/ai/cache";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import * as logger from "@veyyon/utils/logger";

/** A key that has been alive long enough to have a comparable previous turn. */
function warmExpectation(overrides: Partial<CacheExpectation> = {}): CacheExpectation {
	return {
		anchors: 1,
		retention: "short",
		firstRequest: false,
		reportsCacheWrites: false,
		msSincePreviousRequest: 8_900,
		...overrides,
	};
}

describe("a prompt cache that stopped growing", () => {
	/**
	 * The recorded shape: the read is the same 38,656 it was last turn, the
	 * prompt has moved 90,000 -> 106,343, and everything past the frozen prefix
	 * is billed again. Before this verdict existed these numbers produced `ok`.
	 */
	it("names a read that has not moved while the prompt grew past it", () => {
		const verdict = verifyCacheUsage(
			warmExpectation({ previousReadTokens: 38_656, previousTotalInputTokens: 90_000 }),
			{ input: 67_687, cacheRead: 38_656, cacheWrite: 0 },
		);
		expect(verdict.kind).toBe("stalled");
		if (verdict.kind !== "stalled") throw new Error("unreachable");
		expect(verdict.readTokens).toBe(38_656);
		expect(verdict.totalInputTokens).toBe(106_343);
		expect(verdict.uncachedTokens).toBe(67_687);
		expect(verdict.growthTokens).toBe(16_343);
	});

	/**
	 * An advancing cache reads a DIFFERENT number every turn, because the
	 * provider extends the entry by its block size. Equality is the whole signal;
	 * a read that moved at all is healthy even when it moved very little.
	 */
	it("stays quiet when the entry advanced, even by one block", () => {
		const verdict = verifyCacheUsage(
			warmExpectation({ previousReadTokens: 38_656, previousTotalInputTokens: 90_000 }),
			{ input: 66_559, cacheRead: 39_784, cacheWrite: 0 },
		);
		expect(verdict.kind).toBe("ok");
	});

	/**
	 * Two turns inside one already-cached segment legitimately read the same
	 * value. This is 29% of healthy recorded turns, so without the growth
	 * requirement the signal would be almost entirely noise.
	 */
	it("stays quiet when the read repeats but the prompt did not grow", () => {
		const verdict = verifyCacheUsage(
			warmExpectation({ previousReadTokens: 38_656, previousTotalInputTokens: 106_343 }),
			{ input: 67_687, cacheRead: 38_656, cacheWrite: 0 },
		);
		expect(verdict.kind).toBe("ok");
	});

	/**
	 * A prompt still mostly served from cache is working, however flat the read
	 * looks turn to turn. The remainder has to overtake the cached prefix before
	 * this is worth an operator's attention, which is what keeps an ordinary
	 * appended tool result from reading as a defect and halting a live session.
	 */
	it("stays quiet while most of the prompt is still served from cache", () => {
		const verdict = verifyCacheUsage(
			warmExpectation({ previousReadTokens: 100_000, previousTotalInputTokens: 108_000 }),
			{ input: 20_000, cacheRead: 100_000, cacheWrite: 0 },
		);
		expect(verdict.kind).toBe("ok");
	});

	/**
	 * A collapsing read is still `degraded`, which is the older and more specific
	 * verdict. The stall check runs after it precisely so it cannot swallow one.
	 */
	it("leaves a collapsing read to the degraded verdict", () => {
		const verdict = verifyCacheUsage(
			warmExpectation({ previousReadTokens: 100_000, previousTotalInputTokens: 108_000 }),
			{ input: 108_000, cacheRead: 900, cacheWrite: 0 },
		);
		expect(verdict.kind).toBe("degraded");
	});

	/**
	 * A stall costs money; it does not prove a defect on our side, because the
	 * provider may be routing to a shard that lacks the newer entry. Even under
	 * the strictest enforcement it must report and stop there, never arm the
	 * rejection that fails the next request on the key.
	 */
	it("reports under strict enforcement without arming a failure", () => {
		const tracker = createCacheTrackerState();
		const facts = { anchors: 1, retention: "short", reportsCacheWrites: false, cacheKey: "k" } as const;
		const first = beginCacheTrackedRequest(tracker, facts);
		recordCacheOutcome(tracker, first, { input: 51_344, cacheRead: 38_656, cacheWrite: 0 }, "error");
		const second = beginCacheTrackedRequest(tracker, facts);
		const { verdict, decision } = recordCacheOutcome(
			tracker,
			second,
			{ input: 67_687, cacheRead: 38_656, cacheWrite: 0 },
			"error",
		);
		expect(verdict.kind).toBe("stalled");
		expect(decision.report).toBe(true);
		expect(decision.failNext).toBe(false);
	});
});

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64url");
	return `aaa.${payload}.bbb`;
}

function codexModel(): Model<"openai-codex-responses"> {
	return {
		...buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		}),
		// SSE only. The websocket transport is a separate connection path, and this
		// contract is about the verdict rather than the socket.
		preferWebsockets: false,
	};
}

function codexContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

/** One complete Codex SSE turn reporting the given prompt accounting. */
function codexTurn(cachedTokens: number, uncachedTokens: number): string {
	return `${[
		`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}`,
		`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } })}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: {
					input_tokens: cachedTokens + uncachedTokens,
					output_tokens: 3,
					total_tokens: cachedTokens + uncachedTokens + 3,
					input_tokens_details: { cached_tokens: cachedTokens },
				},
			},
		})}`,
	].join("\n\n")}\n\n`;
}

async function drainCodexTurn(
	model: Model<"openai-codex-responses">,
	sessionState: Map<string, ProviderSessionState>,
	sse: string,
): Promise<void> {
	const stream = streamOpenAICodexResponses(model, codexContext(), {
		apiKey: codexToken(),
		providerSessionState: sessionState,
		promptCacheKey: "session-under-test",
		cacheEnforcement: "warn",
		fetch: (async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl,
	});
	for await (const _event of stream) {
		// Drain to completion; the verdict is recorded when the turn finalizes.
	}
}

describe("the Codex surface is observed at all", () => {
	/**
	 * Three turns of the recorded shape. Turn one is cold and correct. Turn two
	 * reads 38,656 of 90,000. Turn three reads the SAME 38,656 of 106,343, which
	 * is the stall, and it must reach the operator.
	 *
	 * Before this wiring the assertion was unreachable rather than merely
	 * failing: `openai-codex-responses.ts` did not import the cache module, so no
	 * verdict of any kind was produced on this provider.
	 */
	it("reports a stalled entry on openai-codex, which previously produced no verdict at all", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const model = codexModel();
			const sessionState = new Map<string, ProviderSessionState>();
			await drainCodexTurn(model, sessionState, codexTurn(0, 21_080));
			await drainCodexTurn(model, sessionState, codexTurn(38_656, 51_344));
			await drainCodexTurn(model, sessionState, codexTurn(38_656, 67_687));

			const stalled = warn.mock.calls.filter(call => {
				const meta = call[1];
				return typeof meta === "object" && meta !== null && "verdict" in meta && meta.verdict === "stalled";
			});
			expect(stalled.length).toBe(1);
			expect(stalled[0]?.[0]).toContain("openai-codex: prompt cache stopped growing");
			expect(stalled[0]?.[0]).toContain("38656");
			expect(stalled[0]?.[0]).toContain("106343");
		} finally {
			vi.restoreAllMocks();
		}
	});
});
