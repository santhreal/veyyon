import { describe, expect, it } from "bun:test";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import {
	generateId,
	migrateSessionEntries,
	migrateToCurrentVersion,
} from "@veyyon/coding-agent/session/session-migrations";

describe("migrateSessionEntries", () => {
	it("should add id/parentId to v1 entries", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
			{
				type: "message",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// Header should have version set to current
		expect((entries[0] as any).version).toBe(3);

		// Entries should have id/parentId
		const msg1 = entries[1] as any;
		const msg2 = entries[2] as any;

		expect(msg1.id).toBeDefined();
		expect(msg1.id.length).toBe(8);
		expect(msg1.parentId).toBeNull();

		expect(msg2.id).toBeDefined();
		expect(msg2.id.length).toBe(8);
		expect(msg2.parentId).toBe(msg1.id);
	});

	it("should be idempotent (skip already migrated)", () => {
		const entries: FileEntry[] = [
			{ type: "session", id: "sess-1", version: 2, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
			{
				type: "message",
				id: "abc12345",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
			{
				type: "message",
				id: "def67890",
				parentId: "abc12345",
				timestamp: "2025-01-01T00:00:02Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					api: "test",
					provider: "test",
					model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
					stopReason: "stop",
					timestamp: 2,
				},
			},
		] as FileEntry[];

		migrateSessionEntries(entries);

		// IDs should be unchanged
		expect((entries[1] as any).id).toBe("abc12345");
		expect((entries[2] as any).id).toBe("def67890");
		expect((entries[2] as any).parentId).toBe("abc12345");
	});
});

/**
 * migrateToCurrentVersion is the entry point migrateSessionEntries wraps, and it returns whether it
 * changed anything. The existing tests cover the v1->v2 id/parent tree, but three behaviors were
 * unpinned: the v2->v3 hookMessage->custom role rename, the v1->v2 compaction pointer conversion
 * (firstKeptEntryIndex -> firstKeptEntryId), and the boolean return contract. A regression in any of
 * these silently corrupts a resumed session (a lost legacy custom message, a compaction that no
 * longer knows where its retained history begins, or a needless rewrite of an up-to-date file).
 */
describe("migrateToCurrentVersion", () => {
	it("renames the legacy hookMessage role to custom on the v2->v3 step and reports a change", () => {
		const entries = [
			{ type: "session", id: "s", version: 2, timestamp: "t", cwd: "/tmp" },
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "t1",
				message: { role: "hookMessage", customType: "x", content: "c", display: true, timestamp: 1 },
			},
			{
				type: "message",
				id: "b",
				parentId: "a",
				timestamp: "t2",
				message: { role: "user", content: "hi", timestamp: 2 },
			},
		] as unknown as FileEntry[];

		expect(migrateToCurrentVersion(entries)).toBe(true);
		expect((entries[0] as any).version).toBe(3);
		expect((entries[1] as any).message.role).toBe("custom");
		// A non-hook message is left alone.
		expect((entries[2] as any).message.role).toBe("user");
	});

	it("converts a v1 compaction's firstKeptEntryIndex into the retained entry's new id", () => {
		const entries = [
			{ type: "session", id: "s", timestamp: "t", cwd: "/tmp" },
			{ type: "message", timestamp: "t1", message: { role: "user", content: "hi", timestamp: 1 } },
			{ type: "compaction", timestamp: "t2", firstKeptEntryIndex: 1, summary: "s" },
		] as unknown as FileEntry[];

		expect(migrateToCurrentVersion(entries)).toBe(true);
		const keptMessage = entries[1] as any;
		const compaction = entries[2] as any;
		expect(keptMessage.id.length).toBe(8);
		expect(compaction.firstKeptEntryId).toBe(keptMessage.id);
		expect("firstKeptEntryIndex" in compaction).toBe(false);
	});

	it("returns false and mutates nothing when the session is already at the current version", () => {
		const entries = [
			{ type: "session", id: "s", version: 3, timestamp: "t", cwd: "/tmp" },
			{
				type: "message",
				id: "a",
				parentId: null,
				timestamp: "t1",
				message: { role: "user", content: "hi", timestamp: 1 },
			},
		] as unknown as FileEntry[];
		const before = JSON.stringify(entries);

		expect(migrateToCurrentVersion(entries)).toBe(false);
		expect(JSON.stringify(entries)).toBe(before);
	});

	it("treats a missing session header as v1 and migrates the entries", () => {
		const entries = [
			{ type: "message", timestamp: "t1", message: { role: "user", content: "hi", timestamp: 1 } },
		] as unknown as FileEntry[];

		expect(migrateToCurrentVersion(entries)).toBe(true);
		expect((entries[0] as any).id.length).toBe(8);
	});
});

/**
 * generateId mints a short (8-char) session-entry id, retrying on collision against a caller-supplied
 * membership set and falling back to a full Snowflake id only after 100 collisions. It had no direct
 * test. The contracts pinned here are the ones an id-collision regression would break:
 *   - a fresh id is 8 lowercase-hex characters (the tail of a random UUID) and the membership set is
 *     consulted once when there is no collision;
 *   - on collision it retries, consulting the set again, and returns the first id that is not present
 *     (N collisions -> N+1 checks);
 *   - after 100 straight collisions it stops retrying and returns a longer Snowflake id, having probed
 *     the set exactly 100 times (the retry cap is real, not unbounded).
 */
describe("generateId", () => {
	it("returns an 8-char hex id and checks membership once when there is no collision", () => {
		let checks = 0;
		const id = generateId({
			has: () => {
				checks++;
				return false;
			},
		});
		expect(id).toMatch(/^[0-9a-f]{8}$/);
		expect(checks).toBe(1);
	});

	it("retries past collisions and returns the first free id", () => {
		let checks = 0;
		const id = generateId({
			has: () => {
				checks++;
				return checks <= 3; // first three ids "exist", fourth is free
			},
		});
		expect(id).toMatch(/^[0-9a-f]{8}$/);
		expect(checks).toBe(4);
	});

	it("falls back to a longer Snowflake id after exactly 100 collisions", () => {
		let checks = 0;
		const id = generateId({
			has: () => {
				checks++;
				return true; // every candidate collides
			},
		});
		expect(checks).toBe(100);
		expect(id.length).toBeGreaterThan(8);
	});
});
