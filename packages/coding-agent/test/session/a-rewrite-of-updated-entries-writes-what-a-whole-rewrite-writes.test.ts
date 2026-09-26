import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	FileSessionStorage,
	type SessionFileBody,
	type WriteTextAtomicOptions,
} from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: every prune, shake and recovered retry rewrote the whole session file. On a long session that
 * is hundreds of megabytes serialized again to change a few tool results in the live tail: seconds
 * of work and a multi-gigabyte RSS spike per turn. `rewriteEntries(updated)` now keeps the bytes
 * before the earliest updated entry (copied by the kernel, never parsed or serialized) and writes
 * only the lines from there on.
 *
 * The class these rows close is "a rewrite that keeps part of the file publishes something other
 * than what a whole rewrite of the same state publishes". Its members: the kept prefix ends at the
 * wrong entry (the first listed, not the earliest), offsets counted in characters instead of UTF-8
 * bytes, offsets that miss the entries appended after the publish, an update that lands while a
 * rewrite is running and is reset away by it, another writer's line dropped, a title change, the
 * storage step itself (head, tail, bounds, commit guard), and the publish step's EPERM fallback.
 * The manager rows compare the partial rewrite's bytes with a whole rewrite of the same in-memory
 * state, so any of those produces a different file.
 *
 * MEASURED (mutation matrix, each mutant applied alone):
 * - M1 `#earliestIndexOf` returns the first listed entry's index: row 1 red.
 * - M2 entry offsets counted with `line.length`: rows 1, 2, 3, 5, 6 red.
 * - M3 the hot append records the offset after adding the line's bytes: row 2 red.
 * - M4 the update watermark is reset after the publish instead of when serialization starts: row 3 red.
 * - M5 the layout is recorded while another writer's line is in the file, and the plan ignores
 *   foreign lines: row 4 red.
 * - M6 the title-change append keeps the layout: row 5 red.
 * - M7 `rewriteTailAtomic` skips the head write: row 7 red.
 * - M8 `rewriteTailAtomic` keeps a file shorter than `keepBytes`: row 8 red.
 * - M9 `rewriteTailAtomic` publishes without the commit guard: row 9 red.
 * - M10 `rewriteTailAtomic` renames without the EPERM fallback or the guard: rows 6, 9 red.
 * - M11 the plan ignores a changed header line: green. Every header change today (a rename, a cwd
 *   move) also drops the layout or asks for a whole rewrite, so the header comparison is a second
 *   check behind those.
 *
 * WHAT THIS DOES NOT CATCH: a caller that updates an entry in place and leaves it out of `updated`.
 * The manager cannot see an in-place mutation; that list is the caller's statement of what it
 * changed, and `a-history-rewrite-lists-every-entry-it-changed.test.ts` checks each caller's list.
 * M11 above, for the reason given.
 */

/** Records which publish path each rewrite takes, and can hold a partial rewrite mid-way. */
class RecordingStorage extends FileSessionStorage {
	kept: number[] = [];
	whole = 0;
	failNextReplace = false;
	beforeTail: (() => Promise<void>) | undefined;

	override async writeTextAtomic(p: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void> {
		this.whole += 1;
		await super.writeTextAtomic(p, body, options);
	}

	override async rewriteTailAtomic(
		p: string,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.kept.push(keepBytes);
		const hold = this.beforeTail;
		this.beforeTail = undefined;
		if (hold) await hold();
		await super.rewriteTailAtomic(p, keepBytes, head, tail, options);
	}

	override renameSync(source: string, target: string): void {
		if (this.failNextReplace && source.endsWith(".tmp") && this.existsSync(target)) {
			this.failNextReplace = false;
			throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${target}'`), {
				code: "EPERM",
			});
		}
		super.renameSync(source, target);
	}
}

/** Multibyte on purpose: an offset counted in characters lands inside an earlier line. */
const WIDE_TEXT = `${"réponse ".repeat(40)}${"漢字".repeat(40)}`;

