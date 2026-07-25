import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionEntry,
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	generateHandoff,
	LEGACY_REMOTE_PRESERVE_KEYS,
	prepareCompaction,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * Compaction has exactly two strategies — `summary` and `handoff` — and no
 * provider gets a private history format.
 *
 * The removed path was OpenAI's provider-native remote compaction
 * (`/responses/compact` plus the Responses V2 streaming variant). It was gated
 * on `model.provider === "openai" || "openai-codex"` alone, so it switched
 * itself on for every codex session without the operator asking. What it
 * produced was not a summary: the durable history became an opaque
 * `encrypted_content` blob only OpenAI could read, and the compaction entry's
 * `summary` field was overwritten with the fixed string
 * "Remote compaction preserved provider-native history for this session."
 *
 * That cost real sessions real work. A transcript from 2026-07-25 (session
 * 019f974f) opened on `google-antigravity/gemini-3.1-pro`, switched to
 * `openai-codex/gpt-5.6-sol` fifteen seconds later, then compacted five times.
 * Every one of those five compactions stored a blob no other provider could
 * replay and a placeholder where the summary belonged, so the session log
 * carries no readable record of 3.8 hours of work.
 *
 * These tests fail if any of that comes back.
 */

const REMOVED_PLACEHOLDER = "Remote compaction preserved provider-native history for this session.";

function makeAssistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

/** The exact provider that used to receive the private compaction path. */
function getCodexModel(): Model {
	const model = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!model) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return model;
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("history msg"), makeAssistantStop("history reply")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
		...overrides,
	};
}

function makeCompactionEntry(overrides: Partial<CompactionEntry> = {}): CompactionEntry {
	return {
		type: "compaction",
		id: "compaction-1",
		parentId: "msg-1",
		timestamp: new Date().toISOString(),
		summary: "prior summary text",
		firstKeptEntryId: "msg-1",
		tokensBefore: 100_000,
		...overrides,
	} as CompactionEntry;
}

