/**
 * WHY: a staged summary of a long span is hundreds of requests, and one failed
 * request threw every completed one away. The next compaction attempt restarted
 * from the first segment, paid for the whole span again, and could fail at the
 * same segment again, so a session never finished compacting.
 *
 * The contract: with a checkpoint map, an attempt after a failure sends only the
 * segment requests that never completed, and the summary it produces still
 * covers every segment in order. A checkpoint is reused only for the same model:
 * a summary one model wrote is never served as another model's answer.
 *
 * Not caught here: checkpoint reuse across a process restart (the map is held in
 * memory), and a span whose segmentation changes between attempts, which reuses
 * only the segments whose prompt text is unchanged.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	type CompactionResult,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Context, Model } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

const CHUNK_COUNT = 24;
const FAILING_MARKER = "[[chunk-10]]";
const ALL_MARKERS = Array.from({ length: CHUNK_COUNT }, (_, i) => `[[chunk-${i + 1}]]`);

/** A message of about 1.1k tokens, so two dozen of them form several segments. */
function chunk(index: number): AgentMessage {
	const marker = `[[chunk-${index}]]`;
	const filler = `${marker} step ${index}: read the seam, recorded what it owns, and moved on. `.repeat(60);
	return { role: "user", content: filler, timestamp: Date.now() };
}

function codexModel(id?: string): Model {
	const found = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!found) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return { ...found, id: id ?? found.id, contextWindow: 60_000 };
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: Array.from({ length: CHUNK_COUNT }, (_, i) => chunk(i + 1)),
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: Date.now() }],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

function response(text: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: errorMessage === undefined ? [{ type: "text", text }] : [],
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
		stopReason: errorMessage === undefined ? "stop" : "error",
		errorMessage,
	} as AssistantMessage;
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
	return [...new Set([...text.matchAll(/\[\[chunk-\d+\]\]/g)].map(m => m[0]))];
}

type CompleteImpl = (model: Model, ctx: Context) => Promise<AssistantMessage>;

/**
 * Records each segment request by the chunk markers it read. The segment that
 * reads FAILING_MARKER fails while `failing` is set. A merge answer lists every
 * marker its segment summaries listed, so the final summary reports what reached it.
 */
class FakeProvider {
	failing = true;
	/** Segment identities (joined markers) in the order they were sent. */
	sent: string[] = [];
	/** Segment identities that were answered. */
	answered = new Set<string>();

	readonly completeImpl: CompleteImpl = async (_model, ctx) => {
		const text = userText(ctx);
		if (text.includes("<segment-summaries>")) return response(`merge of ${markersIn(text).join(" ")}`);
		const conversation = text.match(/<conversation>\n([\s\S]*?)\n<\/conversation>/)?.[1] ?? "";
		const markers = markersIn(conversation);
		const identity = markers.join(" ");
		this.sent.push(identity);
		if (this.failing && markers.includes(FAILING_MARKER)) return response("", "upstream returned 500");
		this.answered.add(identity);
		return response(`segment of ${identity}`);
	};

	nextAttempt(): void {
		this.failing = false;
		this.sent = [];
	}
}

function attempt(
	provider: FakeProvider,
	checkpoints: Map<string, string> | undefined,
	model = codexModel(),
): Promise<CompactionResult> {
	return compact(preparation(), model, "test-key", undefined, undefined, {
		completeImpl: provider.completeImpl,
		summaryStaging: "staged",
		stagedSummaryCheckpoints: checkpoints,
	});
}

describe("a staged summary that failed part way", () => {
	test("resumes with only the segments that never completed and still covers every chunk", async () => {
		const provider = new FakeProvider();
		const checkpoints = new Map<string, string>();
		await expect(attempt(provider, checkpoints)).rejects.toThrow(/summarization failed/);
		const completedFirst = new Set(provider.answered);
		expect(completedFirst.size).toBeGreaterThanOrEqual(1);

		provider.nextAttempt();
		const result = await attempt(provider, checkpoints);

		// No segment answered by the first attempt is sent again.
		expect(provider.sent.filter(identity => completedFirst.has(identity))).toEqual([]);
		// The failed segment is sent again, and every segment is answered exactly once overall.
		expect(provider.sent.some(identity => identity.split(" ").includes(FAILING_MARKER))).toBe(true);
		expect(result.summaryStages).toBe(completedFirst.size + provider.sent.length);
		expect(markersIn(result.summary)).toEqual(ALL_MARKERS);
	});

	test("without a checkpoint map the second attempt sends every segment again", async () => {
		const provider = new FakeProvider();
		await expect(attempt(provider, undefined)).rejects.toThrow(/summarization failed/);

		provider.nextAttempt();
		const result = await attempt(provider, undefined);

		expect(result.summaryStages).toBe(provider.sent.length);
		expect(markersIn(result.summary)).toEqual(ALL_MARKERS);
	});

	test("a checkpoint one model wrote is never served to another model", async () => {
		const provider = new FakeProvider();
		const checkpoints = new Map<string, string>();
		await expect(attempt(provider, checkpoints)).rejects.toThrow(/summarization failed/);

		provider.nextAttempt();
		const result = await attempt(provider, checkpoints, codexModel("gpt-5.1-codex-other"));

		expect(result.summaryStages).toBe(provider.sent.length);
	});
});