interface Fixture {
	file: string;
	storage: RecordingStorage;
	manager: SessionManager;
	ids: string[];
}

function appendUsers(manager: SessionManager, ids: string[], count: number): void {
	for (let i = 0; i < count; i++) {
		const n = ids.length;
		ids.push(manager.appendMessage({ role: "user", content: `${n} ${WIDE_TEXT}`, timestamp: 1_700_000_000_000 + n }));
	}
}

async function openSession(dir: string, count: number): Promise<Fixture> {
	const file = path.join(dir, "session.jsonl");
	const storage = new RecordingStorage();
	const manager = await SessionManager.open(file, dir, storage);
	const ids: string[] = [];
	appendUsers(manager, ids, count);
	await manager.flush();
	// The publish every later partial rewrite measures itself against.
	await manager.rewriteEntries();
	storage.whole = 0;
	return { file, storage, manager, ids };
}

/** Replace a user message's text in place, the way a prune or shake pass does. */
function update(manager: SessionManager, id: string, text: string): SessionEntry {
	const entry = manager.getEntry(id);
	if (entry?.type !== "message" || entry.message.role !== "user") throw new Error(`no user message ${id}`);
	entry.message.content = text;
	return entry;
}

/** Byte offset of the line holding entry `id` in `raw`. */
function lineOffset(raw: string, id: string): number {
	const at = raw.indexOf(`"id":"${id}"`);
	if (at < 0) throw new Error(`entry ${id} is not in the file`);
	return Buffer.byteLength(raw.slice(0, raw.lastIndexOf("\n", at) + 1), "utf8");
}

/** The file a whole rewrite of the current state publishes. */
async function wholeRewrite(fixture: Fixture): Promise<Buffer> {
	await fixture.manager.rewriteEntries();
	return fs.readFile(fixture.file);
}

