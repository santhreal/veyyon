/**
 * A server-side compaction entry stores OpenAI's compacted window and no
 * readable summary text, because the window IS the compacted context and
 * paying a second model to paraphrase the same span is pure waste (see
 * `remote-compaction.ts`).
 *
 * That trade is only safe because the discarded span is never actually gone:
 * compaction moves `firstKeptEntryId`, and every entry it hid is still on
 * disk. This suite defends the consequence. While the session stays on the
 * provider that minted the window, the rebuild uses the compaction and the
 * window rides along for native replay. The moment it cannot be replayed, a
 * fork or a resume onto a different provider, the entry says nothing at all,
 * so the rebuild MUST re-expand the real messages instead. Treating an empty
 * summary as a valid compaction would hide the span behind a blank divider
 * and lose it from context while it sits untouched in the session file.
 *
 * Nothing here executes a model or a network call: `buildSessionContext` is a
 * pure function from session entries to context.
 */

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai/types";
import { buildSessionContext } from "@veyyon/coding-agent/session/session-context";
import type {
	CompactionEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@veyyon/coding-agent/session/session-entries";

let entryCounter = 0;
let lastId: string | null = null;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.1",
	};
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function modelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `entry-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		model: `${provider}/${modelId}`,
	};
	lastId = id;
	return entry;
}

/** A remote compaction entry as `compactWithProvider` writes one: window, no summary. */
function remoteCompactionEntry(firstKeptEntryId: string, provider: string): CompactionEntry {
	const id = `entry-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary: "",
		firstKeptEntryId,
		tokensBefore: 10000,
		preserveData: {
			remoteCompaction: {
				version: 1,
				provider,
				api: "openai-responses",
				model: "gpt-5.1",
				window: [{ type: "compaction", encrypted_content: "opaque-blob" }],
				compactedAt: new Date().toISOString(),
			},
		},
	};
	lastId = id;
	return entry;
}

function scenario(activeProvider: string, activeModel: string) {
	entryCounter = 0;
	lastId = null;
	const u1 = messageEntry(userMessage("pre-compaction user evidence"));
	const a1 = messageEntry(assistantMessage("pre-compaction assistant evidence"));
	const u2 = messageEntry(userMessage("retained request"));
	const compaction = remoteCompactionEntry(u2.id, "openai");
	const change = modelChangeEntry(activeProvider, activeModel);
	const u3 = messageEntry(userMessage("post-compaction continuation"));
	const entries: SessionEntry[] = [u1, a1, u2, compaction, change, u3];
	return { entries, context: buildSessionContext(entries) };
}

describe("a session still on the provider that minted the window", () => {
	it("uses the compaction and hides the span the window stands for", () => {
		const { context } = scenario("openai", "gpt-5.1");

		expect(context.messages[0]?.role).toBe("compactionSummary");
		expect(JSON.stringify(context.messages)).not.toContain("pre-compaction user evidence");
	});

	it("attaches the window so the provider replays it natively", () => {
		const { context } = scenario("openai", "gpt-5.1");

		expect(JSON.stringify(context.messages[0])).toContain("opaque-blob");
	});
});

describe("a session that switched away from that provider", () => {
	it("re-expands the real messages rather than hiding them behind an empty summary", () => {
		// WHY: the window is an opaque blob only its minting host can decrypt, so
		// after a switch the entry carries nothing. Counting it as a valid
		// compaction loses the span from context while it sits on disk.
		const { context } = scenario("anthropic", "claude-sonnet-4-5");
		const text = JSON.stringify(context.messages);

		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(false);
		expect(text).toContain("pre-compaction user evidence");
		expect(text).toContain("pre-compaction assistant evidence");
		expect(text).toContain("post-compaction continuation");
	});

	it("keeps every turn, not just the ones after the cut", () => {
		const { context } = scenario("anthropic", "claude-sonnet-4-5");

		expect(context.messages.map(message => message.role)).toEqual(["user", "assistant", "user", "user"]);
	});
});

describe("an entry that can neither replay nor explain itself", () => {
	it("re-expands when the stored window is malformed", () => {
		// A window with no `compaction` item is not a compacted window, so the
		// reader rejects it. With no summary either, the entry is empty.
		entryCounter = 0;
		lastId = null;
		const u1 = messageEntry(userMessage("pre-compaction user evidence"));
		const u2 = messageEntry(userMessage("retained request"));
		const broken: CompactionEntry = {
			type: "compaction",
			id: "broken",
			parentId: u2.id,
			timestamp: new Date().toISOString(),
			summary: "",
			firstKeptEntryId: u2.id,
			tokensBefore: 10000,
			preserveData: {
				remoteCompaction: { version: 1, provider: "openai", api: "openai-responses", model: "gpt-5.1", window: [] },
			},
		};
		lastId = "broken";
		const u3 = messageEntry(userMessage("post-compaction continuation"));

		const context = buildSessionContext([u1, u2, broken, u3]);

		expect(context.messages.some(message => message.role === "compactionSummary")).toBe(false);
		expect(JSON.stringify(context.messages)).toContain("pre-compaction user evidence");
	});

	it("still honours a real local summary, which explains the span on any provider", () => {
		entryCounter = 0;
		lastId = null;
		const u1 = messageEntry(userMessage("pre-compaction user evidence"));
		const u2 = messageEntry(userMessage("retained request"));
		const local: CompactionEntry = {
			type: "compaction",
			id: "local",
			parentId: u2.id,
			timestamp: new Date().toISOString(),
			summary: "The operator asked for a fix and it landed.",
			firstKeptEntryId: u2.id,
			tokensBefore: 10000,
		};
		lastId = "local";
		const u3 = messageEntry(userMessage("post-compaction continuation"));

		const context = buildSessionContext([u1, u2, local, u3]);

		expect(context.messages[0]?.role).toBe("compactionSummary");
		expect(JSON.stringify(context.messages)).not.toContain("pre-compaction user evidence");
	});
});
