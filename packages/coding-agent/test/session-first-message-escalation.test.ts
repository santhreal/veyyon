/**
 * Session-list first-message escalation — /resume must never label a real
 * conversation "(no messages)". Live repro (2026-07-22): sessions carry a
 * ~100 KB pre-message entry (system-prompt snapshot), pushing the first user
 * message far past the 4 KB list prefix; every such session listed as
 * "(no messages)" in /resume AND was treated as blank by the welcome hero's
 * continue-line filter, hiding real work behind a lie. The scanner now
 * escalates ONCE to a bounded wide read when the prefix shows no user message
 * but the file is clearly larger.
 *
 * Locks:
 *  1. A session whose first user message sits past the 4 KB prefix (behind a
 *     large early entry) still lists its real first message.
 *  2. Its messageCount counts the messages found by the wide read (not 0).
 *  3. getRecentSessions surfaces such a session (the blank filter must not
 *     eat real conversations).
 *  4. A genuinely blank large file stays "(no messages)" — escalation finds
 *     the truth, it does not invent messages.
 *  5. Small blank files never pay the escalated read (storage read count).
 */
import { describe, expect, it } from "bun:test";
import { getRecentSessions, listSessions } from "@veyyon/coding-agent/session/session-listing";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

const DIR = "/sessions/project";
const TS = "2026-07-22T00:00:00.000Z";

/** ~100 KB filler entry of the kind that really precedes the first message. */
function hugeEntry(): string {
	return JSON.stringify({ type: "custom", payload: "x".repeat(100_000), timestamp: TS });
}

function header(id: string): string[] {
	return [JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: TS })];
}

function message(role: "user" | "assistant", text: string): string {
	return JSON.stringify({ type: "message", message: { role, content: text } });
}

describe("session list first-message escalation", () => {
	it("finds the first user message hidden past the 4 KB prefix", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${DIR}/deep.jsonl`,
			[...header("deep"), hugeEntry(), message("user", "fix the detector policy"), ""].join("\n"),
		);
		const [session] = await listSessions(DIR, storage);
		expect(session?.firstMessage).toBe("fix the detector policy");
	});

	it("counts messages found by the wide read", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${DIR}/deep.jsonl`,
			[
				...header("deep"),
				hugeEntry(),
				message("user", "fix the detector policy"),
				message("assistant", "on it"),
				"",
			].join("\n"),
		);
		const [session] = await listSessions(DIR, storage);
		expect(session?.messageCount).toBe(2);
	});

	it("surfaces the session on the welcome shortlist (blank filter sees the truth)", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(
			`${DIR}/deep.jsonl`,
			[...header("deep"), hugeEntry(), message("user", "fix the detector policy"), ""].join("\n"),
		);
		const recent = await getRecentSessions(DIR, 4, storage);
		expect(recent.map(s => s.name)).toEqual(["fix the detector policy"]);
	});

	it("keeps a genuinely blank large file at '(no messages)'", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/bigblank.jsonl`, [...header("bigblank"), hugeEntry(), ""].join("\n"));
		const [session] = await listSessions(DIR, storage);
		expect(session?.firstMessage).toBe("(no messages)");
		expect(await getRecentSessions(DIR, 4, storage)).toEqual([]);
	});

	it("never escalates for a small file (no second read paid)", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/small.jsonl`, [...header("small"), message("user", "hello"), ""].join("\n"));
		let reads = 0;
		const original = storage.readTextSlices.bind(storage);
		storage.readTextSlices = async (file, prefix, suffix) => {
			reads++;
			return original(file, prefix, suffix);
		};
		const [session] = await listSessions(DIR, storage);
		expect(session?.firstMessage).toBe("hello");
		expect(reads).toBe(1);
	});
});
