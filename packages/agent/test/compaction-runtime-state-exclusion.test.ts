import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction, type SessionEntry } from "@veyyon/agent-core/compaction";
import type { AssistantMessage } from "@veyyon/ai";

function messageEntry(id: string, parentId: string | undefined, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-03T00:00:00.000Z",
		message,
	} as SessionEntry;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 20_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20_100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

describe("compaction runtime-state exclusion", () => {
	/**
	 * Runtime-owned continuity snapshots are reconstructed from authoritative
	 * machine state after compaction. Feeding an old snapshot to the summarizer
	 * duplicates stale todos, blockers, paths, and verification evidence.
	 */
	test("excludes configured custom-message types from every compaction partition", () => {
		const entries = [
			messageEntry("user-1", undefined, { role: "user", content: "Start the migration", timestamp: 1 }),
			{
				type: "custom_message",
				id: "continuity-1",
				parentId: "user-1",
				timestamp: "2026-08-03T00:00:01.000Z",
				customType: "compaction-continuity",
				content: "STALE_MACHINE_STATE",
				display: false,
			},
			messageEntry("assistant-1", "continuity-1", assistantMessage("Migration started")),
			messageEntry("user-2", "assistant-1", {
				role: "user",
				content: "Continue the migration",
				timestamp: 2,
			}),
		] as SessionEntry[];

		const preparation = prepareCompaction(
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 },
			{ excludedCustomMessageTypes: new Set(["compaction-continuity"]) },
		);
		if (!preparation) throw new Error("Expected compaction preparation");

		const partitionedContext = JSON.stringify([
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
			...preparation.recentMessages,
		]);
		expect(partitionedContext).not.toContain("STALE_MACHINE_STATE");
		expect(partitionedContext).toContain("Start the migration");
		expect(partitionedContext).toContain("Continue the migration");
	});
});