function foreignLine(id: string, text: string): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(1_700_000_000_000).toISOString(),
		message: { role: "user", content: text },
	})}\n`;
}

describe("a rewrite of updated entries writes what a whole rewrite writes", () => {
	it("keeps every line before the earliest updated entry and writes the rest", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-rewrite-");
		// Past the chunk target, so the tail is itself written in pieces.
		const fixture = await openSession(tempDir.path(), 3000);
		const { file, storage, manager, ids } = fixture;
		const before = await fs.readFile(file, "utf8");

		const late = update(manager, ids[2500]!, `pruned late ${WIDE_TEXT}`);
		const early = update(manager, ids[2000]!, `pruned early ${WIDE_TEXT}`);
		await manager.rewriteEntries([late, early]);

		expect(storage.kept).toEqual([lineOffset(before, ids[2000]!)]);
		expect(storage.whole).toBe(0);
		const partial = await fs.readFile(file);
		expect(partial.toString("utf8")).toContain("pruned early");
		expect(partial.toString("utf8")).toContain("pruned late");
		expect(partial.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("knows where the entries appended after the publish start", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-appended-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		appendUsers(manager, ids, 40);
		await manager.flush();
		const before = await fs.readFile(file, "utf8");

		await manager.rewriteEntries([update(manager, ids[60]!, "appended, then pruned")]);

		expect(storage.kept).toEqual([lineOffset(before, ids[60]!)]);
		expect((await fs.readFile(file)).equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("writes an update that lands while a rewrite is running", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-concurrent-");
		const fixture = await openSession(tempDir.path(), 200);
		const { file, storage, manager, ids } = fixture;
		const before = await fs.readFile(file, "utf8");

		let second: Promise<void> | undefined;
		// Runs after the first rewrite has taken what it owes and before it writes: the
		// entry updated here sits in the prefix that rewrite keeps as it was.
		storage.beforeTail = async () => {
			second = manager.rewriteEntries([update(manager, ids[100]!, "updated mid-rewrite")]);
		};
		await manager.rewriteEntries([update(manager, ids[150]!, "updated first")]);
		await second;

		expect(storage.kept).toEqual([lineOffset(before, ids[150]!), lineOffset(before, ids[100]!)]);
		const raw = await fs.readFile(file);
		expect(raw.toString("utf8")).toContain("updated mid-rewrite");
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("keeps another writer's line through every later rewrite", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-foreign-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		await fs.appendFile(file, foreignLine("outsider", "from another window"));

		// The first rewrite finds the line; the second runs on the file that carries it.
		await manager.rewriteEntries([update(manager, ids[30]!, "updated beside a foreign line")]);
		await manager.rewriteEntries([update(manager, ids[35]!, "updated again")]);

		expect(storage.kept).toEqual([]);
		const raw = await fs.readFile(file, "utf8");
		expect(raw).toContain("from another window");
		expect(raw).toContain("updated again");
		expect(raw.indexOf("from another window")).toBeGreaterThan(raw.indexOf(`"id":"${ids[39]!}"`));
		expect(Buffer.from(raw).equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("writes the current title and the entry recording it after a rename", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-title-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		// A new title rewrites the header line, which no kept prefix can carry.
		await manager.setSessionName("renamed for the slot", "user");
		await manager.rewriteEntries([update(manager, ids[10]!, "after the rename")]);
		// The same title again leaves the header alone; the entry recording it is
		// appended apart from the ordinary appends that follow it.
		await manager.setSessionName("renamed for the slot", "user");
		appendUsers(manager, ids, 5);

		await manager.rewriteEntries([update(manager, ids[42]!, "after the second rename")]);
		await manager.rewriteEntries([update(manager, ids[43]!, "tail after the rename")]);

		const raw = await fs.readFile(file);
		expect(raw.subarray(0, 256).toString("utf8")).toContain("renamed for the slot");
		expect(raw.toString("utf8")).toContain("tail after the rename");
		// Only the last rewrite follows a publish with nothing written apart since.
		expect(storage.kept).toHaveLength(1);
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("publishes the partial rewrite when the rename falls back after EPERM", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-eperm-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		storage.failNextReplace = true;

		await manager.rewriteEntries([update(manager, ids[35]!, "published through the fallback")]);

		expect(storage.failNextReplace).toBe(false);
		expect(storage.kept).toHaveLength(1);
		const raw = await fs.readFile(file);
		expect(raw.toString("utf8")).toContain("published through the fallback");
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});
});

describe("a tail rewrite keeps a prefix of the file and replaces the rest", () => {
	async function seed(content: string): Promise<{ dir: string; file: string; tempDir: TempDir }> {
		const tempDir = TempDir.createSync("@veyyon-tail-storage-");
		const file = path.join(tempDir.path(), "session.jsonl");
		await fs.writeFile(file, content);
		return { dir: tempDir.path(), file, tempDir };
	}

	it("writes the head over the kept bytes and the tail after them", async () => {
		const { file, tempDir } = await seed("0123456789abcdef");
		using _ = tempDir;

		await new FileSessionStorage().rewriteTailAtomic(file, 10, "HE", () => ["xy", "", "zé"]);

		expect(await fs.readFile(file, "utf8")).toBe("HE23456789xyzé");
	});

	it("fails and leaves the file as it was when it holds fewer bytes than it keeps", async () => {
		const { dir, file, tempDir } = await seed("short");
		using _ = tempDir;

		await expect(new FileSessionStorage().rewriteTailAtomic(file, 100, "", () => ["tail"])).rejects.toThrow(
			"fewer than the 100",
		);

		expect(await fs.readFile(file, "utf8")).toBe("short");
		expect(await fs.readdir(dir)).toEqual(["session.jsonl"]);
	});

	it("publishes nothing when its commit guard fails", async () => {
		const { dir, file, tempDir } = await seed("0123456789");
		using _ = tempDir;

		await new FileSessionStorage().rewriteTailAtomic(file, 4, "", () => ["tail"], { commitGuard: () => false });

		expect(await fs.readFile(file, "utf8")).toBe("0123456789");
		expect(await fs.readdir(dir)).toEqual(["session.jsonl"]);
	});
});
