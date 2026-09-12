import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	estimateCompactionRequestTokens,
	planMergeGroups,
	planSummarySegments,
	stagedSegmentBudget,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Context, Message, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * A span whose one-request summary never answers is summarized in stages, and
 * the staged summary covers the whole span.
 *
 * WHY. Auto-compaction of a 234k-token `openai-codex` session sent the whole
 * span as one summarization request. Every attempt got `response.created` and
 * then nothing until the stream watchdog fired, for hours, while ordinary turns
 * over the same history streamed and completed. The single request was the only
 * thing that never started its answer. The class is any summarization request
 * that does not fit, or does not answer, as one request; the fix is to send the
 * span as consecutive segments and merge their summaries, and to remember the
 * model that timed out so the next compaction on it pays no stall.
 *
 * Covered: the timeout fallback and its request shape (every segment under the
 * budget, every segment summary in the merge, in order), the previous summary
 * and the caller's instruction reaching only the final merge, staging forced by
 * the caller, staging chosen when the single request cannot fit the window
 * (with the estimator admitting that candidate), a failure that is not a timeout
 * propagating unchanged, cancellation propagating as cancellation, and the
 * `compaction/staged-summary` planners: a segment never opening on a tool
 * result, and merge rounds terminating on summaries larger than their budget.
 *
 * Does not catch: a segment request that itself never answers (the provider
 * watchdog is the only bound), or a merged summary that is fluent and wrong.
 */

const TIMEOUT_MESSAGE = "OpenAI Codex SSE stream stalled while waiting for the next event";

/** A message of about 1.1k tokens, so two dozen of them exceed a 15k segment budget. */
function chunkMessage(index: number): AgentMessage {
	const marker = `[[chunk-${index}]]`;
	const filler = `${marker} step ${index}: read the seam, recorded what it owns, and moved on. `.repeat(60);
	return { role: "user", content: filler, timestamp: Date.now() };
}

function chunks(count: number): AgentMessage[] {
	return Array.from({ length: count }, (_, i) => chunkMessage(i + 1));
}

function chunkMarkers(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `[[chunk-${i + 1}]]`);
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 512,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 512,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	} as AssistantMessage;
}

function errorResponse(message: string): AssistantMessage {
	return { ...assistantText(""), content: [], stopReason: "error", errorMessage: message } as AssistantMessage;
}

/** The codex model with a window small enough that two dozen chunks form several segments. */
function model(contextWindow = 60_000): Model {
	const found = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!found) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return { ...found, contextWindow };
}

function preparation(messages: AgentMessage[], previousSummary?: string): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: Date.now() }],
		isSplitTurn: false,
		tokensBefore: 221_568,
		previousSummary,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

interface RecordedRequest {
	text: string;
	maxTokens: number | undefined;
	kind: "single" | "segment" | "merge";
	conversationTokens: number;
}