function makeMessageEntry(id: string, parentId: string | undefined, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message } as SessionEntry;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction: no provider gets a private compaction path", () => {
	/**
	 * The headline contract. A codex model is the one that used to trigger the
	 * provider-native path on provider identity alone. It must now summarize
	 * locally like every other model, and the stored summary must be the model's
	 * real text — never the placeholder that replaced it.
	 */
	test("a codex model compacts to real summary text, not the provider-native placeholder", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("## Goal\nShip the release script fix."));

		const result = await compact(makePreparation(), getCodexModel(), "test-key");

		expect(result.summary).toContain("Ship the release script fix.");
		expect(result.summary).not.toContain(REMOVED_PLACEHOLDER);
		expect(result.summary).not.toContain("provider replay payload");
	});

	/**
	 * The placeholder carried a token count taken from the compaction request's
	 * own `usage.inputTokens` — it reported 256,903 "retained" when what was
	 * actually kept was a ~20 KB blob. Nothing may reintroduce that claim.
	 */
	test("no compaction result claims tokens were retained in a replay payload", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("real summary"));

		const result = await compact(makePreparation(), getCodexModel(), "test-key");

		expect(result.summary).not.toMatch(/Retained \d+ tokens/);
		expect(result.shortSummary).not.toBe("Remote compaction");
	});

	/**
	 * The path was reachable only through these settings knobs. Their absence is
	 * the structural guarantee that no code can switch it back on by config.
	 */
	test("compaction settings expose no provider-native gating knobs", () => {
		const settings = DEFAULT_COMPACTION_SETTINGS as unknown as Record<string, unknown>;

		expect("remoteEnabled" in settings).toBe(false);
		expect("remoteStreamingV2Enabled" in settings).toBe(false);
		expect("v2RetainedMessageBudget" in settings).toBe(false);
		// The configurable summarizer endpoint stays: it returns summary TEXT and
		// is the `summary` strategy over a different transport, not a private
		// provider format.
		expect(DEFAULT_COMPACTION_SETTINGS.strategy).toBe("summary");
	});

	/**
	 * Back-compat, and the reason LEGACY_REMOTE_PRESERVE_KEYS still exists.
	 * Sessions compacted before the removal hold an unreadable payload behind a
	 * placeholder summary. prepareCompaction must look straight past such an
	 * entry and re-expand the original messages, otherwise that history is
	 * stranded and the session resumes from a placeholder.
	 */
	test("prepareCompaction re-expands history behind a legacy provider-native entry", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("msg-1", undefined, makeUserMessage("pre-compaction work")),
			makeCompactionEntry({
				id: "compaction-legacy",
				summary: REMOVED_PLACEHOLDER,
				preserveData: { openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: [{}] } },
			}),
			makeMessageEntry("msg-2", "compaction-legacy", makeUserMessage("post-compaction work")),
		];

		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 });

		expect(preparation).toBeDefined();
		const summarized = JSON.stringify(preparation?.messagesToSummarize ?? []);
		expect(summarized).toContain("pre-compaction work");
		// The placeholder must not be carried forward as if it were a summary.
		expect(preparation?.previousSummary).not.toBe(REMOVED_PLACEHOLDER);
	});

	/**
	 * The dead payload must not be copied into the new entry. Left in place it
	 * would ride along forever, and any future reader could mistake it for a
	 * live replay handle.
	 */
	test("a legacy provider-native payload is dropped, not copied into the new entry", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("fresh local summary"));

		const result = await compact(
			makePreparation({
				previousPreserveData: {
					openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: [{}] },
					somethingElse: "kept",
				},
			}),
			getCodexModel(),
			"test-key",
		);

		expect(result.preserveData?.openaiRemoteCompaction).toBeUndefined();
		expect(result.preserveData?.compactionV2).toBeUndefined();
		// Unrelated preserve data survives — the drop is targeted, not a wipe.
		expect(result.preserveData?.somethingElse).toBe("kept");
	});

	/**
	 * Both strategies must hand the next turn the same deterministic map of what
	 * was touched. `upsertFileOperations` output is machine-generated, costs no
	 * LLM work, and is byte-identical across models, yet it used to be appended to
	 * `summary` only. That was measurable: on identical input a handoff carried 9
	 * file paths where the summary of the same history carried 15. If handoff
	 * stops emitting the block, it silently gets worse again for free.
	 */
	test("handoff appends the same deterministic files block as summary", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("## Goal\nShip it."));
		const fileOps = createFileOps();
		fileOps.read.add("crates/scanner/src/engine/process.rs");
		fileOps.edited.add("scripts/publish_release_assets.py");

		const handoff = await generateHandoff([makeUserMessage("do the work")], getCodexModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
			fileOps,
		});

		expect(handoff).toContain("<files>");
		expect(handoff).toContain("process.rs");
		expect(handoff).toContain("publish_release_assets.py");
	});

	/** Without fileOps the caller gets the document unchanged, no empty block. */
	test("handoff omits the files block when there are no file operations", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("## Goal\nShip it."));

		const handoff = await generateHandoff([makeUserMessage("do the work")], getCodexModel(), "test-key", {
			systemPrompt: ["sp"],
			tools: [],
		});

		expect(handoff).not.toContain("<files>");
	});

	/**
	 * Guards the key list itself. Both keys were written to real session files on
	 * disk; dropping either from this list silently strands those sessions.
	 */
	test("both legacy preserve keys stay recognized", () => {
		expect([...LEGACY_REMOTE_PRESERVE_KEYS]).toEqual(["openaiRemoteCompaction", "compactionV2"]);
	});

	/**
	 * The strongest check: compaction must not reach the provider's compaction
	 * endpoint at all. A summarization call goes through `completeSimple`; any
	 * direct POST to /responses/compact means the native path is back.
	 */
	test("compacting a codex model never calls a provider compaction endpoint", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("local summary"));
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await compact(makePreparation(), getCodexModel(), "test-key");

		const compactCalls = fetchSpy.mock.calls.filter(([input]) => String(input).includes("/responses/compact"));
		expect(compactCalls).toEqual([]);
	});
});
