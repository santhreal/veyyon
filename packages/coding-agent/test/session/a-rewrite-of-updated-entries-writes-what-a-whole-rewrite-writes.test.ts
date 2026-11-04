import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionEntry, TITLE_CHANGE_ENTRY_TYPE } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	FileSessionStorage,
	type SessionFileBody,
	type SessionStorageWriter,
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
 * rewrite is running and is reset away by it, another writer's line dropped, a title change (its
 * line behind appends made before it was written, or ahead of an append made right after), the
 * storage step itself (head, tail, bounds, commit guard), and the publish step's EPERM fallback.
 * The manager rows compare the partial rewrite's bytes with a whole rewrite of the same in-memory
 * state, so any of those produces a different file.
 *
 * A rename once forced the next rewrite to write the whole file: the header line held a copy of the
 * title, and the title-change append dropped the layout. The rename rows assert the rewrite after a
 * rename keeps the lines before its update.
 *
 * A cwd change (`setCwd`, `moveTo`) rewrote the whole file to change one field of the header: 2.0 s
 * and 1.4 GB of RSS on a 321 MB session. Every tail rewrite now writes the title slot and the header
 * again, `headBytes` of the old file in their place, and keeps the entry lines after them; a header
 * of another length moves those lines. The cwd rows move the header longer, then shorter.
 *
 * MEASURED (mutation matrix, each mutant applied alone):
 * - M1 `#earliestIndexOf` returns the first listed entry's index: row 1 red.
 * - M2 entry offsets counted with `line.length`: rows 1, 2, 3, 5, 7 red.
 * - M3 the hot append records the offset after adding the line's bytes: row 2 red.
 * - M4 the update watermark is reset after the publish instead of when serialization starts: row 3 red.
 * - M5 the layout is recorded while another writer's line is in the file, and the plan ignores
 *   foreign lines: row 4 red.
 * - M6 the title-change append drops the layout: rows 5, 6 red.
 * - M6a the title-change append keeps the layout without recording its line: rows 5, 6 red.
 * - M6b the title-change line is recorded after its write resolves instead of when it is handed to
 *   the writer: row 6 red.
 * - M6c the header line holds the title: rows 5, 6, the slot-rename resume row, and the queued tail
 *   row of `a-title-change-during-a-rewrite-is-written-once.test.ts` red.
 * - M6d the plan ignores an entry whose line is out of log order: row 5 red.
 * - M7 the staged rewrite skips the head write: the longer, shorter and UTF-8 head rows and both cwd
 *   rows red.
 * - M7a the in-place rewrite skips the head write: the as-long-as head row red.
 * - M8 the in-place rewrite keeps a file shorter than `keepBytes`: the in-place "fewer bytes" row red.
 * - M8a the staged rewrite does: the staged "fewer bytes" row red.
 * - M9 the staged rewrite publishes without the commit guard: the shifted commit-guard row red.
 * - M9a the in-place rewrite writes the file without the commit guard: the in-place commit-guard
 *   row red.
 * - M10 the staged rewrite gives up on EPERM instead of falling back: row 7 red.
 * - M11 the head length counted in characters: the UTF-8 head row red.
 * - M12 the tail written at `keepBytes` instead of after the moved kept bytes: the longer and
 *   shorter head rows and both cwd rows red.
 * - M13 the plan requires the header line it loaded: the cwd rows and the titled-header resume row
 *   red.
 * - M14 the kept entry offsets not moved by the header's change in length: the cwd rows red.
 * - M15 the tail lines' offsets counted from `keepBytes` instead of where the moved kept bytes end:
 *   the titled-header resume row red.
 *
 * A tail rewrite whose head keeps its length rewrites inside the file when the bytes it replaces
 * are no more than the bytes it keeps; `a-tail-rewrite-in-place-leaves-a-whole-file-after-a-crash.test.ts`
 * covers that path and its recovery. Row 7 updates an early entry, so its rewrite stages a copy and
 * renames it.
 *
 * WHAT THIS DOES NOT CATCH: a caller that updates an entry in place and leaves it out of `updated`.
 * The manager cannot see an in-place mutation; that list is the caller's statement of what it
 * changed, and `a-history-rewrite-lists-every-entry-it-changed.test.ts` checks each caller's list.
 */

