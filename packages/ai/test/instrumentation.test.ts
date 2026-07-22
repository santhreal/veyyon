import { describe, expect, it } from "bun:test";
import type { ImageContent, TextContent, Usage } from "@veyyon/ai";
import {
	type AssistantTurnMetricsInput,
	type AssistantTurnRequestInput,
	atLeast,
	captureAssistantTurnMetrics,
	captureAssistantTurnRequest,
	captureToolCallMetrics,
	INSTRUMENTATION_LEVELS,
	instrumentationRank,
	type ToolCallMetricsInput,
} from "@veyyon/ai";

const textBlock = (text: string): TextContent => ({ type: "text", text });
const imageBlock = (): ImageContent => ({ type: "image", data: "AAAA", mimeType: "image/png" });

// A fixed token counter so `resultTokens` asserts an exact value: one token per
// whitespace-delimited word, matching how the test reasons about the content.
const wordCounter = (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length);

function baseInput(overrides: Partial<ToolCallMetricsInput> = {}): ToolCallMetricsInput {
	return {
		level: "ultra",
		startedAt: 1_000,
		endedAt: 1_250,
		queuedAt: 940,
		concurrency: "shared",
		batchId: "batch-1",
		batchIndex: 2,
		batchSize: 3,
		status: "ok",
		interruptible: true,
		signalAborted: false,
		resultContent: [textBlock("alpha beta gamma"), imageBlock()],
		args: { path: "/tmp/x", limit: 10 },
		countTokens: wordCounter,
		...overrides,
	};
}

describe("instrumentation level ordering", () => {
	it("ranks the levels off < basic < rich < ultra", () => {
		expect(INSTRUMENTATION_LEVELS).toEqual(["off", "basic", "rich", "ultra"]);
		expect(instrumentationRank("off")).toBe(0);
		expect(instrumentationRank("basic")).toBe(1);
		expect(instrumentationRank("rich")).toBe(2);
		expect(instrumentationRank("ultra")).toBe(3);
		expect(instrumentationRank(undefined)).toBe(0);
	});

	it("atLeast compares in richness order", () => {
		expect(atLeast("ultra", "rich")).toBe(true);
		expect(atLeast("rich", "rich")).toBe(true);
		expect(atLeast("basic", "rich")).toBe(false);
		expect(atLeast(undefined, "basic")).toBe(false);
	});
});

describe("captureToolCallMetrics gating", () => {
	it("records nothing at off", () => {
		expect(captureToolCallMetrics(baseInput({ level: "off" }))).toBeUndefined();
	});

	it("basic records only wall-clock and status, never scheduling or weight", () => {
		const m = captureToolCallMetrics(baseInput({ level: "basic" }));
		expect(m).toEqual({
			level: "basic",
			startedAt: 1_000,
			endedAt: 1_250,
			durationMs: 250,
			status: "ok",
		});
	});

	it("rich adds scheduling and output weight", () => {
		const m = captureToolCallMetrics(baseInput({ level: "rich" }));
		if (!m) throw new Error("expected metrics");
		expect(m.durationMs).toBe(250);
		expect(m.queuedMs).toBe(60); // startedAt 1000 − queuedAt 940
		expect(m.concurrency).toBe("shared");
		expect(m.batchId).toBe("batch-1");
		expect(m.batchIndex).toBe(2);
		expect(m.batchSize).toBe(3);
		expect(m.resultBlocks).toBe(2);
		expect(m.resultImages).toBe(1);
		expect(m.resultBytes).toBe("alpha beta gamma".length); // ascii → 1 byte/char
		expect(m.resultTokens).toBe(3); // three words
		// rich must NOT reach into the ultra-only fields
		expect(m.argsHash).toBeUndefined();
		expect(m.argsBytes).toBeUndefined();
		expect(m.interruptible).toBeUndefined();
	});

	it("ultra adds the args fingerprint, size, and signal state", () => {
		const m = captureToolCallMetrics(baseInput({ level: "ultra" }));
		if (!m) throw new Error("expected metrics");
		expect(m.resultTokens).toBe(3);
		expect(m.argsBytes).toBe(JSON.stringify({ limit: 10, path: "/tmp/x" }).length);
		expect(m.argsHash).toMatch(/^[0-9a-f]{8}$/);
		expect(m.interruptible).toBe(true);
		expect(m.signalAborted).toBe(false);
	});

	it("fingerprints identical args identically regardless of key order", () => {
		const a = captureToolCallMetrics(baseInput({ args: { path: "/tmp/x", limit: 10 } }));
		const b = captureToolCallMetrics(baseInput({ args: { limit: 10, path: "/tmp/x" } }));
		expect(a?.argsHash).toBe(b?.argsHash);
		const c = captureToolCallMetrics(baseInput({ args: { path: "/tmp/y", limit: 10 } }));
		expect(c?.argsHash).not.toBe(a?.argsHash);
	});

	it("clamps a negative span to zero rather than reporting a backwards duration", () => {
		const m = captureToolCallMetrics(baseInput({ level: "basic", startedAt: 2_000, endedAt: 1_900 }));
		expect(m?.durationMs).toBe(0);
	});

	it("leaves resultTokens unset when no counter is provided", () => {
		const m = captureToolCallMetrics(baseInput({ level: "rich", countTokens: undefined }));
		expect(m?.resultTokens).toBeUndefined();
		expect(m?.resultBytes).toBe("alpha beta gamma".length);
	});

	it("counts an empty text-free result as zero tokens and bytes", () => {
		const m = captureToolCallMetrics(baseInput({ level: "rich", resultContent: [imageBlock()] }));
		expect(m?.resultBytes).toBe(0);
		expect(m?.resultTokens).toBe(0);
		expect(m?.resultImages).toBe(1);
		expect(m?.resultBlocks).toBe(1);
	});
});

