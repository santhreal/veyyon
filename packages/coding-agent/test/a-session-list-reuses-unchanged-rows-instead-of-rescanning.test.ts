/**
 * `/resume` re-derived every row from the session files on every open.
 *
 * THE DEFECT. The picker reads a head and tail window of each file and parses
 * it. The head window is 4 KB, sized for a prefix that holds the first user
 * message, and when it does not the scan escalates to a 1 MB read. On a real
 * profile the first user message sits about 100 KB in, so the escalation is
 * nearly every file: 4,825 sessions read 3.3 GB and took 6.8 s to list, and
 * repeated it in full every time the picker opened, for files that had not been
 * written since the last one. Measured after the index: 89 ms.
 *
 * THE CLASS. Not "listing is slow" but "a derived row is recomputed when
 * nothing it derives from changed, and a cache that avoids that must be
 * invisible in the result". Both halves are load-bearing, and the second is the
 * one that silently breaks: a cache is correct only while a stale row cannot
 * outlive the bytes it describes. So the suite pins the reuse AND pins every
 * way a row goes stale — a rewrite that keeps the byte count, a file that grew,
 * a deleted session, an index from a build whose scanner differs, a damaged
 * index, and a row that has no answer for the question being asked.
 *
 * `kernel/src/session/session-list-index.ts` holds the index; the listing in
 * `kernel/src/session/session-listing.ts` consults it.
 *
 * WHAT IT DOES NOT CATCH. A write that changes a file's contents while leaving
 * BOTH size and mtime untouched is served stale, and no test here can see it,
 * because within this contract such a file is indistinguishable from one that
 * was never written. That is the deliberate bound of the reuse key, not an
 * oversight: mtime alone misses an append inside one filesystem tick, size
 * alone misses an equal-length rewrite, and the two together miss only a
 * rewrite that forges the timestamp. It also does not cover concurrent listings
 * racing on the index file; the last writer wins and every row it drops is
 * rescanned next open, which is a slow path, not a wrong one.
 */
import { describe, expect, it } from "bun:test";
import { listSessions, listSessionsReadOnly } from "@veyyon/kernel/session/session-listing";
import { MemorySessionStorage } from "@veyyon/kernel/session/session-storage";

const DIR = "/sessions/project";
const INDEX = `${DIR}/.session-list-index.json`;
const TS = "2026-07-22T00:00:00.000Z";

function session(id: string, ...messages: [role: "user" | "assistant", text: string][]): string {
	return [
		JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: TS }),
		// The shape that makes the scan expensive, and so the shape worth caching:
		// a large pre-message entry that pushes the first message past the prefix.
		JSON.stringify({ type: "custom", payload: "x".repeat(100_000), timestamp: TS }),
		...messages.map(([role, content]) => JSON.stringify({ type: "message", message: { role, content } })),
		"",
	].join("\n");
}

/** A storage that counts the windowed reads the scanner pays for. */
function countingStorage(): { storage: MemorySessionStorage; reads: () => number } {
	const storage = new MemorySessionStorage();
	let reads = 0;
	const original = storage.readTextSlices.bind(storage);
	storage.readTextSlices = async (file, prefix, suffix) => {
		reads++;
		return original(file, prefix, suffix);
	};
	return { storage, reads: () => reads };
}

