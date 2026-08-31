import { describe, expect, it } from "bun:test";
import {
	getToolResultMessage,
	KEEP_NOTHING_ENTRY_ID,
	resolveCompactionBoundaryIndex,
	type SessionEntry,
} from "../src/compaction/entries";

function makeEntry(overrides: Partial<SessionEntry> & { type: string; id: string }): SessionEntry {
	return {
		parentId: null,
		timestamp: "2024-01-01T00:00:00Z",
		...overrides,
	} as SessionEntry;
}

function makeMessageEntry(id: string, message: { role: string }): SessionEntry {
	return makeEntry({ type: "message", id, message } as unknown as SessionEntry);
}

describe("KEEP_NOTHING_ENTRY_ID", () => {
	it("is the sentinel string", () => {
		expect(KEEP_NOTHING_ENTRY_ID).toBe("compaction:keep-nothing");
	});
});

describe("getToolResultMessage", () => {
	it("returns undefined for non-message entry", () => {
		const entry = makeEntry({ type: "compaction", id: "c1", summary: "test" } as unknown as SessionEntry);
		expect(getToolResultMessage(entry)).toBeUndefined();
	});
	it("returns undefined for non-toolResult message", () => {
		const entry = makeMessageEntry("m1", { role: "user" });
		expect(getToolResultMessage(entry)).toBeUndefined();
	});
	it("returns undefined for assistant message", () => {
		const entry = makeMessageEntry("m1", { role: "assistant" });
		expect(getToolResultMessage(entry)).toBeUndefined();
	});
	it("returns message for toolResult message", () => {
		const entry = makeMessageEntry("m1", { role: "toolResult" });
		const result = getToolResultMessage(entry);
		expect(result).toBeDefined();
	});
});

describe("resolveCompactionBoundaryIndex", () => {
	it("returns 0 when keepBoundaryId is undefined", () => {
		const entries: SessionEntry[] = [makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry)];
		expect(resolveCompactionBoundaryIndex(entries, undefined)).toBe(0);
	});
	it("returns index of matching entry id", () => {
		const entries: SessionEntry[] = [
			makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry),
			makeEntry({ type: "message", id: "e2" } as unknown as SessionEntry),
			makeEntry({ type: "message", id: "e3" } as unknown as SessionEntry),
		];
		expect(resolveCompactionBoundaryIndex(entries, "e2")).toBe(1);
	});
	it("returns 0 when id not found", () => {
		const entries: SessionEntry[] = [makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry)];
		expect(resolveCompactionBoundaryIndex(entries, "nonexistent")).toBe(0);
	});
	it("returns index after last compaction for KEEP_NOTHING_ENTRY_ID", () => {
		const entries: SessionEntry[] = [
			makeEntry({ type: "compaction", id: "c1", summary: "s1" } as unknown as SessionEntry),
			makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry),
			makeEntry({ type: "compaction", id: "c2", summary: "s2" } as unknown as SessionEntry),
			makeEntry({ type: "message", id: "e2" } as unknown as SessionEntry),
		];
		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBe(3);
	});
	it("returns 0 for KEEP_NOTHING_ENTRY_ID when no compaction entries", () => {
		const entries: SessionEntry[] = [makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry)];
		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBe(0);
	});
	it("returns 0 for KEEP_NOTHING_ENTRY_ID with empty entries", () => {
		expect(resolveCompactionBoundaryIndex([], KEEP_NOTHING_ENTRY_ID)).toBe(0);
	});
	it("returns 0 for empty entries with undefined boundary", () => {
		expect(resolveCompactionBoundaryIndex([], undefined)).toBe(0);
	});
	it("handles single compaction entry with KEEP_NOTHING", () => {
		const entries: SessionEntry[] = [
			makeEntry({ type: "compaction", id: "c1", summary: "s1" } as unknown as SessionEntry),
		];
		expect(resolveCompactionBoundaryIndex(entries, KEEP_NOTHING_ENTRY_ID)).toBe(1);
	});
	it("finds boundary at first entry", () => {
		const entries: SessionEntry[] = [
			makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry),
			makeEntry({ type: "message", id: "e2" } as unknown as SessionEntry),
		];
		expect(resolveCompactionBoundaryIndex(entries, "e1")).toBe(0);
	});
	it("finds boundary at last entry", () => {
		const entries: SessionEntry[] = [
			makeEntry({ type: "message", id: "e1" } as unknown as SessionEntry),
			makeEntry({ type: "message", id: "e2" } as unknown as SessionEntry),
		];
		expect(resolveCompactionBoundaryIndex(entries, "e2")).toBe(1);
	});
});
