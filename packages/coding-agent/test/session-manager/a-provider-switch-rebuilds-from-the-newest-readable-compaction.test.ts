/**
 * WHY: a session that compacted server-side on one provider and then ran on
 * another rebuilt its context from the FIRST entry on the branch. The newest
 * compaction held a window only its minting provider can decrypt, the rebuild
 * treated that entry as the only candidate, found it unusable, and re-expanded
 * every message the branch ever held, although an earlier local summary covered
 * all but the span since it. On a long session that was a request of millions of
 * tokens that no provider accepts.
 *
 * The class: any rebuild on a provider that cannot read the newest compaction.
 * The sweep runs every provider in the bundled catalog, so a new provider arrives
 * covered, and pins that only the minting provider replays the window.
 *
 * Not caught here: whether the unreadable window is later ported into text (see
 * an-unreadable-server-compaction-is-ported-before-the-prompt.test.ts), and a
 * provider added to the catalog at runtime rather than bundled.
 */

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { REMOTE_COMPACTION_PRESERVE_KEY, type RemoteCompactionPreserveData } from "@veyyon/agent-core/compaction";
import { getBundledProviders } from "@veyyon/catalog/models";
import { buildSessionContext, getEffectiveCompactionEntry } from "@veyyon/kernel/session/session-context";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "@veyyon/kernel/session/session-entries";

const MINTING_PROVIDER = "openai";
const LOCAL_SUMMARY = "Local summary of the ancient span.";

function msg(id: string, parentId: string, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") return { ...base, message: { role, content: text, timestamp: 1 } };
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: MINTING_PROVIDER,
			model: "gpt-5.1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function localCompaction(id: string, parentId: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:01:00Z",
		summary: LOCAL_SUMMARY,
		firstKeptEntryId,
		tokensBefore: 50_000,
	};
}

function remoteCompaction(id: string, parentId: string, firstKeptEntryId: string): CompactionEntry {
	const data: RemoteCompactionPreserveData = {
		version: 1,
		provider: MINTING_PROVIDER,
		api: "openai-responses",
		model: "gpt-5.1",
		window: [{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" }],
		compactedAt: "2025-01-01T00:02:00Z",
	};
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:02:00Z",
		// What `compactWithProvider` writes: the window and no summary text.
		summary: "",
		firstKeptEntryId,
		tokensBefore: 200_000,
		preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: data },
	};
}

/** A local compaction, a span after it, then a server-side compaction and a tail. */
function branchOn(activeModel: string): SessionEntry[] {
	return [
		{ type: "model_change", id: "model-0", parentId: null, timestamp: "2025-01-01T00:00:00Z", model: activeModel },
		msg("m-1", "model-0", "user", "ancient turn"),
		msg("m-2", "m-1", "assistant", "ancient reply"),
		msg("m-3", "m-2", "user", "kept by local"),
		localCompaction("local-1", "m-3", "m-3"),
		msg("m-4", "local-1", "user", "between turn"),
		msg("m-5", "m-4", "assistant", "between reply"),
		msg("m-6", "m-5", "user", "kept by remote"),
		remoteCompaction("remote-1", "m-6", "m-6"),
		msg("m-7", "remote-1", "user", "after remote"),
	];
}

function texts(messages: AgentMessage[]): string[] {
	return messages.map(message => {
		if (message.role === "compactionSummary") {
			return message.providerPayload ? "<window>" : `<summary:${message.summary}>`;
		}
		if (message.role === "user") return typeof message.content === "string" ? message.content : "<blocks>";
		if (message.role === "assistant") {
			return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
		}
		return `<${message.role}>`;
	});
}

describe("a provider that cannot read the newest compaction rebuilds from the newest one it can", () => {
	test("a foreign provider resumes from the local summary, not from the first entry", () => {
		expect(texts(buildSessionContext(branchOn("xai-oauth/grok-4")).messages)).toEqual([
			`<summary:${LOCAL_SUMMARY}>`,
			"kept by local",
			"between turn",
			"between reply",
			"kept by remote",
			"after remote",
		]);
	});

	test("the minting provider replays the window over the local summary", () => {
		expect(texts(buildSessionContext(branchOn(`${MINTING_PROVIDER}/gpt-5.1`)).messages)).toEqual([
			"<window>",
			"kept by remote",
			"after remote",
		]);
	});

	test("every bundled provider: only the minting provider replays the window, none resends the ancient span", () => {
		const providers = getBundledProviders();
		expect(providers).toContain(MINTING_PROVIDER);
		const replayers: string[] = [];
		for (const provider of providers) {
			const branch = branchOn(`${provider}/any-model`);
			const rendered = texts(buildSessionContext(branch).messages);
			expect(rendered).not.toContain("ancient turn");
			const effective = getEffectiveCompactionEntry(branch, provider);
			if (effective?.id === "remote-1") replayers.push(provider);
			else expect(effective?.id).toBe("local-1");
			expect(rendered[0]).toBe(effective?.id === "remote-1" ? "<window>" : `<summary:${LOCAL_SUMMARY}>`);
		}
		expect(replayers).toEqual([MINTING_PROVIDER]);
	});

	test("a collapsed transcript follows the same compaction the model context does", () => {
		const rendered = texts(
			buildSessionContext(branchOn("xai-oauth/grok-4"), undefined, undefined, {
				transcript: true,
				collapseCompactedHistory: true,
			}).messages,
		);
		expect(rendered).not.toContain("ancient turn");
		expect(rendered).toContain(`<summary:${LOCAL_SUMMARY}>`);
		expect(rendered).toContain("between turn");
	});
});