describe("a session list reuses unchanged rows instead of rescanning", () => {
	it("returns exactly what the full scan returned", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${DIR}/a.jsonl`,
			session("a", ["user", "fix the detector policy"], ["assistant", "on it"]),
		);
		storage.writeTextSync(`${DIR}/b.jsonl`, session("b", ["user", "ship the release"]));
		// Explicit mtimes, because the list is ordered by recency and two writes in
		// one millisecond leave that order undecided: the assertion below would then
		// compare two differently-tied sorts and fail on a fast machine only.
		storage.setMtimeSync(`${DIR}/a.jsonl`, 2_000);
		storage.setMtimeSync(`${DIR}/b.jsonl`, 1_000);

		const scanned = await listSessions(DIR, storage);
		const reused = await listSessions(DIR, storage);

		expect(reused).toEqual(scanned);
		expect(reused.map(s => s.firstMessage)).toEqual(["fix the detector policy", "ship the release"]);
	});

	it("does not read the session files a second time", async () => {
		const { storage, reads } = countingStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "fix the detector policy"]));

		await listSessions(DIR, storage);
		const afterScan = reads();
		await listSessions(DIR, storage);

		// The first open pays the prefix read AND the escalated read; the second
		// pays neither. Pinned exactly: a reuse that still touched the file would
		// be a cache that saves nothing.
		expect(afterScan).toBe(2);
		expect(reads()).toBe(afterScan);
	});

	it("rescans a session rewritten in place at the same size", async () => {
		const storage = new MemorySessionStorage();
		const before = session("a", ["user", "aaaaa"]);
		storage.writeTextSync(`${DIR}/a.jsonl`, before);
		await listSessions(DIR, storage);

		const after = session("a", ["user", "bbbbb"]);
		expect(after.length).toBe(before.length);
		storage.writeTextSync(`${DIR}/a.jsonl`, after);
		storage.setMtimeSync(`${DIR}/a.jsonl`, Date.now() + 1000);

		const [listed] = await listSessions(DIR, storage);
		expect(listed?.firstMessage).toBe("bbbbb");
	});

	it("rescans a session that grew", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "hello"]));
		const [first] = await listSessions(DIR, storage);
		expect(first?.messageCount).toBe(1);

		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "hello"], ["assistant", "hi"]));
		const [second] = await listSessions(DIR, storage);
		expect(second?.messageCount).toBe(2);
	});

	it("drops the row of a deleted session", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "keep"]));
		storage.writeTextSync(`${DIR}/b.jsonl`, session("b", ["user", "delete"]));
		await listSessions(DIR, storage);

		await storage.unlink(`${DIR}/b.jsonl`);
		const listed = await listSessions(DIR, storage);

		expect(listed.map(s => s.id)).toEqual(["a"]);
		// The row must be gone from the index too, or the index grows without
		// bound and outlives the directory it describes.
		expect(storage.readTextSync(INDEX) ?? "").not.toContain("b.jsonl");
	});

	it("ignores an index written by a build whose scanner differs", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "the real first message"]));
		await listSessions(DIR, storage);

		const written = JSON.parse(storage.readTextSync(INDEX) ?? "{}") as {
			version: number;
			rows: Record<string, { firstMessage: string }>;
		};
		const row = written.rows[`${DIR}/a.jsonl`];
		expect(row).toBeDefined();
		row.firstMessage = "a row from another build";
		storage.writeTextSync(INDEX, JSON.stringify({ ...written, version: written.version + 1 }));

		const [listed] = await listSessions(DIR, storage);
		expect(listed?.firstMessage).toBe("the real first message");
	});

	it("falls back to a full scan when the index is damaged", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "still listable"]));
		storage.writeTextSync(INDEX, "{ this is not json");

		const [listed] = await listSessions(DIR, storage);
		expect(listed?.firstMessage).toBe("still listable");
	});

	it("writes no index from the listing that promises not to mutate the directory", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "hello"]));

		const listed = await listSessionsReadOnly(DIR, storage);

		expect(listed.map(s => s.id)).toEqual(["a"]);
		expect(storage.readTextSync(INDEX)).toBeUndefined();
	});

	it("still reuses an existing index when it may not write one", async () => {
		const { storage, reads } = countingStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "hello"]));
		await listSessions(DIR, storage);
		const afterScan = reads();

		const listed = await listSessionsReadOnly(DIR, storage);

		expect(listed.map(s => s.firstMessage)).toEqual(["hello"]);
		// Reading the index is not a mutation, so the reuse still applies.
		expect(reads()).toBe(afterScan);
	});

	it("does not answer a status request from a row scanned without one", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/a.jsonl`, session("a", ["user", "hello"], ["assistant", "done"]));
		await listSessions(DIR, storage);
		const written = JSON.parse(storage.readTextSync(INDEX) ?? "{}") as {
			version: number;
			rows: Record<string, { firstMessage: string; withStatus: boolean; status?: string }>;
		};
		const row = written.rows[`${DIR}/a.jsonl`];
		expect(row?.status).toBe("complete");
		// Doctored so that serving the row is visible in the result.
		row.firstMessage = "served from the index";
		storage.writeTextSync(INDEX, JSON.stringify(written));
		expect((await listSessions(DIR, storage))[0]?.firstMessage).toBe("served from the index");

		// The row an earlier build's welcome shortlist wrote: same file, scanned without the tail
		// window, so it holds no status.
		row.withStatus = false;
		delete row.status;
		storage.writeTextSync(INDEX, JSON.stringify(written));
		const [listed] = await listSessions(DIR, storage);

		expect(listed?.status).toBe("complete");
		expect(listed?.firstMessage).toBe("hello");
	});
});
