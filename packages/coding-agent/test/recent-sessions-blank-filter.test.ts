/**
 * getRecentSessions blank filter — the welcome hero's "continue where you
 * left off" shortlist. Every launch persists a fresh empty session file, so
 * without this filter the hero's continue line pointed at the CURRENT
 * launch's own blank session ("Untitled · 11:48 AM · just now — /resume"),
 * a self-referential shortcut to nothing (found by live capture 2026-07-22).
 *
 * Locks:
 *  1. A session with neither title nor user message never reaches the list.
 *  2. Sessions named by their first user message survive the filter.
 *  3. A titled session with no messages is NOT blank (the human named it).
 *  4. The limit counts surviving sessions — blanks do not eat slots.
 */
import { describe, expect, it } from "bun:test";
import { getRecentSessions } from "@veyyon/coding-agent/session/session-listing";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

const DIR = "/sessions/project";

function writeSession(
	storage: MemorySessionStorage,
	id: string,
	opts: { title?: string; firstMessage?: string; modified?: string },
): void {
	const timestamp = opts.modified ?? "2026-07-22T00:00:00.000Z";
	const lines: string[] = [];
	if (opts.title) {
		lines.push(JSON.stringify({ type: "title", v: 1, title: opts.title, updatedAt: timestamp }));
	}
	lines.push(JSON.stringify({ type: "session", id, cwd: "/repo", timestamp }));
	if (opts.firstMessage) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: opts.firstMessage } }));
	}
	lines.push("");
	storage.writeTextSync(`${DIR}/${id}.jsonl`, lines.join("\n"));
}

describe("getRecentSessions blank filter", () => {
	it("skips sessions with neither title nor user message", async () => {
		const storage = new MemorySessionStorage();
		writeSession(storage, "blank", {});
		writeSession(storage, "real", { firstMessage: "fix the detector policy" });
		const recent = await getRecentSessions(DIR, 4, storage);
		expect(recent.map(s => s.name)).toEqual(["fix the detector policy"]);
	});

	it("keeps a titled session even when it has no messages yet", async () => {
		const storage = new MemorySessionStorage();
		writeSession(storage, "titled", { title: "gpu identity work" });
		const recent = await getRecentSessions(DIR, 4, storage);
		expect(recent.map(s => s.name)).toEqual(["gpu identity work"]);
	});

	it("never labels a shortlist row 'Untitled'", async () => {
		const storage = new MemorySessionStorage();
		writeSession(storage, "blank-a", {});
		writeSession(storage, "blank-b", {});
		writeSession(storage, "real", { firstMessage: "refactor the walker" });
		const recent = await getRecentSessions(DIR, 4, storage);
		for (const row of recent) expect(row.name).not.toContain("Untitled");
	});

	it("fills the limit with surviving sessions — blanks do not eat slots", async () => {
		const storage = new MemorySessionStorage();
		// Newest first by modified time: a blank ahead of three real sessions.
		writeSession(storage, "blank", { modified: "2026-07-22T04:00:00.000Z" });
		writeSession(storage, "one", { firstMessage: "first task", modified: "2026-07-22T03:00:00.000Z" });
		writeSession(storage, "two", { firstMessage: "second task", modified: "2026-07-22T02:00:00.000Z" });
		writeSession(storage, "three", { firstMessage: "third task", modified: "2026-07-22T01:00:00.000Z" });
		const recent = await getRecentSessions(DIR, 2, storage);
		expect(recent.map(s => s.name)).toEqual(["first task", "second task"]);
	});
});
