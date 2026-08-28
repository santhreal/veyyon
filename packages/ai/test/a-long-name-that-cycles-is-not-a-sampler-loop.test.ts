/**
 * A repeating run inside ONE long token is data, not a runaway sampler.
 *
 * WHY THIS SUITE EXISTS. A real session changed the working directory to a
 * deeply nested folder whose name cycles a short group, and the turn died with:
 *
 *     Thinking loop detected: repeated "_on_and" 26× back-to-back
 *
 * Nothing had looped. `_on_and` is seven characters, and 7 × 26 = 182, which
 * clears `VERBATIM_MIN_REPEATED_CHARS` (180) — so echoing the directory name
 * back was enough to convince the guard the model had lost its footing. The
 * turn was then re-sampled, produced the same name for the same reason, and
 * tripped again: the abort is deterministic in the input, so the retry ladder
 * could never recover it. That is the shape the operator saw as a hang.
 *
 * THE CLASS, not the incident. Pinning `_on_and` would leave every other
 * cycling name open — a hash, a repeated path segment, a query string, an
 * identifier built from a repeated word. The discriminator is not the bytes, it
 * is the token boundary: a sampler runaway repeats ACROSS whitespace, while a
 * name is one unbroken token. Both detector paths are swept below, because the
 * streamed detector and the completed-text scanner are separate implementations
 * of the same judgement and fixing one leaves the other reporting a loop for
 * bytes the other accepts.
 *
 * WHAT THIS SUITE DOES NOT CATCH. A genuine runaway that repeats a single word
 * with no whitespace AND begins mid-token is indistinguishable from a name by
 * this rule and is left alone; the boundary case below pins that a run starting
 * at a token boundary still trips, which is what keeps a space-free script
 * covered. It also says nothing about the segment-similarity path, which has its
 * own thresholds and its own suite.
 */
import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Model } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { detectDegenerateRepetition, withGeminiThinkingLoopGuard } from "@veyyon/ai/utils/thinking-loop";

const model = {
	api: "openai-completions",
	provider: "anthropic",
	id: "claude-opus-5",
} as unknown as Model<Api>;

function partialMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		usage: {
			input: 900,
			output: 210,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1110,
			cost: { input: 0.0027, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0037 },
		},
		stopReason: "stop",
	} as unknown as AssistantMessage;
}

/** The recorded cycle: seven characters, twenty-six times, 182 chars of one folder name. */
const CYCLE = "_on_and".repeat(26);

/**
 * Stream `text` as assistant text through the REAL guard in several deltas and
 * report whether the guard replaced the turn with a stall.
 *
 * Chunked rather than pushed whole: the detector works off a rolling tail, so a
 * single giant delta would exercise a code path no provider produces.
 */
async function streamText(text: string): Promise<{ tripped: boolean; errorMessage: string | undefined }> {
	const partial = partialMessage();
	const guarded = withGeminiThinkingLoopGuard(model, { loopGuard: { checkAssistantContent: true } }, () => {
		const inner = new AssistantMessageEventStream();
		inner.push({ type: "start", partial });
		inner.push({ type: "text_start", contentIndex: 0, partial });
		for (let i = 0; i < text.length; i += 16) {
			inner.push({ type: "text_delta", contentIndex: 0, delta: text.slice(i, i + 16), partial });
		}
		inner.push({ type: "done", reason: "stop", message: partial });
		inner.end({ ...partial, stopReason: "stop" });
		return inner;
	});

	for await (const _event of guarded) {
		// drain
	}
	const result = await guarded.result();
	return { tripped: result.stopReason === "error", errorMessage: result.errorMessage };
}

describe("a long name that cycles is not a sampler loop", () => {
	/** The incident itself, sanitized to a neutral root. */
	test("the recorded folder name streams through untouched", async () => {
		const run = await streamText(`Working directory set to /repo/fixtures/probe${CYCLE}`);

		expect({ tripped: run.tripped, error: run.errorMessage }).toEqual({ tripped: false, error: undefined });
	});

	/** The same bytes asked of the completed-text scanner, which is a separate implementation. */
	test("the completed-text scanner agrees with the streamed detector", () => {
		expect(detectDegenerateRepetition(`Working directory set to /repo/fixtures/probe${CYCLE}`)).toBeNull();
	});

	/**
	 * THE CLASS. Every one of these is one unbroken token whose tail cycles, and
	 * every one of them would have been its own incident report.
	 */
	test.each([
		["a nested path segment", `/repo/build/out/artifact${"_step_a".repeat(30)}`],
		["a hex digest", `sha256:${"deadbeef".repeat(24)}`],
		["an identifier", `const handler${"OnAndOn".repeat(26)}`],
		["a query string", `https://example.test/q?${"a=1&b=2&".repeat(24)}`],
	])("%s that cycles is left alone", async (_label, text) => {
		const run = await streamText(text);

		expect(run.tripped).toBe(false);
		expect(detectDegenerateRepetition(text)).toBeNull();
	});

	/**
	 * THE BOUNDARY that keeps the rule from being a blanket exemption. A run that
	 * BEGINS at a token boundary is not a continuation of a longer name, so it
	 * still trips — this is what keeps a runaway in a script without spaces
	 * covered, and it is the mutation that must go red if the guard is disabled.
	 */
	test("a whitespace-free run that starts at a token boundary still trips", async () => {
		const run = await streamText(`Result: ${"loopy".repeat(48)}`);

		expect(run.tripped).toBe(true);
	});

	/** The ordinary runaway the guard exists for is unaffected by the token rule. */
	test("a repeated sentence still trips", async () => {
		const sentence = "I will check the display and then start the harness against it. ";
		const run = await streamText(sentence.repeat(12));

		expect(run.tripped).toBe(true);
	});
});
