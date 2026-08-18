import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	assertValidCompactionResult,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateBranchSummary,
	generateHandoff,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * A compaction summary that repeats itself is refused, and the history it would
 * have replaced survives.
 *
 * WHY. The defect class is generated text that stands in for discarded history
 * while describing none of it. Emptiness was already refused, in three places,
 * because an empty summary deletes the conversation and reports success. A
 * degenerate summary — one sentence sampled until the budget runs out — is the
 * same loss wearing content: it passes every emptiness check, it is stored, it
 * is displayed, and every later turn reads the repeat as its own past.
 *
 * It is reachable by design, not by accident. Compaction generates through
 * `completeSimple`, and `resolveWithThinkingLoopCook` re-samples a loop-guard
 * stall three times and then runs one final pass with the guard DISABLED so a
 * stubborn loop returns the model's raw output instead of a fatal stall. That is
 * correct for a live turn, which is on screen while it happens and can be
 * interrupted. It is wrong for text that replaces the span it claims to
 * describe, and nothing between that decision and the durable write looked at
 * the bytes.
 *
 * Every artifact a compaction can leave behind is covered, because the reported
 * one is never the only member: the local summary (`generateSummary`, exercised
 * through the real `compact()` engine), a summary from any other source at the
 * commit gate (`assertValidCompactionResult`, the last call before a runtime
 * rewrites history, and the only seam a remote or hook-produced summary passes),
 * the handoff document that seeds the next session, and the branch summary that
 * stands for a discarded branch. The two that discard history refuse; the branch
 * summary degrades to its explicit fallback and logs, because a throw there would
 * block a branch switch on a provider hiccup, which is the reason its empty case
 * does not throw either.
 *
 * What this does NOT catch. Degeneracy that is not a verbatim back-to-back
 * repeat: a summary that paraphrases itself eight times, or one that is fluent
 * and simply wrong. The segment-similarity and lexical-stall heuristics that
 * would see the former are calibrated against reasoning streams and would
 * reject good summaries, which restate by construction — the negative controls
 * below are what pin that decision. Nor does it see a summary that was already
 * written to disk by an older build; nothing rereads a stored summary.
 */

/** Six back-to-back repeats, 258 chars: past the 4-repeat and 180-char floors. */
const DEGENERATE_UNIT = "Then the rail cooled and the block settled. ";
const DEGENERATE_RUN = DEGENERATE_UNIT.repeat(6);

/** Boundary units: 4×45 is exactly the 180-char floor, 4×44 is one short of it, and
 *  a 75-char sentence tripled clears the char floor while staying under four repeats. */
const UNIT_45 = "Then the rail cooled and the block settled.".padEnd(45);
const UNIT_44 = "Then the rail cooled and the block settled.".padEnd(44);
const LONG_UNIT = "Then the rail cooled and the block settled quietly into history.".padEnd(75);

/** Prose long enough that the ladder actually runs, with no repeated unit in it. */
const CLEAN_PROSE = [
	"Goal: land the compaction guard and prove it with counters.",
	"A session arrived whose summary was one sentence written over and over.",
	"Decisions so far: reject at the generator, and again at the commit gate.",
	"Files touched: compaction.ts for the gate, thinking-loop.ts for the detector.",
	"Next: run the account bucket, then regenerate the root changelog.",
].join("\n\n");

/** A long tail of lines that are similar but never identical, so no verbatim unit
 *  repeats inside it. Used to push a buried run out of the trailing window. */
