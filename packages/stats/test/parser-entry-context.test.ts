/**
 * `getSessionEntryWithContext` is the parser primitive behind the request-detail
 * view. Given the id of one persisted message it walks the `parentId` chain back
 * to the turn's triggering user prompt and returns the entries oldest-first with
 * the requested entry last.
 *
 * These tests exist because the shipped `getRequestDetails` used to return only
 * the isolated assistant entry (it carried a `// TODO: Get parent/context
 * messages?`). The detail view therefore showed a reply with no prompt and no
 * tool cycle. They lock the turn-reconstruction contract:
 *   - the walk stops at the nearest user prompt, so it returns the current turn
 *     and NOT the whole session history,
 *   - ordering is oldest-first with the target last,
 *   - a self-referential `parentId` cycle terminates instead of hanging,
 *   - a missing id returns null.
 * Assertions check exact ids and roles, never shape-only presence.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getSessionEntryWithContext } from "@veyyon/stats/parser";
import type { SessionEntry } from "@veyyon/stats/types";

const TS = "2026-07-12T00:00:00.000Z";

function userEntry(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: { role: "user", content: [{ type: "text", text }] },
	});
}

function assistantEntry(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			stopReason: "stop",
			content: [{ type: "text", text }],
		},
	});
}

function toolResultEntry(id: string, parentId: string | null): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TS,
		message: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
	});
}

async function writeSession(lines: string[]): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-entry-context-"));
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

function roleOf(entry: SessionEntry): string {
	return entry.type === "message" ? (entry as { message: { role: string } }).message.role : entry.type;
}

function idOf(entry: SessionEntry): string {
	return (entry as { id: string }).id;
}

describe("getSessionEntryWithContext", () => {
	it("reconstructs one turn: user prompt, tool cycle, then the requested reply", async () => {
		// A single turn: u1 -> a1 (tool call) -> t1 (tool result) -> a2 (reply).
		const file = await writeSession([
			userEntry("u1", null, "please run the tool"),
			assistantEntry("a1", "u1", "calling the tool"),
			toolResultEntry("t1", "a1"),
			assistantEntry("a2", "t1", "here is the answer"),
		]);

		const resolved = await getSessionEntryWithContext(file, "a2");
		expect(resolved).not.toBeNull();
		if (!resolved) return;

		expect(resolved.context.map(idOf)).toEqual(["u1", "a1", "t1", "a2"]);
		expect(resolved.context.map(roleOf)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		// The requested entry is always last, and `entry` is that same entry.
		expect(idOf(resolved.context[resolved.context.length - 1])).toBe("a2");
		expect(resolved.entry.id).toBe("a2");
		expect(resolved.entry.message.role).toBe("assistant");
	});

	it("returns only the current turn, excluding earlier turns in the same file", async () => {
		// Two turns share the file. Walking back from the second turn's reply must
		// stop at u2 and never fold u1/a0 (the prior turn) into the context.
		const file = await writeSession([
			userEntry("u1", null, "first question"),
			assistantEntry("a0", "u1", "first answer"),
			userEntry("u2", "a0", "second question"),
			assistantEntry("a3", "u2", "second answer"),
		]);

		const resolved = await getSessionEntryWithContext(file, "a3");
		expect(resolved).not.toBeNull();
		if (!resolved) return;

		expect(resolved.context.map(idOf)).toEqual(["u2", "a3"]);
		expect(resolved.context.map(roleOf)).toEqual(["user", "assistant"]);
	});

	it("returns just the entry when its parentId is null (no prompt on the chain)", async () => {
		const file = await writeSession([assistantEntry("a1", null, "orphan reply")]);

		const resolved = await getSessionEntryWithContext(file, "a1");
		expect(resolved).not.toBeNull();
		if (!resolved) return;

		expect(resolved.context.map(idOf)).toEqual(["a1"]);
		expect(resolved.entry.id).toBe("a1");
	});

	it("terminates on a self-referential parentId cycle instead of hanging", async () => {
		// t1 and a2 point at each other. The visited-set guard must break the walk.
		const file = await writeSession([toolResultEntry("t1", "a2"), assistantEntry("a2", "t1", "cyclic reply")]);

		const resolved = await getSessionEntryWithContext(file, "a2");
		expect(resolved).not.toBeNull();
		if (!resolved) return;

		// Walk visits a2 then t1, then t1's parent a2 is already visited -> stop.
		expect(resolved.context.map(idOf)).toEqual(["t1", "a2"]);
		expect(resolved.entry.id).toBe("a2");
	});

	it("returns null for an id that is not present in the file", async () => {
		const file = await writeSession([assistantEntry("a1", null, "only entry")]);
		expect(await getSessionEntryWithContext(file, "does-not-exist")).toBeNull();
	});

	it("returns null when the session file is missing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-entry-context-missing-"));
		expect(await getSessionEntryWithContext(path.join(dir, "absent.jsonl"), "a1")).toBeNull();
	});
});
