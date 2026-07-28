import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	CompactionCancelledError,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
	generateHandoffFromContext,
	generateSummary,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Context, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * An empty model response is never a valid compaction result, and accepting one
 * is the worst failure either strategy has because it reports success.
 *
 * Observed live during the 2026-07-25 counterfactual: `handoff x
 * gemini-3.6-flash` returned `stopReason: "stop"` with 268 output tokens and NO
 * text content, having spent its whole budget on reasoning. The caller then
 * appended the deterministic `<files>` block, so the result looked like a real
 * 688-character document. A session restored from it would have opened with a
 * file list and no goal, no decisions, and no next step. Two repeat runs on the
 * same input produced healthy ~6.9k documents, so this is an intermittent
 * provider behavior, which is exactly why it needs a guard rather than a retry
 * by hand.
 *
 * For `summary` the same response is worse: the summary REPLACES the history it
 * summarizes, so storing an empty one deletes the conversation.
 */

function makeEmptyStop(text?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text === undefined ? [] : [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 268,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 268,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	} as AssistantMessage;
}

function makeAborted(text?: string): AssistantMessage {
	return { ...makeEmptyStop(text), stopReason: "aborted" };
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function getModel(): Model {
	const model = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!model) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return model;
}

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("history msg")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

async function expectCanonicalCancellation(request: Promise<unknown>): Promise<void> {
	const error = await request.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(CompactionCancelledError);
	expect((error as Error).message).toBe("Compaction cancelled");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("an empty model response is never accepted as a compaction result", () => {
	/**
	 * The exact live failure. Without the guard the deterministic `<files>` block
	 * is appended to nothing and returned as a successful handoff document.
	 */
	test("an empty handoff document raises instead of returning the files block alone", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeEmptyStop());
		const fileOps = createFileOps();
		fileOps.read.add("crates/scanner/src/engine/process.rs");

		await expect(
			generateHandoff([makeUserMessage("do the work")], getModel(), "test-key", {
				systemPrompt: ["sp"],
				tools: [],
				fileOps,
			}),
		).rejects.toThrow(/empty document/i);
	});

	/** Whitespace-only output is empty too; trimming is what makes the check real. */
	test("a whitespace-only handoff document raises", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeEmptyStop("   \n\t  "));

		await expect(
			generateHandoff([makeUserMessage("do the work")], getModel(), "test-key", { systemPrompt: ["sp"], tools: [] }),
		).rejects.toThrow(/empty document/i);
	});

	/**
	 * The compaction must not proceed. An empty summary replacing real history is
	 * unrecoverable, so the error has to reach the caller rather than be stored.
	 */
	test("an empty summary raises and does not compact the history", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeEmptyStop());

		await expect(compact(makePreparation(), getModel(), "test-key")).rejects.toThrow(/empty summary/i);
	});

	/** A real document is still returned unchanged; the guard is not a filter. */
	test("a non-empty handoff document passes through", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeEmptyStop("## Goal\nShip the fix."));

		const document = await generateHandoff([makeUserMessage("do the work")], getModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
		});

		expect(document).toContain("Ship the fix.");
	});
});

describe("aborted compaction completions always use the canonical cancellation error", () => {
	const abortedOutputs = [
		{ label: "empty", text: undefined },
		{ label: "partial", text: "partial summary that must never be accepted" },
	] as const;

	for (const output of abortedOutputs) {
		/**
		 * `generateSummary` replaces real history. An aborted response must not
		 * become success merely because the provider emitted partial text first.
		 */
		test(`generateSummary rejects ${output.label} aborted output`, async () => {
			await expectCanonicalCancellation(
				generateSummary(
					[makeUserMessage("history")],
					getModel(),
					1024,
					"test-key",
					undefined,
					undefined,
					undefined,
					{
						completeImpl: async () => makeAborted(output.text),
					},
				),
			);
		});

		/**
		 * The cache-preserving handoff entry point is public and can be invoked
		 * directly by a host, so it owns the same typed cancellation contract.
		 */
		test(`generateHandoffFromContext rejects ${output.label} aborted output`, async () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [{ role: "user", content: "history", timestamp: Date.now() }],
			};
			await expectCanonicalCancellation(
				generateHandoffFromContext(context, getModel(), {
					streamOptions: { apiKey: "test-key" },
					completeImpl: async () => makeAborted(output.text),
				}),
			);
		});

		/** The convenience handoff export must propagate the same sentinel. */
		test(`generateHandoff rejects ${output.label} aborted output`, async () => {
			await expectCanonicalCancellation(
				generateHandoff([makeUserMessage("history")], getModel(), "test-key", {
					systemPrompt: ["system"],
					completeImpl: async () => makeAborted(output.text),
				}),
			);
		});

		/** `compact` must stop before its short-summary fan-out after cancellation. */
		test(`compact rejects ${output.label} aborted history-summary output`, async () => {
			await expectCanonicalCancellation(
				compact(makePreparation(), getModel(), "test-key", undefined, undefined, {
					completeImpl: async () => makeAborted(output.text),
				}),
			);
		});

		/** A late abort from the private short-summary path must also escape typed. */
		test(`compact rejects ${output.label} aborted short-summary output`, async () => {
			let calls = 0;
			await expectCanonicalCancellation(
				compact(makePreparation(), getModel(), "test-key", undefined, undefined, {
					completeImpl: async () => {
						calls += 1;
						return calls === 1 ? makeEmptyStop("history summary") : makeAborted(output.text);
					},
				}),
			);
			expect(calls).toBe(2);
		});

		/** Split-turn prefix summarization is another destructive compact fan-out. */
		test(`compact rejects ${output.label} aborted turn-prefix output`, async () => {
			const splitPreparation = makePreparation();
			splitPreparation.messagesToSummarize = [];
			splitPreparation.turnPrefixMessages = [makeUserMessage("partial current turn")];
			splitPreparation.isSplitTurn = true;
			await expectCanonicalCancellation(
				compact(splitPreparation, getModel(), "test-key", undefined, undefined, {
					completeImpl: async () => makeAborted(output.text),
				}),
			);
		});
	}
});