/**
 * Records which publish path each rewrite takes, can hold a partial rewrite mid-way, and runs
 * `afterAppend` with each line right after the writer took it.
 */
class RecordingStorage extends FileSessionStorage {
	kept: number[] = [];
	whole = 0;
	/** Every path read back whole. */
	reads: string[] = [];
	failNextReplace = false;
	beforeTail: (() => Promise<void>) | undefined;
	afterAppend: ((line: string) => void) | undefined;
	/** Runs once, after the next whole read returns and before its text reaches the caller. */
	afterRead: (() => Promise<void>) | undefined;

	override openWriter(
		p: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = super.openWriter(p, options);
		return {
			append: line => {
				const written = writer.append(line);
				this.afterAppend?.(line);
				return written;
			},
			flush: () => writer.flush(),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	}

	override async readText(p: string): Promise<string> {
		this.reads.push(p);
		const text = await super.readText(p);
		const after = this.afterRead;
		this.afterRead = undefined;
		if (after) await after();
		return text;
	}

	override async writeTextAtomic(p: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void> {
		this.whole += 1;
		await super.writeTextAtomic(p, body, options);
	}

	override async rewriteTailAtomic(
		p: string,
		headBytes: number,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		this.kept.push(keepBytes);
		const hold = this.beforeTail;
		this.beforeTail = undefined;
		if (hold) await hold();
		await super.rewriteTailAtomic(p, headBytes, keepBytes, head, tail, options);
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

function appendUsers(manager: SessionManager, ids: string[], count: number, text = WIDE_TEXT): void {
	for (let i = 0; i < count; i++) {
		const n = ids.length;
		ids.push(manager.appendMessage({ role: "user", content: `${n} ${text}`, timestamp: 1_700_000_000_000 + n }));
	}
}

async function openSession(dir: string, count: number, text = WIDE_TEXT): Promise<Fixture> {
	const file = path.join(dir, "session.jsonl");
	const storage = new RecordingStorage();
	const manager = await SessionManager.open(file, dir, storage);
	const ids: string[] = [];
	appendUsers(manager, ids, count, text);
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

function foreignLine(id: string, text: string, parentId: string | null = null): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId,
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

	it("keeps the lines before the earliest update after a rename", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-title-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		// The title goes to the slot. The header line holds no copy of it, so a rename leaves every line
		// before the title-change entry as it was.
		await manager.setSessionName("renamed for the slot", "user");
		const renamed = await fs.readFile(file, "utf8");
		await manager.rewriteEntries([update(manager, ids[10]!, "after the rename")]);
		expect(storage.kept).toEqual([lineOffset(renamed, ids[10]!)]);

		// Appends made before the title-change entry is written land ahead of it in the file and behind
		// it in the log, so the kept run ends at the first of them.
		const racing = manager.setSessionName("renamed again", "user");
		appendUsers(manager, ids, 5);
		await racing;
		const raced = await fs.readFile(file, "utf8");
		expect(raced.indexOf(`"id":"${ids[40]!}"`)).toBeLessThan(raced.indexOf("renamed again", 256));
		await manager.rewriteEntries([update(manager, ids[44]!, "after the second rename")]);
		expect(storage.kept.at(-1)).toBe(lineOffset(raced, ids[40]!));

		// That publish wrote the log's order, so the next rewrite keeps every line before its update.
		const republished = await fs.readFile(file, "utf8");
		await manager.rewriteEntries([update(manager, ids[43]!, "tail after the rename")]);
		expect(storage.kept.at(-1)).toBe(lineOffset(republished, ids[43]!));
		expect(storage.kept).toHaveLength(3);
		expect(storage.whole).toBe(0);

		const raw = await fs.readFile(file);
		const [slot, header] = raw.toString("utf8").split("\n");
		expect(JSON.parse(slot!)).toMatchObject({ type: "title", title: "renamed again", source: "user" });
		expect(JSON.parse(header!)).not.toHaveProperty("title");
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("records the title-change line where it landed when an append follows it at once", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-title-follow-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		// An append that runs after the writer took the title-change line, before the step that follows
		// the write, lands after that line.
		storage.afterAppend = line => {
			if (!line.includes(`"type":"${TITLE_CHANGE_ENTRY_TYPE}"`)) return;
			storage.afterAppend = undefined;
			queueMicrotask(() => appendUsers(manager, ids, 1));
		};
		await manager.setSessionName("renamed under an append", "user");
		expect(ids).toHaveLength(41);
		const before = await fs.readFile(file, "utf8");
		expect(before.indexOf("renamed under an append", 256)).toBeLessThan(before.indexOf(`"id":"${ids[40]!}"`));

		await manager.rewriteEntries([update(manager, ids[40]!, "after the following append")]);

		expect(storage.kept).toEqual([lineOffset(before, ids[40]!)]);
		expect(storage.whole).toBe(0);
		expect((await fs.readFile(file)).equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("publishes the partial rewrite when the rename falls back after EPERM", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-eperm-");
		const fixture = await openSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		storage.failNextReplace = true;

		await manager.rewriteEntries([update(manager, ids[5]!, "published through the fallback")]);

		expect(storage.failNextReplace).toBe(false);
		expect(storage.kept).toHaveLength(1);
		const raw = await fs.readFile(file);
		expect(raw.toString("utf8")).toContain("published through the fallback");
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it.each([
		{ move: "setCwd", run: (manager: SessionManager, cwd: string) => manager.setCwd(cwd) },
		{
			move: "moveTo",
			run: (manager: SessionManager, cwd: string) => manager.moveTo(cwd, path.join(cwd, "sessions")),
		},
	])("writes the header a $move changes and keeps every entry line", async ({ run }) => {
		using tempDir = TempDir.createSync("@veyyon-tail-cwd-");
		const fixture = await openSession(tempDir.path(), 200);
		const { storage, manager } = fixture;
		// A longer header, then a shorter one, so the kept lines move both ways. The second move keeps
		// the lines the first one moved, so a stale record of where they start corrupts it.
		for (const name of [`moved-${"x".repeat(64)}`, "m"]) {
			const cwd = path.join(tempDir.path(), name);
			await fs.mkdir(cwd);
			const size = (await fs.stat(manager.getSessionFile()!)).size;

			await run(manager, cwd);

			expect(storage.kept.at(-1)).toBe(size);
			const raw = await fs.readFile(manager.getSessionFile()!, "utf8");
			expect(JSON.parse(raw.split("\n")[1]!).cwd).toBe(cwd);
		}
		expect(storage.kept).toHaveLength(2);
		expect(storage.whole).toBe(0);
		const file = manager.getSessionFile()!;
		const raw = await fs.readFile(file);
		expect(raw.equals(await wholeRewrite({ ...fixture, file }))).toBe(true);

		await manager.close();
	});
});

/**
 * Resume `count` entries from a file this version wrote, after `prepare` runs on the seeding manager
 * and `alter` rewrites the file's bytes. The reads the load itself made are cleared, so
 * `storage.reads` holds only what a later rewrite reads.
 */
async function resumeSession(
	dir: string,
	count: number,
	options: {
		text?: string;
		prepare?: (manager: SessionManager) => Promise<unknown>;
		alter?: (raw: string, ids: string[]) => string;
		/** Runs while the resume reads the file, after its bytes are read and before they are parsed. */
		duringLoad?: (file: string, ids: string[]) => Promise<void>;
	} = {},
): Promise<Fixture> {
	const seeded = await openSession(dir, count, options.text);
	if (options.prepare) await options.prepare(seeded.manager);
	await seeded.manager.close();
	if (options.alter)
		await fs.writeFile(seeded.file, options.alter(await fs.readFile(seeded.file, "utf8"), seeded.ids));
	const storage = new RecordingStorage();
	const { duringLoad } = options;
	if (duringLoad) storage.afterRead = () => duringLoad(seeded.file, seeded.ids);
	const manager = await SessionManager.open(seeded.file, dir, storage);
	storage.reads.length = 0;
	return { file: seeded.file, storage, manager, ids: seeded.ids };
}

/** `raw` with `line` inserted before the line holding entry `id`. */
function insertBefore(raw: string, id: string, line: string): string {
	const at = raw.lastIndexOf("\n", raw.indexOf(`"id":"${id}"`)) + 1;
	return `${raw.slice(0, at)}${line}${raw.slice(at)}`;
}

/**
 * WHY: the first rewrite after a resume wrote the whole file and read it back first, because the
 * manager had not published the file itself and so did not know where its lines were. On a long
 * session the per-turn stale-read prune rewrites on the first turn, so every resume paid a full read
 * and a full serialization of the history. The loader now reports where each record sits when the
 * file is laid out the way a publish writes it, and the manager adopts that as its published state.
 *
 * The class: a resumed file whose lines are not exactly one clean record per entry, in entry order,
 * is adopted anyway, and a partial rewrite keeps lines a whole rewrite would drop or re-link. Each
 * variant the loader cannot vouch for is a row below, asserting the whole path ran and wrote what a
 * second whole rewrite writes. A file whose title reached the slot after its header was written is
 * clean, and its row asserts the first rewrite keeps the lines before its update.
 *
 * MEASURED (each mutant applied alone unless stated):
 * - adoption removed from `#switchToLoadedFile`: both resume rows red.
 * - the loader's layout kept despite a skipped line: the skipped-line row red.
 * - the loader's layout kept despite a re-linked orphan: the orphan row red.
 * - offsets counted in characters instead of UTF-8 bytes, streamed load: the streamed row red.
 * - the same, whole-read load: the read-whole row red.
 * - the layout kept when the read ended short of the file's size: green alone, because the loader
 *   also reports the torn line; with the skipped-line guard removed too, the torn-tail row is red.
 * - the older-version guard removed: green. The migrated header no longer matches its line, and the
 *   rewrite plan already writes the whole file for a changed header.
 * - the header line holds the title: the slot-rename row red.
 * - the plan ignores a changed header line: the titled-header row red.
 * - the loader's layout kept despite a changed modification time: the in-place row red.
 *
 * WHAT THIS DOES NOT CATCH: another writer that rewrites the file in place to the same size within
 * one tick of the filesystem clock, which leaves its object, size and modification time as the load
 * first read them.
 */
describe("a resumed session's first rewrite keeps the lines before its earliest update", () => {
	it.each([
		{ name: "read whole", count: 200, text: WIDE_TEXT },
		{ name: "streamed", count: 1200, text: WIDE_TEXT.repeat(12) },
	])("keeps the loaded lines of a file read $name", async ({ count, text }) => {
		using tempDir = TempDir.createSync("@veyyon-tail-resume-");
		const fixture = await resumeSession(tempDir.path(), count, { text });
		const { file, storage, manager, ids } = fixture;
		const before = await fs.readFile(file, "utf8");
		if (text !== WIDE_TEXT) expect(Buffer.byteLength(before, "utf8")).toBeGreaterThan(8 * 1024 * 1024);

		await manager.rewriteEntries([update(manager, ids[count - 50]!, "updated after the resume")]);

		expect(storage.kept).toEqual([lineOffset(before, ids[count - 50]!)]);
		expect(storage.whole).toBe(0);
		expect(storage.reads).toEqual([]);
		expect((await fs.readFile(file)).equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("keeps the loaded lines of a file renamed through its title slot", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-resume-renamed-");
		// The title arrives after the header is written, as a generated title does, so only the slot holds it.
		const fixture = await resumeSession(tempDir.path(), 40, {
			prepare: manager => manager.setSessionName("named after the header", "auto"),
		});
		const { file, storage, manager, ids } = fixture;
		const before = await fs.readFile(file, "utf8");
		expect(manager.getSessionName()).toBe("named after the header");

		await manager.rewriteEntries([update(manager, ids[30]!, "updated after the resume")]);

		expect(storage.kept).toEqual([lineOffset(before, ids[30]!)]);
		expect(storage.whole).toBe(0);
		expect(storage.reads).toEqual([]);
		expect((await fs.readFile(file)).equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it.each([
		{ name: "has no title slot", alter: (raw: string) => raw.slice(raw.indexOf("\n") + 1) },
		{
			name: "holds a line the loader skips",
			alter: (raw: string, ids: string[]) => insertBefore(raw, ids[5]!, "not a record\n"),
		},
		{ name: "ends in a torn line", alter: (raw: string) => `${raw}{"type":"message","id":"torn"` },
		{
			name: "holds an entry whose parent is missing",
			alter: (raw: string, ids: string[]) => insertBefore(raw, ids[5]!, foreignLine("orphan", "re-linked", "gone")),
		},
		{ name: "was written by an older version", alter: (raw: string) => raw.replace('"version":3', '"version":2') },
	])("writes the whole file on the first rewrite when the file $name", async ({ alter }) => {
		using tempDir = TempDir.createSync("@veyyon-tail-resume-unclean-");
		const fixture = await resumeSession(tempDir.path(), 40, { alter });
		const { file, storage, manager, ids } = fixture;

		await manager.rewriteEntries([update(manager, ids[30]!, "updated after an unclean resume")]);

		expect(storage.kept).toEqual([]);
		const raw = await fs.readFile(file);
		expect(raw.toString("utf8")).toContain("updated after an unclean resume");
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("keeps the loaded lines of a file whose header line carries a title, and writes the header without it", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-resume-titled-");
		const fixture = await resumeSession(tempDir.path(), 40, {
			alter: raw =>
				raw.replace(
					'{"type":"session",',
					'{"type":"session","title":"from an earlier version","titleSource":"auto",',
				),
		});
		const { file, storage, manager, ids } = fixture;
		const before = await fs.readFile(file, "utf8");

		await manager.rewriteEntries([update(manager, ids[30]!, "updated after the resume")]);

		const after = await fs.readFile(file, "utf8");
		expect(JSON.parse(after.split("\n")[1]!)).not.toHaveProperty("title");
		// The second rewrite keeps lines the first one wrote behind the shorter header.
		await manager.rewriteEntries([update(manager, ids[35]!, "updated again")]);

		expect(storage.kept).toEqual([lineOffset(before, ids[30]!), lineOffset(after, ids[35]!)]);
		expect(storage.whole).toBe(0);
		expect(storage.reads).toEqual([]);
		const raw = await fs.readFile(file);
		expect(raw.equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("reads back another writer's line appended after the resume", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-resume-foreign-");
		const fixture = await resumeSession(tempDir.path(), 40);
		const { file, storage, manager, ids } = fixture;
		await fs.appendFile(file, foreignLine("outsider", "appended after the resume"));

		await manager.rewriteEntries([update(manager, ids[30]!, "updated beside the outsider")]);

		expect(storage.kept).toEqual([]);
		const raw = await fs.readFile(file, "utf8");
		expect(raw).toContain("appended after the resume");
		expect(raw).toContain("updated beside the outsider");
		expect(Buffer.from(raw).equals(await wholeRewrite(fixture))).toBe(true);

		await manager.close();
	});

	it("writes the whole file on the first rewrite when another writer rewrote it in place during the load", async () => {
		using tempDir = TempDir.createSync("@veyyon-tail-resume-rewritten-");
		const fixture = await resumeSession(tempDir.path(), 40, {
			// Same object and same size: only the modification time shows the bytes the load read are gone.
			duringLoad: async (file, ids) => {
				const raw = await fs.readFile(file, "utf8");
				const at = raw.indexOf(`"id":"${ids[10]}"`);
				await fs.writeFile(file, `${raw.slice(0, at)}${raw.slice(at).replace("漢字", "字漢")}`, { flag: "r+" });
				// The writer's next clock tick, set rather than waited for.
				const { atime, mtime } = await fs.stat(file);
				await fs.utimes(file, atime, new Date(mtime.getTime() + 1000));
			},
		});
		const { file, storage, manager, ids } = fixture;

		await manager.rewriteEntries([update(manager, ids[30]!, "updated after the load")]);

		expect(storage.kept).toEqual([]);
		expect((await fs.readFile(file)).equals(await wholeRewrite(fixture))).toBe(true);

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

	it.each([
		{ name: "as long as", headBytes: 2, head: "HE", expected: "HE23456789xyzé" },
		{ name: "longer than", headBytes: 2, head: "HEAD", expected: "HEAD23456789xyzé" },
		{ name: "shorter than", headBytes: 4, head: "H", expected: "H456789xyzé" },
		// Two bytes in one character: a head measured in characters would be taken for one byte long.
		{ name: "in UTF-8 longer than", headBytes: 1, head: "é", expected: "é123456789xyzé" },
	])(
		"writes a head $name the bytes it replaces, the kept bytes, and the tail after them",
		async ({ headBytes, head, expected }) => {
			const { file, tempDir } = await seed("0123456789abcdef");
			using _ = tempDir;

			await new FileSessionStorage().rewriteTailAtomic(file, headBytes, 10, head, () => ["xy", "", "zé"]);

			expect(await fs.readFile(file, "utf8")).toBe(expected);
		},
	);

	it.each([
		{ path: "in place", head: "", beside: [] },
		// Another rewrite's journal sends a head of the same length to a staged copy.
		{ path: "staged beside another rewrite's journal", head: "", beside: [".session.jsonl.tail"] },
		{ path: "shifted", head: "HEAD", beside: [] },
	])(
		"fails and leaves the file as it was when it holds fewer bytes than it keeps ($path)",
		async ({ head, beside }) => {
			const { dir, file, tempDir } = await seed("short");
			using _ = tempDir;
			for (const name of beside) await fs.writeFile(path.join(dir, name), "another rewrite");

			await expect(new FileSessionStorage().rewriteTailAtomic(file, 0, 100, head, () => ["tail"])).rejects.toThrow(
				"fewer than the 100",
			);

			expect(await fs.readFile(file, "utf8")).toBe("short");
			expect((await fs.readdir(dir)).sort()).toEqual([...beside, "session.jsonl"]);
		},
	);

	it("fails and leaves the file as it was when its head replaces more bytes than it keeps", async () => {
		const { dir, file, tempDir } = await seed("0123456789");
		using _ = tempDir;

		await expect(new FileSessionStorage().rewriteTailAtomic(file, 6, 4, "HEAD", () => ["tail"])).rejects.toThrow(
			"cannot replace 6 head bytes",
		);

		expect(await fs.readFile(file, "utf8")).toBe("0123456789");
		expect(await fs.readdir(dir)).toEqual(["session.jsonl"]);
	});

	it.each([
		{ path: "in place", head: "" },
		{ path: "shifted", head: "HEAD" },
	])("publishes nothing when its commit guard fails ($path)", async ({ head }) => {
		const { dir, file, tempDir } = await seed("0123456789");
		using _ = tempDir;

		await new FileSessionStorage().rewriteTailAtomic(file, 0, 6, head, () => ["tail"], { commitGuard: () => false });

		expect(await fs.readFile(file, "utf8")).toBe("0123456789");
		expect(await fs.readdir(dir)).toEqual(["session.jsonl"]);
	});
});
