/**
 * WHY: whether a turn that ended on an error finish reason is retried must not
 * depend on which provider phrased the message.
 *
 * `turnDomain` lists `Flag.ProviderFinishError` under `recovers`, so a turn
 * carrying that flag is sent again. The flag was raised by a regex living in
 * `error/domains/turn.ts` that matched the wording `openai-completions.ts` used
 * — and that provider's source said so outright: "word the message to match the
 * session retry classifier's transient-transport pattern ... and get the turn
 * auto-retried". Amazon Bedrock worded the identical failure "Generation failed
 * with stop reason: error", and both Google paths "Generation failed with finish
 * reason: error". Neither matched. Measured before this fix, those two wordings
 * classified to flags `0` — no rule at all — while OpenAI's classified to
 * `0x421000`. The same provider failure retried on one vendor and walled on
 * three.
 *
 * The defect class: a control-flow decision taken by matching English that
 * another module mints. The cure applied here is the one `error/provider.ts`
 * already uses for `PROVIDER_RESPONSE_RETRYABLE` — put the decision and the data
 * it reads in one owner. `providerFinishErrorMessage` mints the string and
 * `PROVIDER_FINISH_ERROR_PATTERN` reads it, side by side in that file.
 *
 * The legacy wordings are still matched on purpose. They are in persisted
 * sessions written by earlier versions, and a resumed transcript replays the
 * wording of the version that wrote it; dropping them would reclassify history.
 *
 * What this suite does NOT catch. Two things.
 *
 * Behavior here is defended by the matcher, and routing a producer through the
 * owner is a consistency change on top of that: because the pattern still
 * accepts the legacy wordings, a provider that goes back to hand-writing one of
 * them classifies the same. Reverting Bedrock's call site was measured against
 * this suite and stayed green for exactly that reason.
 *
 * The producer pins below therefore drive only the two streams a test can reach
 * with a `FetchImpl`: `openai-completions` and `google-generative-ai`. Amazon
 * Bedrock speaks AWS binary event-stream framing and `google-gemini-cli` speaks
 * its own transport, and no helper in this package synthesizes either body, so
 * a change to those two call sites is uncovered. A provider added later that
 * hand-writes novel prose is uncovered too: there is no runtime seam that can
 * see a string which never went through the owner, and asserting on provider
 * source text is banned here.
 */
import { describe, expect, it } from "bun:test";
import { Flag } from "@veyyon/ai/error/flag";
import { classify } from "@veyyon/ai/error/flags";
import { PROVIDER_FINISH_ERROR_PATTERN, providerFinishErrorMessage } from "@veyyon/ai/error/provider";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/** Raised on a turn the turn domain is willing to send again. */
function turnRetries(message: string): boolean {
	return (classify(new Error(message)) & Flag.ProviderFinishError) !== 0;
}

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Continue the task.", timestamp: 0 }] };
}

function openAIModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}) as Model<"openai-completions">;
}

function googleModel(): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}) as Model<"google-generative-ai">;
}

function sse(chunks: unknown[]): FetchImpl {
	return () =>
		Promise.resolve(
			new Response(`${chunks.map(c => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
}

describe("the wording of an error finish reason has one owner", () => {
	// The round trip that makes the two halves inseparable: anything the owner
	// mints for an error reason is matched by the pattern the owner exports.
	// A change to either that is not mirrored in the other fails here.
	it("matches every message its own builder mints for an error finish", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test(providerFinishErrorMessage("error"))).toBe(true);
		expect(turnRetries(providerFinishErrorMessage("error"))).toBe(true);
	});

	// A reason the provider did not state must not read as a completion, and
	// must not silently become some other classification either.
	it("states an absent reason rather than an empty one", () => {
		expect(providerFinishErrorMessage(undefined)).toBe("Provider finish_reason: unknown");
		expect(providerFinishErrorMessage("")).toBe("Provider finish_reason: unknown");
	});

	// BACKTEST. These four strings were minted by shipped versions and are in
	// persisted sessions on disk. Each must reach the same verdict, both when a
	// live turn produces it and when a resume replays it.
	const legacyWordings = [
		["openai-completions gateway arm", "Provider returned error finish_reason"],
		["openai-completions default arm", "Provider finish_reason: error"],
		["amazon-bedrock", "Generation failed with stop reason: error"],
		["google-shared and google-gemini-cli", "Generation failed with finish reason: error"],
	];
	for (const [origin, wording] of legacyWordings) {
		it(`retries the turn for the wording ${origin} wrote`, () => {
			expect(turnRetries(wording)).toBe(true);
		});
	}

	// Negative controls. A content verdict is a judgement on the request and
	// vetoes a retry; a network finish has its own rule. Neither may be dragged
	// into the retry set by widening the finish-reason pattern.
	const mustNotRetryAsFinishError = [
		"Provider finish_reason: PROHIBITED_CONTENT",
		"Provider finish_reason: sensitive",
		"Provider finish_reason: network_error",
	];
	for (const message of mustNotRetryAsFinishError) {
		it(`does not raise a finish-reason retry for ${JSON.stringify(message)}`, () => {
			expect(turnRetries(message)).toBe(false);
		});
	}

	// PRODUCER PINS. Each arm drives the provider's real stream to an error
	// finish and asserts the message it produced reaches the retry decision.
	// String equality is deliberate: it is what proves the provider went through
	// the owner rather than arriving at similar prose by coincidence.
	it("routes an openai-completions error finish through the owner", async () => {
		const result = await streamOpenAICompletions(openAIModel(), baseContext(), {
			apiKey: "test-key",
			fetch: sse([
				{ choices: [{ index: 0, delta: { content: "partial" } }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "error" }] },
			]),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(providerFinishErrorMessage("error"));
		expect(turnRetries(result.errorMessage ?? "")).toBe(true);
	});

	it("routes a google-generative-ai error finish through the owner", async () => {
		const result = await streamGoogle(googleModel(), baseContext(), {
			apiKey: "test-key",
			fetch: sse([
				{
					candidates: [{ content: { parts: [{ text: "partial" }], role: "model" }, index: 0 }],
				},
				{ candidates: [{ content: { parts: [], role: "model" }, finishReason: "OTHER", index: 0 }] },
			]),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(providerFinishErrorMessage("OTHER"));
	});
});
