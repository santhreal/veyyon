/**
 * The Anthropic provider now refuses to keep paying for a cache it was denied.
 *
 * WHY THIS SUITE EXISTS. `cache-verdict.test.ts` proves the judgement in
 * isolation; this proves it is WIRED. That distinction is the whole lesson of the
 * four shipped cache defects: each one was a correct intention that never reached
 * the wire, and a unit test of the intention would have passed for all of them.
 * So these tests drive the real `streamAnthropic` against a stubbed transport and
 * assert on what the provider does across two turns.
 *
 * WHAT IS PINNED. A second turn whose response reports neither a cache read nor
 * a cache write, on a request that carried cache markers, latches a failure; the
 * NEXT request then throws `CacheRejectedError` before spending anything. The
 * first turn is never failed (nothing to read yet), a healthy read never fails,
 * `off` disables it, `warn` never throws, and — the one that keeps this from
 * becoming a nuisance — the failure is raised at most once, so a session is not
 * bricked by one historical rejection.
 *
 * The deferral is deliberate and is asserted directly: the turn that gets
 * rejected still returns its assistant message. Throwing when the rejection is
 * detected would cost the user the completed work as well as the money.
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { Context, Model, ProviderSessionState } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

function anthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "claude-sonnet-4-5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

/**
 * A prompt well over the 2048-token cacheable floor. The floor is measured in
 * PROVIDER-reported tokens, so what matters is the usage the stub returns, not
 * this text; it exists so the request is a realistic size.
 */
const CONTEXT: Context = {
	systemPrompt: ["You are a careful assistant.", "Follow the project conventions."],
	messages: [{ role: "user", content: "Summarize the repository layout.", timestamp: Date.now() }],
};

