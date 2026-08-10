import { describe, expect, it, spyOn } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { KEEP_NOTHING_ENTRY_ID, resolveCompactionBoundaryIndex } from "@veyyon/agent-core/compaction/entries";
import type { TextContent } from "@veyyon/ai";
import * as logger from "@veyyon/utils/logger";
import type { CompactionSummaryMessage } from "./messages";
import { buildSessionContext, type StrippedToolCallsMarker } from "./session-context";
import type { SessionEntry } from "./session-entries";

const timestamp = "2026-07-09T00:00:00.000Z";

// A compaction persisted by the removed image-archive engine: preserveData
// carries a `snapcompact` slot whose `text` is the full archived source (the
// frames were only an image duplicate of it). On rebuild the session now
// re-attaches that source as a plain text block, never as image frames.
const LEGACY_ARCHIVE_SOURCE = "archived line one\narchived line two";

const compactedEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "before compaction" }], timestamp: 1 },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "m1",
		timestamp,
		summary: "summary",
		firstKeptEntryId: "m1",
		tokensBefore: 123,
		preserveData: {
			snapcompact: {
				frames: [{ data: "base64-frame", mimeType: "image/png", cols: 10, rows: 10, chars: 100 }],
				totalChars: 100,
				truncatedChars: 0,
				text: LEGACY_ARCHIVE_SOURCE,
				textHead: "head",
				textTail: "tail",
			},
		},
	},
	{
		type: "message",
		id: "m2",
		parentId: "c1",
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "after compaction" }], timestamp: 2 },
	},
] satisfies SessionEntry[];

function compactionSummary(messages: AgentMessage[]): CompactionSummaryMessage {
	const summary = messages.find(
		(message): message is CompactionSummaryMessage => message.role === "compactionSummary",
	);
	if (!summary) throw new Error("Expected a compaction summary message");
	return summary;
}

describe("buildSessionContext legacy image-archive recovery", () => {
	it("omits legacy archive blocks from collapsed transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});

		const summary = compactionSummary(context.messages);

		expect(summary.images).toBeUndefined();
		expect(summary.blocks).toBeUndefined();
	});

	it("recovers the legacy archive source as a text block in full transcript summaries", () => {
		const context = buildSessionContext(compactedEntries, undefined, undefined, { transcript: true });

		const summary = compactionSummary(context.messages);

		// Never image frames: exactly one recovered text block carrying the source.
		expect(summary.images).toBeUndefined();
		expect(summary.blocks?.map(block => block.type)).toEqual(["text"]);
		expect((summary.blocks![0] as TextContent).text).toContain(LEGACY_ARCHIVE_SOURCE);
	});

	it("recovers the legacy archive source as a text block in provider context summaries", () => {
		const context = buildSessionContext(compactedEntries);

		const summary = compactionSummary(context.messages);

		expect(summary.images).toBeUndefined();
		expect(summary.blocks?.map(block => block.type)).toEqual(["text"]);
		expect((summary.blocks![0] as TextContent).text).toContain(LEGACY_ARCHIVE_SOURCE);
	});
});

// A turn whose tool is still executing at rebuild time: the assistant message
// (with its toolCall) is persisted at message_end, the toolResult is not.
const danglingToolCallEntries = [
	{
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
	},
	{
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 60" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 2,
		},
	},
] satisfies SessionEntry[];

function danglingCallIds(messages: AgentMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.push(block.id);
		}
	}
	return ids;
}

describe("buildSessionContext dangling toolCalls", () => {
	it("strips a dangling toolCall from the transcript but keeps the turn with a stripped marker", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, { transcript: true });

		expect(danglingCallIds(context.messages)).toEqual([]);
		// The turn survives (even content-less) carrying the marker so the TUI
		// renders a placeholder row instead of silently erasing the activity.
		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content).toEqual([]);
		expect((assistant as AgentMessage & StrippedToolCallsMarker).strippedToolCalls).toBe(1);
	});

	it("keeps a dangling toolCall in transcript mode with keepDanglingToolCalls", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			transcript: true,
			keepDanglingToolCalls: true,
		});

		expect(danglingCallIds(context.messages)).toEqual(["call-1"]);
	});

	it("always strips dangling toolCalls from the LLM context and drops the emptied turn", () => {
		const context = buildSessionContext(danglingToolCallEntries, undefined, undefined, {
			keepDanglingToolCalls: true,
		});

		expect(danglingCallIds(context.messages)).toEqual([]);
		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
	});
});
/**
 * WHY: a compaction keeps a tail of pre-compaction entries verbatim and names the first
 * of them in `firstKeptEntryId`. The rebuild used to resolve that marker with a private
 * walk that only asked "have I seen the id yet", which answers "keep nothing" to all
 * three of the field's cases, so a marker that resolves to nothing silently removed
 * every kept turn from the model's context and from the transcript while the summary
 * made the session look whole. Two producers reach it with no operator mistake: the
 * loader drops a record it cannot parse (so the marker can name a record that is gone),
 * and the v1 migration left the field unset whenever the old numeric index pointed at
 * the header. The prune and shake passes read the same field through the shared reader,
 * which treats an unresolvable id as "the whole branch is live", so they rewrote entries
 * this rebuild refused to send.
 *
 * The class this closes: the rebuild and the shared reader answer the same question the
 * same way for EVERY value the field can hold. The last row derives its expectation from
 * `resolveCompactionBoundaryIndex` rather than restating it, so a fourth case added to
 * the reader is covered the moment it exists, and the rows above it pin each present
 * case by name so the parity row cannot pass by agreeing on the wrong answer.
 *
 * What it does NOT catch: whether the summary text is worth what it replaced, and the
 * choice to re-expand rather than refuse. Re-expansion overlaps the summary by a few
 * turns, which costs context and loses nothing.
 */

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	} satisfies SessionEntry;
}

