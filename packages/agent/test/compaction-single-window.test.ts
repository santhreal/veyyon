import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	assertValidCompactionResult,
	type CompactionEntry,
	type CompactionPreparation,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";

/**
 * Server-side compaction is single-window: when `compaction.remote` is on and
 * `resolveServerCompactionTransport` admits the model, the window the provider
 * returns IS the artifact and the entry's `summary` is empty. veyyon never
 * writes a local summary beside that window, so every part of the pipeline that
 * assumed summary text has to handle its absence.
 *
 * Two places did not, and each cost the whole span.
 *
 * The commit validator rejected every empty summary, so a paid, successful
 * round trip was thrown away with "the generated summary is empty" and history
 * was never trimmed. The write path could not complete at all.
 *
 * `hasReusableSummary` counted a current remote entry as a reusable prior
 * compaction, so `prepareCompaction` adopted it with a `previousSummary` of ""
 * and left the messages behind the window collapsed. The next local pass then
 * strips the window. Neither summarized nor replayable: lost.
 */

const WINDOW = [
	{ type: "message", role: "user", content: "retained item" },
	{ type: "compaction", encrypted_content: "opaque-blob" },
];

function remotePreserveData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		[REMOTE_COMPACTION_PRESERVE_KEY]: {
			version: 1,
			provider: "openai",
			api: "openai-responses",
			model: "gpt-5.1",
			window: WINDOW,
			compactedAt: new Date().toISOString(),
			...overrides,
		},
	};
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "safe-cut-point",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		recentMessages: [],
		isSplitTurn: false,
		tokensBefore: 50_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

function makeUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function makeMessageEntry(id: string, parentId: string | undefined, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: makeUserMessage(text),
	} as SessionEntry;
}

function makeCompactionEntry(overrides: Partial<CompactionEntry>): CompactionEntry {
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

describe("a remote compaction result survives commit validation", () => {
	/**
	 * The shape `compactWithProvider` actually returns. Rejecting it meant a
	 * billed round trip whose window was discarded and whose history never moved.
	 */
	test("an empty summary is accepted when a well-formed remote window is present", () => {
		const result = {
			summary: "",
			firstKeptEntryId: "safe-cut-point",
			tokensBefore: 50_000,
			preserveData: remotePreserveData(),
		};

		expect(assertValidCompactionResult(preparation(), result)).toBeUndefined();
	});

	/**
	 * The still-fatal case, and the reason the rule is conditional rather than
	 * removed. A local pass that produced no text has nothing standing in for the
	 * span it wants to discard.
	 */
	test("an empty summary with no remote window still throws", () => {
		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "   ",
				firstKeptEntryId: "safe-cut-point",
				tokensBefore: 50_000,
			}),
		).toThrow("no server-side compaction window was stored");
	});

	/**
	 * Presence of the key is not the test. A payload that fails validation cannot
	 * be replayed by any reader, so accepting it on the key alone would commit a
	 * cut point backed by nothing.
	 */
	test("an empty summary with a malformed remote window still throws", () => {
		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "",
				firstKeptEntryId: "safe-cut-point",
				// No `compaction` item: not a compacted window, so nothing replays.
				preserveData: remotePreserveData({ window: [{ type: "message", role: "user", content: "hi" }] }),
				tokensBefore: 50_000,
			}),
		).toThrow("malformed");
	});

	/** The window does not buy a pass on the rest. Both other rules still bite. */
	test("the remaining assertions apply to a remote result unchanged", () => {
		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "",
				firstKeptEntryId: "some-other-entry",
				tokensBefore: 50_000,
				preserveData: remotePreserveData(),
			}),
		).toThrow("does not match the safe cut point");

		expect(() =>
			assertValidCompactionResult(preparation(), {
				summary: "",
				firstKeptEntryId: "safe-cut-point",
				tokensBefore: Number.NaN,
				preserveData: remotePreserveData(),
			}),
		).toThrow("finite non-negative");
	});
});

describe("a remote compaction entry is not a reusable prior summary", () => {
	/**
	 * The history-loss case. Adopting the remote entry hands the next pass an
	 * empty `previousSummary` and hides "pre-compaction work" behind a window the
	 * same pass is about to strip.
	 */
	test("prepareCompaction re-expands the messages behind a current remote entry", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("msg-1", undefined, "pre-compaction work"),
			makeCompactionEntry({
				id: "compaction-remote",
				summary: "",
				preserveData: remotePreserveData(),
			}),
			makeMessageEntry("msg-2", "compaction-remote", "post-compaction work"),
		];

		const prepared = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 });

		expect(prepared).toBeDefined();
		expect(JSON.stringify(prepared?.messagesToSummarize ?? [])).toContain("pre-compaction work");
		expect(prepared?.previousSummary).toBeUndefined();
	});

	/** A dead legacy entry keeps behaving exactly as it did. */
	test("prepareCompaction re-expands the messages behind a legacy entry", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("msg-1", undefined, "pre-compaction work"),
			makeCompactionEntry({
				id: "compaction-legacy",
				summary: "Remote compaction preserved provider-native history for this session.",
				preserveData: { openaiRemoteCompaction: { provider: "openai-codex", replacementHistory: [{}] } },
			}),
			makeMessageEntry("msg-2", "compaction-legacy", "post-compaction work"),
		];

		const prepared = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 });

		expect(prepared).toBeDefined();
		expect(JSON.stringify(prepared?.messagesToSummarize ?? [])).toContain("pre-compaction work");
	});

	/**
	 * The over-reach guard. An ordinary local compaction still gets adopted: its
	 * summary is real, so re-expanding behind it would throw away a summary
	 * veyyon paid for and re-summarize the same span every single pass.
	 */
	test("an ordinary local compaction entry stays reusable", () => {
		const entries: SessionEntry[] = [
			makeMessageEntry("msg-1", undefined, "pre-compaction work"),
			makeCompactionEntry({
				id: "compaction-local",
				summary: "## Goal\nShip the release script fix.",
			}),
			makeMessageEntry("msg-2", "compaction-local", "post-compaction work"),
		];

		const prepared = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 });

		expect(prepared).toBeDefined();
		expect(prepared?.previousSummary).toBe("## Goal\nShip the release script fix.");
		expect(JSON.stringify(prepared?.messagesToSummarize ?? [])).not.toContain("pre-compaction work");
	});
});