/**
 * GRAN-5: per-model-turn timing/throughput capture.
 *
 * Why: the session recorded only a single `timestamp` per turn plus two loose,
 * scattered scalars (`duration`, `ttft`). A latency/streaming study could not
 * read a turn's request-start, its throughput, or reason about them as one owner.
 * `captureAssistantTurnMetrics` folds them into one graded record — the assistant
 * analogue of `captureToolCallMetrics` — so these tests lock the level→field
 * mapping and the throughput arithmetic against silent regression.
 */
const usage = (over: Partial<Usage> = {}): Usage => ({
	input: 100,
	output: 300,
	cacheRead: 20,
	cacheWrite: 10,
	totalTokens: 430,
	reasoningTokens: 40,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	...over,
});

function turnInput(overrides: Partial<AssistantTurnMetricsInput> = {}): AssistantTurnMetricsInput {
	return {
		level: "ultra",
		startedAt: 10_000,
		endedAt: 12_000, // 2000ms turn
		status: "ok",
		ttftMs: 500, // first token 500ms in → 1500ms generation window
		usage: usage(),
		upstreamProvider: "Anthropic",
		...overrides,
	};
}

describe("captureAssistantTurnMetrics gating", () => {
	it("records nothing at off", () => {
		expect(captureAssistantTurnMetrics(turnInput({ level: "off" }))).toBeUndefined();
	});

	it("basic records request-start, end, duration, status, and ttft only", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "basic" }));
		expect(m).toEqual({
			level: "basic",
			startedAt: 10_000,
			endedAt: 12_000,
			durationMs: 2_000,
			status: "ok",
			ttftMs: 500,
		});
	});

	it("keeps the turn monotonic: startedAt <= endedAt and ttftMs <= durationMs", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "basic" }));
		if (!m) throw new Error("expected metrics");
		expect(m.startedAt).toBeLessThanOrEqual(m.endedAt);
		expect(m.durationMs).toBe(m.endedAt - m.startedAt);
		if (m.ttftMs !== undefined) expect(m.ttftMs).toBeLessThanOrEqual(m.durationMs);
	});

	it("drops a bogus ttft that is not a sane fraction of the turn (>= duration)", () => {
		// ttft 2500 exceeds the 2000ms turn — clock skew, not a real first-token time.
		const m = captureAssistantTurnMetrics(turnInput({ level: "basic", ttftMs: 2_500 }));
		expect(m?.ttftMs).toBeUndefined();
	});

	it("drops a negative ttft rather than storing it", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "basic", ttftMs: -1 }));
		expect(m?.ttftMs).toBeUndefined();
	});

	it("rich adds token counts consistent with usage and the exact throughput", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "rich" }));
		if (!m) throw new Error("expected metrics");
		// Token counts mirror the turn's own usage exactly.
		expect(m.outputTokens).toBe(300);
		expect(m.inputTokens).toBe(100);
		expect(m.totalTokens).toBe(430);
		// Generation window excludes the ttft: 2000 − 500 = 1500ms.
		expect(m.generationMs).toBe(1_500);
		// Throughput over the generation window: 300 tokens / 1.5s = 200 tok/s.
		expect(m.outputTokensPerSec).toBe(200);
		// rich must NOT reach into the ultra-only fields.
		expect(m.cacheReadTokens).toBeUndefined();
		expect(m.reasoningTokens).toBeUndefined();
		expect(m.upstreamProvider).toBeUndefined();
	});

	it("uses the whole turn as the generation window when ttft is unknown", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "rich", ttftMs: undefined }));
		if (!m) throw new Error("expected metrics");
		expect(m.ttftMs).toBeUndefined();
		expect(m.generationMs).toBe(2_000); // full duration, no first-token carve-out
		expect(m.outputTokensPerSec).toBe(150); // 300 / 2s
	});

	it("leaves throughput unset for a zero-output turn rather than dividing by nothing", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "rich", usage: usage({ output: 0 }) }));
		if (!m) throw new Error("expected metrics");
		expect(m.outputTokens).toBe(0);
		expect(m.outputTokensPerSec).toBeUndefined();
	});

	it("leaves throughput unset when there is no usage at all", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "rich", usage: undefined }));
		if (!m) throw new Error("expected metrics");
		expect(m.outputTokens).toBeUndefined();
		expect(m.generationMs).toBe(1_500);
		expect(m.outputTokensPerSec).toBeUndefined();
	});

	it("ultra adds cache, reasoning, and upstream-provider detail", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "ultra" }));
		if (!m) throw new Error("expected metrics");
		expect(m.cacheReadTokens).toBe(20);
		expect(m.cacheWriteTokens).toBe(10);
		expect(m.reasoningTokens).toBe(40);
		expect(m.upstreamProvider).toBe("Anthropic");
	});

	it("clamps a backwards turn (endedAt before startedAt) to zero duration", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "basic", startedAt: 12_000, endedAt: 10_000 }));
		expect(m?.durationMs).toBe(0);
	});

	it("carries the aborted status through unchanged", () => {
		const m = captureAssistantTurnMetrics(turnInput({ level: "basic", status: "aborted" }));
		expect(m?.status).toBe("aborted");
	});
});

