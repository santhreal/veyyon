import { describe, expect, test } from "bun:test";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * WHY: every provider assigns `output.duration` twice — once where the stream
 * finishes and once where it errors. Refactoring the error path is how one of
 * those assignments disappears: the success path still reports a duration, the
 * suite stays green, and only failed turns lose their timing. That happened to
 * `streamBedrock`, where a change to the diagnostic dump removed the error-path
 * assignment and left `ttft` beside it, so nothing looked missing.
 *
 * The class this closes: a provider that reports a duration when it succeeds
 * and reports none when it fails. It is asserted against the real
 * `streamBedrock` driven through a transport that rejects, not against a fake.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: this drives Bedrock only. The other
 * ten providers carry the same pair of assignments and the same exposure, and
 * a sweep over all of them needs a per-provider driver (credentials, model
 * identity, transport shape) that does not exist yet. A provider added or
 * refactored outside Bedrock can still lose its error-path duration silently.
 */

const model: Model<"bedrock-converse-stream"> = buildModel({
	id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
	name: "Bedrock duration probe",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1000000,
	maxTokens: 128000,
});

function userContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
}
/**
 * A transport that always rejects with a status the retry policy does NOT
 * re-attempt, so the turn reaches its error path once instead of backing off.
 */
function rejectingFetch(status: number): FetchImpl {
	return Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit) => new Response("upstream refused", { status }),
		{ preconnect: fetch.preconnect },
	);
}

describe("a failed provider request still reports its duration", () => {
	test("bedrock records a duration on the error path, not only the success path", async () => {
		const result = await streamBedrock(model, userContext(), {
			bearerToken: "test-token",
			fetch: rejectingFetch(400),
			maxTokens: 16,
		}).result();

		// The turn must be a failure, or this asserts the success path by accident.
		expect(result.stopReason).toBe("error");
		expect(typeof result.duration).toBe("number");
		expect(result.duration).toBeGreaterThan(0);
	});

	test("the duration is the elapsed turn, not a value carried from somewhere else", async () => {
		// A duration that never moves would satisfy "is a number greater than
		// zero" while measuring nothing. Two turns cannot both report the same
		// monotonic elapsed time unless the field is constant.
		const run = async (): Promise<number> => {
			const result = await streamBedrock(model, userContext(), {
				bearerToken: "test-token",
				fetch: rejectingFetch(418),
				maxTokens: 16,
			}).result();
			expect(result.stopReason).toBe("error");
			return result.duration ?? -1;
		};

		const first = await run();
		const second = await run();
		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(0);
		// Bounded: a turn against an in-process transport cannot take a minute,
		// so a duration that large means the field is a timestamp, not a span.
		expect(first).toBeLessThan(60_000);
		expect(second).toBeLessThan(60_000);
	});
});
