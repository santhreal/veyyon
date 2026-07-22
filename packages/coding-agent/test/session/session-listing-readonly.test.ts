import { describe, expect, it } from "bun:test";
import { listSessions, listSessionsReadOnly } from "@veyyon/coding-agent/session/session-listing";
import { MemorySessionStorage } from "@veyyon/coding-agent/session/session-storage";

/**
 * listSessionsReadOnly is the enumeration path used where the caller must NOT touch the sessions
 * directory (read-only listings, previews, other-process inspection). Its whole reason to exist,
 * versus listSessions, is that it skips recoverOrphanedBackups: it may not rename a `.bak` back into a
 * primary or otherwise mutate the tree. This contract had no direct test, so a regression that pointed
 * it at the mutating scan (or the other way around) would be invisible. These tests prove both halves
 * against the same fixture: read-only leaves an orphaned backup exactly where it found it, while
 * listSessions recovers it, so the divergence is real and not incidental.
 */
describe("listSessionsReadOnly", () => {
	const dir = "/sessions/proj";
	function sessionBody(id: string): string {
		return [
			JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: "2026-06-27T00:00:00.000Z" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
			"",
		].join("\n");
	}

	it("lists a present primary session file with its parsed id and cwd", async () => {
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${dir}/bar.jsonl`, sessionBody("bar-id"));

		const sessions = await listSessionsReadOnly(dir, storage);

		expect(sessions.map(s => ({ id: s.id, cwd: s.cwd }))).toEqual([{ id: "bar-id", cwd: "/repo" }]);
	});

	it("does not recover an orphaned backup: leaves the .bak in place and lists nothing", async () => {
		const storage = new MemorySessionStorage();
		// An orphaned backup (primary foo.jsonl is absent). The mutating scan would rename this back.
		storage.writeTextSync(`${dir}/foo.jsonl.777.bak`, sessionBody("recovered-id"));

		const sessions = await listSessionsReadOnly(dir, storage);

		// Nothing is listed (read-only globs *.jsonl only) and, crucially, the directory is untouched.
		expect(sessions).toEqual([]);
		expect(storage.existsSync(`${dir}/foo.jsonl.777.bak`)).toBe(true);
		expect(storage.existsSync(`${dir}/foo.jsonl`)).toBe(false);
	});

	it("diverges from listSessions, which DOES recover the same orphaned backup", async () => {
		// Same fixture, mutating scan: proves the read-only path's no-recovery behavior above is a real
		// difference, not a fixture that simply has nothing to recover.
		const storage = new MemorySessionStorage();
		storage.writeTextSync(`${dir}/foo.jsonl.777.bak`, sessionBody("recovered-id"));

		const sessions = await listSessions(dir, storage);

		expect(sessions.map(s => s.id)).toEqual(["recovered-id"]);
		expect(storage.existsSync(`${dir}/foo.jsonl.777.bak`)).toBe(false); // renamed away
		expect(storage.existsSync(`${dir}/foo.jsonl`)).toBe(true); // recovered primary
	});

	it("returns an empty list for a directory with no session files", async () => {
		const storage = new MemorySessionStorage();
		expect(await listSessionsReadOnly(dir, storage)).toEqual([]);
	});
});
