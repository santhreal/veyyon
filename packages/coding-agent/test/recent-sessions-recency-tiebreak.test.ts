/**
 * getRecentSessions recency ordering must be TOTAL and deterministic.
 *
 * The shortlist is sorted newest-first by file mtime (last activity). When
 * mtimes COLLIDE — several sessions written within the same millisecond, which
 * is routine under the in-memory storage and possible on coarse-resolution
 * filesystems — a bare mtime compare returns 0 for every pair. The parallel
 * list collector splits files across workers and flattens the results, so the
 * pre-sort order is already interleaved; with no tiebreak the final order is
 * nondeterministic and once flipped a two-slot shortlist to
 * ["third task", "first task"] on CI while passing locally.
 *
 * These lock the deterministic tiebreak: on an mtime tie, fall back to the
 * session's own recorded start timestamp (newest first), then to the path for a
 * total order. Every session here is stamped with the SAME mtime on purpose so
 * the tiebreak — not wall-clock write timing — decides the order.
 */
import { describe, expect, it } from "bun:test";
import { getRecentSessions } from "@veyyon/coding-agent/session/session-listing";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

const DIR = "/sessions/project";
const TIE_MTIME = 5_000;

function writeSession(
	storage: MemorySessionStorage,
	id: string,
	opts: { firstMessage: string; timestamp: string; mtimeMs?: number },
): void {
	const lines = [
		JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: opts.timestamp }),
		JSON.stringify({ type: "message", message: { role: "user", content: opts.firstMessage } }),
		"",
	];
	const file = `${DIR}/${id}.jsonl`;
	storage.writeTextSync(file, lines.join("\n"));
	storage.setMtimeSync(file, opts.mtimeMs ?? TIE_MTIME);
}

describe("getRecentSessions recency tiebreak (equal mtimes)", () => {
	it("orders same-mtime sessions by recorded start timestamp, newest first", async () => {
		const storage = new MemorySessionStorage();
		// Deliberately author out of both write order and alphabetical order so a
		// stable-by-insertion or name-based sort would give a different answer.
		writeSession(storage, "gamma", { firstMessage: "gamma task", timestamp: "2026-07-22T02:00:00.000Z" });
		writeSession(storage, "beta", { firstMessage: "beta task", timestamp: "2026-07-22T03:00:00.000Z" });
		writeSession(storage, "alpha", { firstMessage: "alpha task", timestamp: "2026-07-22T01:00:00.000Z" });

		const recent = await getRecentSessions(DIR, 3, storage);
		expect(recent.map(s => s.name)).toEqual(["beta task", "gamma task", "alpha task"]);
	});

	it("is stable and deterministic across repeated calls", async () => {
		const storage = new MemorySessionStorage();
		writeSession(storage, "s-c", { firstMessage: "c task", timestamp: "2026-07-22T02:00:00.000Z" });
		writeSession(storage, "s-a", { firstMessage: "a task", timestamp: "2026-07-22T03:00:00.000Z" });
		writeSession(storage, "s-b", { firstMessage: "b task", timestamp: "2026-07-22T01:00:00.000Z" });

		const first = (await getRecentSessions(DIR, 3, storage)).map(s => s.name);
		for (let i = 0; i < 10; i++) {
			expect((await getRecentSessions(DIR, 3, storage)).map(s => s.name)).toEqual(first);
		}
		expect(first).toEqual(["a task", "c task", "b task"]);
	});

	it("breaks a full tie (same mtime AND same timestamp) by path for a total order", async () => {
		const storage = new MemorySessionStorage();
		const ts = "2026-07-22T05:00:00.000Z";
		writeSession(storage, "zeta", { firstMessage: "zeta task", timestamp: ts });
		writeSession(storage, "eta", { firstMessage: "eta task", timestamp: ts });
		writeSession(storage, "theta", { firstMessage: "theta task", timestamp: ts });

		// All three share mtime and start timestamp, so order falls to the path
		// (`/sessions/project/<id>.jsonl`) ascending: eta, theta, zeta.
		const recent = await getRecentSessions(DIR, 3, storage);
		expect(recent.map(s => s.name)).toEqual(["eta task", "theta task", "zeta task"]);
	});

	it("still lets a distinct newer mtime win over the timestamp tiebreak", async () => {
		const storage = new MemorySessionStorage();
		// Oldest recorded start timestamp but the newest mtime (most recent
		// activity) — mtime is primary, so it must sort first.
		writeSession(storage, "touched", {
			firstMessage: "recently touched",
			timestamp: "2026-07-22T01:00:00.000Z",
			mtimeMs: 9_000,
		});
		writeSession(storage, "older", {
			firstMessage: "older activity",
			timestamp: "2026-07-22T09:00:00.000Z",
			mtimeMs: 5_000,
		});

		const recent = await getRecentSessions(DIR, 2, storage);
		expect(recent.map(s => s.name)).toEqual(["recently touched", "older activity"]);
	});
});