/**
 * GRAN-6: exact per-turn request parameters AS SENT.
 *
 * Why: `model_change` recorded provider/model/role but never the sampling knobs,
 * reasoning effort, or tool-choice the turn actually used, so a replay could not
 * reproduce the request. `captureAssistantTurnRequest` captures the effective
 * per-turn values (which can differ from the static session defaults). These tests
 * lock the off-gate, the exact pass-through, and the drop-undefined behavior.
 */
function requestInput(overrides: Partial<AssistantTurnRequestInput> = {}): AssistantTurnRequestInput {
	return {
		level: "basic",
		temperature: 0.7,
		topP: 0.95,
		topK: 40,
		maxTokens: 4096,
		presencePenalty: 0.1,
		reasoningEffort: "high",
		disableReasoning: false,
		toolChoice: "auto",
		serviceTier: "priority",
		...overrides,
	};
}

describe("captureAssistantTurnRequest gating", () => {
	it("records nothing at off", () => {
		expect(captureAssistantTurnRequest(requestInput({ level: "off" }))).toBeUndefined();
	});

	it("captures every sent parameter verbatim at basic (no per-tier selection)", () => {
		const r = captureAssistantTurnRequest(requestInput());
		expect(r).toEqual({
			temperature: 0.7,
			topP: 0.95,
			topK: 40,
			maxTokens: 4096,
			presencePenalty: 0.1,
			reasoningEffort: "high",
			disableReasoning: false,
			toolChoice: "auto",
			serviceTier: "priority",
		});
	});

	it("preserves a structured forced tool-choice as sent", () => {
		const r = captureAssistantTurnRequest(requestInput({ toolChoice: { type: "tool", name: "bash" } }));
		expect(r?.toolChoice).toEqual({ type: "tool", name: "bash" });
	});

	it("omits undefined params rather than storing them as null/zero", () => {
		const r = captureAssistantTurnRequest({
			level: "basic",
			temperature: 0.3,
			maxTokens: 2048,
		});
		expect(r).toEqual({ temperature: 0.3, maxTokens: 2048 });
		expect("topP" in (r ?? {})).toBe(false);
		expect("toolChoice" in (r ?? {})).toBe(false);
	});

	it("keeps an explicit zero temperature (0 is a real value, not absent)", () => {
		const r = captureAssistantTurnRequest({ level: "basic", temperature: 0 });
		expect(r).toEqual({ temperature: 0 });
	});

	it("returns undefined for an all-default turn so no empty object is recorded", () => {
		expect(captureAssistantTurnRequest({ level: "ultra" })).toBeUndefined();
	});
});