/** Two kept entries, a usable compaction carrying `marker`, and one turn after it. */
function markerEntries(marker: string | undefined): SessionEntry[] {
	const compaction = {
		type: "compaction",
		id: "c1",
		parentId: "k2",
		timestamp,
		summary: "the summary that stands in for the discarded span",
		tokensBefore: 100,
		...(marker === undefined ? {} : { firstKeptEntryId: marker }),
	} as unknown as SessionEntry;
	return [
		userEntry("k1", null, "kept one"),
		userEntry("k2", "k1", "kept two"),
		compaction,
		userEntry("a1", "c1", "after compaction"),
	];
}

/** The user texts the provider context carries, in order. The summary is a separate role. */
function contextUserTexts(entries: SessionEntry[]): string[] {
	const context = buildSessionContext(entries);
	const texts: string[] = [];
	for (const message of context.messages) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text") texts.push(part.text);
		}
	}
	return texts;
}

describe("the entries a compaction keeps", () => {
	it("keeps from the entry the marker names", () => {
		expect(contextUserTexts(markerEntries("k2"))).toEqual(["kept two", "after compaction"]);
	});

	it("keeps nothing for the keep-nothing sentinel", () => {
		// One unbreakable oversized turn: the sentinel names no entry on purpose, and
		// re-expanding there would undo the only compaction that could free anything.
		expect(contextUserTexts(markerEntries(KEEP_NOTHING_ENTRY_ID))).toEqual(["after compaction"]);
	});

	it("re-expands the span when the marker names a record that is gone", () => {
		expect(contextUserTexts(markerEntries("k0-was-dropped-by-the-loader"))).toEqual([
			"kept one",
			"kept two",
			"after compaction",
		]);
	});

	it("re-expands the span for a migrated session that has no marker", () => {
		expect(contextUserTexts(markerEntries(undefined))).toEqual(["kept one", "kept two", "after compaction"]);
	});

	it("agrees with the shared reader for every value the marker can hold", () => {
		const markers = ["k1", "k2", KEEP_NOTHING_ENTRY_ID, "k0-was-dropped-by-the-loader", undefined];
		for (const marker of markers) {
			const entries = markerEntries(marker);
			const compactionIdx = entries.findIndex(entry => entry.type === "compaction");
			const keptFrom = resolveCompactionBoundaryIndex(entries, marker);
			const expected = entries.slice(Math.min(keptFrom, compactionIdx), compactionIdx).map(entry => {
				// `AgentMessage` includes members with no `content` at all (a bash execution),
				// so the fixture's own text is read through a guard rather than a cast.
				if (entry.type !== "message" || !("content" in entry.message)) return "";
				const content = entry.message.content;
				return Array.isArray(content) ? ((content[0] as TextContent | undefined)?.text ?? "") : "";
			});
			expect(contextUserTexts(entries)).toEqual([...expected, "after compaction"]);
		}
	});

	it("names the damage when it re-expands, and stays quiet when the marker resolves", () => {
		// A silent re-expansion is how the old loss stayed invisible: the number of turns
		// the model sees changed and nothing anywhere said why.
		const warn = spyOn(logger, "warn");
		const said = (): unknown[][] =>
			warn.mock.calls.filter(call => String(call[0]).includes("Compaction keep marker names no entry"));
		try {
			contextUserTexts(markerEntries("k0-was-dropped-by-the-loader"));
			expect(said().length).toBe(1);
			expect(said()[0]?.[1]).toEqual({ compactionId: "c1", firstKeptEntryId: "k0-was-dropped-by-the-loader" });
			warn.mockClear();
			contextUserTexts(markerEntries(undefined));
			expect(said().length).toBe(1);
			warn.mockClear();
			contextUserTexts(markerEntries("k2"));
			contextUserTexts(markerEntries(KEEP_NOTHING_ENTRY_ID));
			expect(said()).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});