function userText(ctx: Context): string {
	const last = ctx.messages[ctx.messages.length - 1];
	if (last?.role !== "user" || typeof last.content === "string") return "";
	return last.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function markersIn(text: string): string[] {
	return [...text.matchAll(/\[\[chunk-\d+\]\]/g)].map(m => m[0]);
}

/**
 * A provider that answers any request whose conversation is at most
 * `answerableTokens` long and never answers a larger one. Segment answers list
 * the chunk markers they read; a merge answer lists every marker its segments
 * listed, so the final summary reports what reached it and in what order.
 */
function fakeProvider(answerableTokens: number) {
	const requests: RecordedRequest[] = [];
	const completeImpl = async (_model: Model, ctx: Context, options: { maxTokens?: number }) => {
		const text = userText(ctx);
		const conversation = text.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)?.[1];
		const kind = text.includes("<segment-summaries>")
			? "merge"
			: /segment \d+ of \d+/i.test(text)
				? "segment"
				: "single";
		const conversationTokens = conversation === undefined ? 0 : (Buffer.byteLength(conversation) + 3) >> 2;
		requests.push({ text, maxTokens: options.maxTokens, kind, conversationTokens });
		if (kind !== "merge" && conversationTokens > answerableTokens) return errorResponse(TIMEOUT_MESSAGE);
		const markers = kind === "merge" ? markersIn(text) : [...new Set(markersIn(conversation ?? ""))];
		return assistantText(`${kind} summary of ${markers.join(" ")}`);
	};
	return { requests, completeImpl };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a large span is summarized in stages", () => {
	test("a single request that times out is retried as segments whose summaries are merged in order", async () => {
		const messages = chunks(24);
		const budget = stagedSegmentBudget(model());
		// The whole span is several budgets; one segment never is.
		const provider = fakeProvider(budget * 1.5);

		const result = await compact(preparation(messages), model(), "test-key", undefined, undefined, {
			completeImpl: provider.completeImpl,
		});

		const kinds = provider.requests.map(r => r.kind);
		expect(kinds[0]).toBe("single");
		const segments = provider.requests.filter(r => r.kind === "segment");
		expect(segments.length).toBeGreaterThanOrEqual(2);
		expect(result.summaryStages).toBe(segments.length);
		expect(kinds.slice(1, 1 + segments.length).every(k => k === "segment")).toBe(true);
		// The planner measures messages one at a time; the joined text is a few tokens longer.
		for (const segment of segments) expect(segment.conversationTokens).toBeLessThanOrEqual(budget + 16);
		// Consecutive segments carry consecutive chunks, none twice and none dropped.
		const seen = segments.flatMap(segment => [...new Set(markersIn(segment.text))]);
		expect(seen).toEqual(chunkMarkers(24));
		// The merge reads every segment summary in order and its answer is the summary.
		expect(provider.requests.filter(r => r.kind === "merge").length).toBeGreaterThanOrEqual(1);
		expect(markersIn(result.summary)).toEqual(seen);
	});

	test("the previous summary and the caller's focus reach the final merge and no segment", async () => {
		const provider = fakeProvider(stagedSegmentBudget(model()));

		await compact(
			preparation(chunks(24), "Earlier: the rail was cooled."),
			model(),
			"test-key",
			"Keep the rail",
			undefined,
			{
				completeImpl: provider.completeImpl,
				summaryStaging: "staged",
			},
		);

		const segments = provider.requests.filter(r => r.kind === "segment");
		expect(segments.length).toBeGreaterThanOrEqual(2);
		for (const segment of segments) {
			expect(segment.text).not.toContain("<previous-summary>");
			expect(segment.text).not.toContain("Keep the rail");
		}
		const merges = provider.requests.filter(r => r.kind === "merge");
		const final = merges[merges.length - 1];
		expect(final?.text).toContain("<previous-summary>\nEarlier: the rail was cooled.\n</previous-summary>");
		expect(final?.text).toContain("Additional focus: Keep the rail");
	});

	test("staging requested by the caller sends no single request first", async () => {
		const provider = fakeProvider(Number.POSITIVE_INFINITY);

		const result = await compact(preparation(chunks(24)), model(), "test-key", undefined, undefined, {
			completeImpl: provider.completeImpl,
			summaryStaging: "staged",
		});

		expect(provider.requests.map(r => r.kind)).not.toContain("single");
		expect(result.summaryStages).toBeGreaterThanOrEqual(2);
	});

	test("a span the window cannot hold as one request is staged without a single attempt, and the estimator admits the model", async () => {
		// 60 chunks are past a 60k window as one request; each segment fits.
		const messages = chunks(60);
		const provider = fakeProvider(Number.POSITIVE_INFINITY);
		const prep = preparation(messages);

		const estimate = estimateCompactionRequestTokens(prep, model(), undefined, {
			completeImpl: provider.completeImpl,
		});
		expect(estimate).toBeLessThanOrEqual(60_000);

		const result = await compact(prep, model(), "test-key", undefined, undefined, {
			completeImpl: provider.completeImpl,
		});

		expect(provider.requests.map(r => r.kind)).not.toContain("single");
		expect(result.summaryStages).toBeGreaterThanOrEqual(2);
		expect(markersIn(result.summary)).toEqual(chunkMarkers(60));
	});

	test("a span of one segment that times out is not retried", async () => {
		const provider = fakeProvider(0);

		await expect(
			compact(preparation(chunks(1)), model(), "test-key", undefined, undefined, {
				completeImpl: provider.completeImpl,
			}),
		).rejects.toThrow(TIMEOUT_MESSAGE);
		expect(provider.requests.map(r => r.kind)).toEqual(["single"]);
	});

	test("a failure that is not a timeout propagates without staging", async () => {
		const requests: string[] = [];
		const completeImpl = async (_model: Model, ctx: Context) => {
			requests.push(userText(ctx));
			return errorResponse("Summarization refused: the model does not exist");
		};

		await expect(
			compact(preparation(chunks(24)), model(), "test-key", undefined, undefined, { completeImpl }),
		).rejects.toThrow("the model does not exist");
		expect(requests).toHaveLength(1);
	});

	/** The signal is read before the fallback: a timeout the caller already abandoned is not retried. */
	test("a cancelled single request is not retried in stages", async () => {
		const controller = new AbortController();
		const requests: string[] = [];
		const completeImpl = async (_model: Model, ctx: Context) => {
			requests.push(userText(ctx));
			controller.abort();
			return errorResponse(TIMEOUT_MESSAGE);
		};

		await expect(
			compact(preparation(chunks(24)), model(), "test-key", undefined, controller.signal, { completeImpl }),
		).rejects.toThrow(TIMEOUT_MESSAGE);
		expect(requests).toHaveLength(1);
	});

	test("without completeImpl the single request still goes through completeSimple once", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText("one summary of the span"));

		const result = await compact(preparation(chunks(1)), model(), "test-key");

		expect(spy.mock.calls).toHaveLength(1);
		expect(result.summaryStages).toBe(1);
	});

	test("merge rounds terminate when every summary exceeds the group budget", () => {
		const oversized = Array.from({ length: 5 }, (_, i) => `summary ${i} `.repeat(400));
		let summaries: string[] = oversized;
		let rounds = 0;
		while (summaries.length > 1) {
			const groups = planMergeGroups(summaries, 10);
			expect(groups.length).toBeLessThan(summaries.length);
			summaries = groups.map(group => group.join("\n"));
			rounds += 1;
			expect(rounds).toBeLessThanOrEqual(oversized.length);
		}
		expect(rounds).toBeGreaterThanOrEqual(1);
	});

	/** A result with no call beside it summarizes as the output of nothing, so a cut never lands before one. */
	test("a segment never opens on a tool result", () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 6; i++) {
			const user = chunkMessage(i);
			if (user.role === "user") messages.push(user);
			const call: AssistantMessage = {
				...assistantText(`calling tool ${i}`),
				content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `file-${i}.ts` } }],
			};
			messages.push(call);
			messages.push({
				role: "toolResult",
				toolCallId: `call-${i}`,
				toolName: "read",
				content: [{ type: "text", text: `[[result-${i}]] line `.repeat(120) }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		// One chunk (about 1.1k tokens) fits a budget the result (about 500 tokens) then exceeds.
		const segments = planSummarySegments(messages, undefined, 1_300);

		expect(segments.length).toBeGreaterThanOrEqual(2);
		for (const segment of segments) {
			expect(segment.text.startsWith("[Tool Result]")).toBe(false);
			expect(segment.tokens).toBeGreaterThan(1_300);
		}
	});
});