function uniqueProse(lines: number, tag: string): string {
	return Array.from(
		{ length: lines },
		(_, i) => `${tag} step ${i + 1}: read the seam, recorded what it owns, and moved on.`,
	).join("\n");
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

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function model(): Model {
	const found = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!found) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return found;
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [userMessage("history msg")],
		turnPrefixMessages: [],
		recentMessages: [userMessage("recent msg")],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

function committed(summary: string, shortSummary?: string) {
	return {
		summary,
		shortSummary,
		firstKeptEntryId: "kept-1",
		tokensBefore: 221_568,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a summary that repeats itself never replaces the history", () => {
	/** The shape the cooked loop hands back: the repeat is the whole summary. */
	test("the engine refuses a summary that is one sentence sampled to the budget", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText(DEGENERATE_RUN));

		const error = await compact(preparation(), model(), "test-key").catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/degenerate summary/i);
		// The reason names the repeat, so the report is actionable without a rerun.
		expect((error as Error).message).toContain("Then the rail cooled and the block settled.");
		expect((error as Error).message).toContain("6×");
		expect((error as Error).message).toContain("was NOT compacted");
	});

	/**
	 * The streamed guard reads a rolling tail because it aborts on the first hit.
	 * A completed summary is not read that way: the sampler recovers, writes a
	 * tidy closing paragraph, and a tail-only check sees nothing wrong. This is
	 * the arm that goes red if the sweep is collapsed back to one tail read.
	 */
	test("the engine refuses a summary that degenerates in the middle and then recovers", async () => {
		const buried = `${uniqueProse(4, "early")}\n\n${DEGENERATE_RUN}\n\n${uniqueProse(18, "late")}`;
		// The run is out of reach of a tail-only read: the trailing window holds none of it.
		expect(buried.slice(-900)).not.toContain(DEGENERATE_UNIT);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText(buried));

		await expect(compact(preparation(), model(), "test-key")).rejects.toThrow(/degenerate summary/i);
	});

	/**
	 * The fence. A summary restates by construction: parallel bullets, the same
	 * topic twice, a repeated file path. None of that is a sampler loop, and a
	 * guard that rejects it makes long sessions uncompactable.
	 */
	test("a summary whose structure repeats but whose text does not is compacted normally", async () => {
		const structured = [
			"- Read `packages/tui/src/tui.ts` and found the paint seam at #emitFullPaint.",
			"- Read `packages/tui/src/terminal.ts` and found the DEC 2026 probe at line 548.",
			"- Read `packages/agent/src/compaction/compaction.ts` and found the summary gate.",
			"- Read `packages/ai/src/utils/thinking-loop.ts` and found the verbatim detector.",
			"",
			"The paint seam is the owner. The probe is the owner. The gate is the owner.",
		].join("\n");
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText(structured));

		const result = await compact(preparation(), model(), "test-key");

		expect(result.summary).toContain("#emitFullPaint");
		expect(result.summary).toContain("The gate is the owner.");
	});

	/**
	 * Both floors decide, and they are the streamed guard's own: four repeats, and
	 * 180 chars of them. A summary is refused on exactly the shape a live turn is
	 * interrupted on, so one text cannot be a loop in the transcript and a
	 * compaction in the archive.
	 */
	test("the loop-guard floors decide, not the presence of a duplicate", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText("placeholder"));
		const accepted = [
			// Three repeats of a 75-char sentence: 225 chars is past the char floor, and
			// three repeats is short of the repeat floor.
			LONG_UNIT.repeat(3),
			// Four repeats of 44 chars: 176, one short of the 180-char floor.
			UNIT_44.repeat(4),
			// Ten repeats of four chars: a refrain, 40 chars in total.
			"no. ".repeat(10),
		];
		for (const run of accepted) {
			spy.mockResolvedValue(assistantText(`${CLEAN_PROSE}\n\n${run}`));
			await expect(compact(preparation(), model(), "test-key")).resolves.toBeDefined();
		}

		// Four repeats of 45 chars: exactly 180, and the floor is inclusive.
		expect(UNIT_45.repeat(4)).toHaveLength(180);
		spy.mockResolvedValue(assistantText(`${CLEAN_PROSE}\n\n${UNIT_45.repeat(4)}`));
		await expect(compact(preparation(), model(), "test-key")).rejects.toThrow(/degenerate summary/i);
	});

	/** A repeated row carrying no letter is a table, and tables are summary content. */
	test("a repeated numeric row is not a loop", async () => {
		const table = `${CLEAN_PROSE}\n\n${"| 0.0 | 0.0 | 1.0 | ---- |\n".repeat(12)}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText(table));

		await expect(compact(preparation(), model(), "test-key")).resolves.toBeDefined();
	});
});

describe("the commit gate refuses a degenerate summary it did not generate", () => {
	/**
	 * A remote summarizer and a compaction hook never pass through the local
	 * generator, so the gate immediately before the history rewrite is the only
	 * seam their text crosses.
	 */
	test("a degenerate summary from any source is refused before history is rewritten", () => {
		expect(() => assertValidCompactionResult(preparation(), committed(DEGENERATE_RUN))).toThrow(
			/generated summary is degenerate/i,
		);
	});

	/** The short summary is display text, and it reaches the session list and the share projection. */
	test("a degenerate short summary is refused even beside a healthy summary", () => {
		expect(() => assertValidCompactionResult(preparation(), committed(CLEAN_PROSE, DEGENERATE_RUN))).toThrow(
			/generated shortSummary is degenerate/i,
		);
	});

	/** The gate stays a gate: a healthy pair passes and neither field is rewritten. */
	test("a healthy result passes the gate byte for byte", () => {
		const result = committed(`  ${CLEAN_PROSE}  `, "Landed the compaction guard");

		expect(assertValidCompactionResult(preparation(), result)).toBeUndefined();
		expect(result.summary).toBe(`  ${CLEAN_PROSE}  `);
		expect(result.shortSummary).toBe("Landed the compaction guard");
	});
});

describe("the other artifacts a compaction leaves behind refuse the same shape", () => {
	/**
	 * A handoff seeds the next session. The deterministic `<files>` block lands on
	 * whatever the model produced, so a repeat arrives looking like a real document
	 * of a plausible size — the same disguise the empty case wears.
	 */
	test("a degenerate handoff document is refused instead of being handed the files block", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistantText(DEGENERATE_RUN));

		const error = await generateHandoff([userMessage("do the work")], model(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
		}).catch((caught: unknown) => caught);

		expect((error as Error).message).toMatch(/degenerate document/i);
		expect((error as Error).message).toContain("Then the rail cooled and the block settled.");
	});

	/**
	 * A branch summary stands for a branch that is being left behind, and its file
	 * lists are computed here rather than generated, so the explicit fallback keeps
	 * the entry useful. Refusing outright would block the branch switch itself.
	 */
	test("a degenerate branch summary degrades to the explicit fallback and keeps its file lists", async () => {
		const result = await generateBranchSummary(
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: { role: "user", content: "summarize me", timestamp: 0 },
				},
			],
			{
				model: model(),
				apiKey: "test-key",
				signal: new AbortController().signal,
				completeImpl: async () => assistantText(DEGENERATE_RUN),
			},
		);

		expect(result).toEqual({ summary: "No summary generated", readFiles: [], modifiedFiles: [] });
	});

	/** The fallback is not a filter: a healthy branch summary keeps its own text. */
	test("a healthy branch summary is returned with its preamble", async () => {
		const result = await generateBranchSummary(
			[
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message: { role: "user", content: "summarize me", timestamp: 0 },
				},
			],
			{
				model: model(),
				apiKey: "test-key",
				signal: new AbortController().signal,
				completeImpl: async () => assistantText(CLEAN_PROSE),
			},
		);

		expect(result.summary).toContain("Goal: land the compaction guard");
	});
});