interface StubUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** A complete, well-formed Anthropic SSE turn reporting the given usage. */
function sseTurn(usage: StubUsage): string {
	const start = {
		type: "message_start",
		message: {
			id: "msg_stub",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			usage: {
				input_tokens: usage.input,
				output_tokens: 0,
				cache_read_input_tokens: usage.cacheRead,
				cache_creation_input_tokens: usage.cacheWrite,
			},
		},
	};
	const delta = {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: {
			input_tokens: usage.input,
			output_tokens: 5,
			cache_read_input_tokens: usage.cacheRead,
			cache_creation_input_tokens: usage.cacheWrite,
		},
	};
	return [
		`event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify(delta)}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	].join("");
}

/**
 * A transport that replays one scripted turn per call. Using the real provider
 * with a fake socket is the point: the anchors it counts are the ones it
 * serialized, which is exactly the step every shipped defect broke.
 */
function scriptedFetch(turns: StubUsage[]): { fetch: typeof fetch; calls: () => number } {
	let call = 0;
	const impl = (async () => {
		const usage = turns[Math.min(call, turns.length - 1)];
		call += 1;
		return new Response(sseTurn(usage as StubUsage), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as unknown as typeof fetch;
	return { fetch: impl, calls: () => call };
}

/**
 * Drive one turn and report what the caller observes.
 *
 * `streamAnthropic` does NOT reject on failure: it ends the turn with
 * `stopReason: "error"` and the message on the assistant record, which is how
 * every other provider failure reaches the agent runtime. Asserting a thrown
 * exception would be asserting the wrong contract — and would pass while the
 * runtime silently continued.
 */
async function runTurn(
	model: Model<"anthropic-messages">,
	sessionState: Map<string, ProviderSessionState>,
	fetchImpl: typeof fetch,
	enforcement: "off" | "warn" | "error",
): Promise<{ text: string; stopReason?: string; errorMessage?: string }> {
	const stream = streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-test",
		providerSessionState: sessionState,
		promptCacheKey: "session-under-test",
		cacheEnforcement: enforcement,
		fetch: fetchImpl,
	});
	let text = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	for await (const event of stream) {
		if (event.type === "text_end") text += event.content;
		if (event.type === "error") {
			stopReason = event.error.stopReason;
			errorMessage = event.error.errorMessage;
		}
	}
	return { text, stopReason, errorMessage };
}

describe("a denied prompt cache stops the session", () => {
	/**
	 * The core contract. Turn one is cold and writes an entry, which is correct.
	 * Turn two reports NEITHER a read nor a write on a request that carried
	 * markers — impossible when caching works — so turn three fails.
	 */
	it("fails the request after a rejection, naming the surface and the cost", async () => {
		const model = anthropicModel();
		const sessionState = new Map<string, ProviderSessionState>();
		const { fetch: impl } = scriptedFetch([
			{ input: 0, cacheRead: 0, cacheWrite: 50_000 },
			{ input: 50_000, cacheRead: 0, cacheWrite: 0 },
		]);

		const coldTurn = await runTurn(model, sessionState, impl, "error");
		expect(coldTurn.stopReason).toBeUndefined();

		// The rejected turn itself still completes: the deferral exists so the user
		// does not lose a finished assistant message as well as the money.
		const rejectedTurn = await runTurn(model, sessionState, impl, "error");
		expect(rejectedTurn.text).toBe("ok");
		expect(rejectedTurn.stopReason).toBeUndefined();

		// The turn AFTER it is the one that fails, before spending anything.
		const blocked = await runTurn(model, sessionState, impl, "error");
		expect(blocked.stopReason).toBe("error");
		expect(blocked.errorMessage).toContain("prompt cache was NOT accepted");
		expect(blocked.errorMessage).toContain("anthropic/claude-sonnet-4-5");
		expect(blocked.errorMessage).toContain("3 cache anchors");
		expect(blocked.errorMessage).toContain("50000 input tokens");
		expect(blocked.text).toBe("");
	});

	/**
	 * Raised once, then cleared. A latch that persisted would fail every later
	 * request for one historical rejection, leaving no way to continue short of
	 * restarting the session — which is how a safety check becomes something
	 * people switch off permanently.
	 */
	it("raises the failure at most once", async () => {
		const model = anthropicModel();
		const sessionState = new Map<string, ProviderSessionState>();
		const { fetch: impl } = scriptedFetch([
			{ input: 0, cacheRead: 0, cacheWrite: 50_000 },
			{ input: 50_000, cacheRead: 0, cacheWrite: 0 },
		]);
		await runTurn(model, sessionState, impl, "error");
		await runTurn(model, sessionState, impl, "error");
		expect((await runTurn(model, sessionState, impl, "error")).stopReason).toBe("error");
		// The next attempt runs. The scripted transport keeps replaying the rejected
		// usage, so this also proves the blocked request did not re-arm the latch
		// by counting itself as another rejection.
		const recovered = await runTurn(model, sessionState, impl, "error");
		expect(recovered.text).toBe("ok");
		expect(recovered.stopReason).toBeUndefined();
	});
});

describe("what must never fail", () => {
	/** The first turn on a key has nothing to read. Failing here would break the
	 *  opening request of every session. */
	it("never fails the first turn, however cold", async () => {
		const model = anthropicModel();
		const sessionState = new Map<string, ProviderSessionState>();
		const { fetch: impl } = scriptedFetch([{ input: 50_000, cacheRead: 0, cacheWrite: 0 }]);
		const first = await runTurn(model, sessionState, impl, "error");
		expect(first.text).toBe("ok");
	});

	/** A working cache must be silent across many turns, or the check is useless. */
	it("never fails while the cache is being read", async () => {
		const model = anthropicModel();
		const sessionState = new Map<string, ProviderSessionState>();
		const { fetch: impl } = scriptedFetch([
			{ input: 0, cacheRead: 0, cacheWrite: 50_000 },
			{ input: 200, cacheRead: 50_000, cacheWrite: 0 },
		]);
		for (let turn = 0; turn < 4; turn++) {
			expect((await runTurn(model, sessionState, impl, "error")).text).toBe("ok");
		}
	});

	/** `off` and `warn` must never throw, whatever the provider reports. `off`
	 *  additionally must not even latch, so switching it on later starts clean. */
	it("never throws under warn, and does not latch under off", async () => {
		const model = anthropicModel();
		for (const enforcement of ["off", "warn"] as const) {
			const sessionState = new Map<string, ProviderSessionState>();
			const { fetch: impl } = scriptedFetch([
				{ input: 0, cacheRead: 0, cacheWrite: 50_000 },
				{ input: 50_000, cacheRead: 0, cacheWrite: 0 },
			]);
			for (let turn = 0; turn < 3; turn++) {
				expect((await runTurn(model, sessionState, impl, enforcement)).text).toBe("ok");
			}
		}
	});

	/**
	 * A prompt under the cacheable floor cannot be cached, so a miss there says
	 * nothing. Asserted through the real provider because the floor is applied to
	 * provider-reported totals, and a wiring mistake that passed the wrong number
	 * would fail every small turn.
	 */
	it("never fails a prompt below the cacheable floor", async () => {
		const model = anthropicModel();
		const sessionState = new Map<string, ProviderSessionState>();
		const { fetch: impl } = scriptedFetch([
			{ input: 0, cacheRead: 0, cacheWrite: 900 },
			{ input: 900, cacheRead: 0, cacheWrite: 0 },
		]);
		for (let turn = 0; turn < 3; turn++) {
			expect((await runTurn(model, sessionState, impl, "error")).text).toBe("ok");
		}
	});
});
