import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
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
