import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadEntriesFromFile, loadSessionFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: every prune, shake and dedupe that rewrote the tail of a session file copied the whole file to
 * a temp file and renamed the copy over it. ext4 has no reflink, so that is a full copy: a 30-turn
 * probe session copied 27 MB through 7 rewrites of a file that never passed 5.3 MB, and a 400 MB
 * session wrote and flushed 400 MB to change a few tool results. A tail rewrite whose head is as long
 * as the bytes it replaces now writes the head and the tail to a journal beside the file, flushes and
 * seals it, and copies them into the file itself, so the kept bytes are neither read nor written.
 *
 * The class these rows close: an in-place tail rewrite that, stopped at any point, leaves a session
 * file a load reads as something other than the file before the rewrite or the file after it. The
 * crash row sweeps every write and truncate the rewrite makes to the file, counted from a run of the
 * real code, so a new write joins the sweep on its own. The other rows are the states a stopped
 * rewrite leaves beside a file that changed since: a journal cut off before or inside its seal, a
 * seal whose record does not describe the bytes before it, a journal in another format, a journal
 * written for an object a whole rewrite has since replaced, a journal left after the rewrite
 * finished, with lines appended after it up to the size the file had before, and a file that grew
 * after a rewrite stopped before its first write. The limits that send a rewrite to a staged copy
 * instead, and the journal of another rewrite under way, are rows too.
 *
 * MEASURED (each mutant applied alone):
 * - the in-place path never taken: every row but the limit rows red.
 * - `loadSessionFile` does not recover: the crash sweep and every row that leaves a journal red.
 * - the journal not sealed: the crash sweep red.
 * - the journal deleted when the copy into the file fails: the crash sweep and every row that stops
 *   a rewrite red.
 * - no check that the file already holds the journal's head and tail: the row appended up to the
 *   old size red.
 * - no check of the journal's magic: the zeroed-seal row red.
 * - no check that the record ends where the tail does: the misplaced-tail row red.
 * - a journal in another format dropped, or applied, or failed with the wrong corrective action:
 *   the format row red.
 * - no check of the journal's object: the replaced-object row red.
 * - no check that the file grew after a rewrite that never wrote it: the grown row red.
 * - a journal opened without `x`: the second-rewrite row red.
 * - the in-place limit is only the kept bytes: the 8 MiB row red; only 8 MiB: the kept-bytes row red.
 *
 * WHAT THIS DOES NOT CATCH: a power cut, which can persist a file's pages out of the order they were
 * written; the journal's two flushes are what cover it, and no test here can cut the power. A second
 * process reading the file during the copy into it, which reads a file half rewritten. A record
 * whose head is longer than its kept bytes, which no rewrite writes, has no row.
 */

const SESSION = "session.jsonl";

/** A session file and a tail rewrite of it whose head is as long as the bytes it replaces. */
interface Plan {
	before: Buffer;
	headBytes: number;
	keepBytes: number;
	head: string;
	tail: string;
	/** What the file holds once the rewrite is done. */
	after: Buffer;
}

/** The bytes of a session of `count` user messages of `chars` characters, as the session manager writes it. */
async function sessionBytes(count: number, chars: number): Promise<Buffer> {
	using tempDir = TempDir.createSync("@veyyon-tail-seed-");
	const file = path.join(tempDir.path(), SESSION);
	const manager = await SessionManager.open(file, tempDir.path(), new FileSessionStorage());
	for (let i = 0; i < count; i++) {
		manager.appendMessage({ role: "user", content: `${i} ${"x".repeat(chars)}`, timestamp: 1_700_000_000_000 + i });
	}
	await manager.flush();
	// A whole publish puts the title slot first, as every tail rewrite expects.
	await manager.rewriteEntries();
	await manager.close();
	return fs.readFileSync(file);
}

/**
 * A rewrite of `before` that keeps its first `keepLines` entry lines: a title slot of the same width
 * with another title, the header as it was, and every later message with its text replaced by
 * `chars` characters.
 */
function planRewrite(before: Buffer, keepLines: number, chars: number): Plan {
	const lines = before.toString("utf8").split(/(?<=\n)/);
	const headBytes = Buffer.byteLength(lines[0]! + lines[1]!);
	const head =
		serializeTitleSlot({ title: "rewritten in place", source: "user", updatedAt: "2026-01-01T00:00:00.000Z" }) +
		lines[1]!;
	const keepBytes = Buffer.byteLength(lines.slice(0, 2 + keepLines).join(""));
	const tail = lines
		.slice(2 + keepLines)
		.map(line => {
			const entry = JSON.parse(line);
			if (entry.type === "message") entry.message.content = `pruned ${"y".repeat(chars)}`;
			return `${JSON.stringify(entry)}\n`;
		})
		.join("");
	const after = Buffer.concat([Buffer.from(head), before.subarray(headBytes, keepBytes), Buffer.from(tail)]);
	return { before, headBytes, keepBytes, head, tail, after };
}

function rewrite(file: string, plan: Plan): Promise<void> {
	return new FileSessionStorage().rewriteTailAtomic(file, plan.headBytes, plan.keepBytes, plan.head, plan.tail);
}

/** A fresh session file holding `bytes`, in a directory of its own. */
function placeSession(bytes: Buffer): { tempDir: TempDir; dir: string; file: string; ino: number } {
	const tempDir = TempDir.createSync("@veyyon-tail-in-place-");
	const file = path.join(tempDir.path(), SESSION);
	fs.writeFileSync(file, bytes);
	return { tempDir, dir: tempDir.path(), file, ino: fs.statSync(file).ino };
}

/**
 * Run `body` with each `fs.writeSync` and `fs.ftruncateSync` call on the file whose inode is `ino`
 * counted, and the one at index `failAt` failing with EIO before it changes anything: a crash at
 * that point of a rewrite. Returns how many of those calls there were.
 */
async function stoppingAtWrite(ino: number, failAt: number, body: () => Promise<void>): Promise<number> {
	let seen = 0;
	const step = (fd: number): void => {
		if (fs.fstatSync(fd).ino !== ino) return;
		if (seen++ === failAt) throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
	};
	const realWrite = fs.writeSync;
	const realTruncate = fs.ftruncateSync;
	const write = spyOn(fs, "writeSync").mockImplementation(((fd: number, ...rest: unknown[]) => {
		step(fd);
		return Reflect.apply(realWrite, fs, [fd, ...rest]);
	}) as unknown as typeof fs.writeSync);
	const truncate = spyOn(fs, "ftruncateSync").mockImplementation(((fd: number, length?: number) => {
		step(fd);
		realTruncate(fd, length);
	}) as typeof fs.ftruncateSync);
	try {
		await body();
	} finally {
		write.mockRestore();
		truncate.mockRestore();
	}
	return seen;
}

/** Leave `file` as a crash just before the rewrite's first write into it does: untouched, beside a sealed journal. */
async function stopBeforeFirstWrite(file: string, ino: number, plan: Plan): Promise<string> {
	await expect(stoppingAtWrite(ino, 0, () => rewrite(file, plan))).rejects.toThrow("EIO");
	expect(fs.readFileSync(file).equals(plan.before)).toBe(true);
	const others = fs.readdirSync(path.dirname(file)).filter(name => name !== SESSION);
	expect(others).toHaveLength(1);
	return path.join(path.dirname(file), others[0]!);
}

/**
 * Seal `journal` again with its record passed through `change`. `data` is how many bytes of head
 * and tail come before the record; the journal ends with the record's length as a 4-byte
 * little-endian integer and an 8-byte magic.
 */
function resealed(journal: string, data: number, change: (record: Record<string, unknown>) => object): void {
	const bytes = fs.readFileSync(journal);
	const footer = bytes.subarray(bytes.length - 12);
	const record = JSON.parse(bytes.subarray(data, data + footer.readUInt32LE(0)).toString("utf8"));
	const json = Buffer.from(JSON.stringify(change(record)));
	const length = Buffer.alloc(4);
	length.writeUInt32LE(json.length);
	fs.writeFileSync(journal, Buffer.concat([bytes.subarray(0, data), json, length, footer.subarray(4)]));
}

/** One more message line, as another writer appends it, padded to `bytes` bytes when given. */
function appendedLine(bytes?: number): string {
	const line = (content: string): string =>
		`${JSON.stringify({
			type: "message",
			id: "appended",
			parentId: null,
			timestamp: new Date(1_700_000_000_000).toISOString(),
			message: { role: "user", content },
		})}\n`;
	const content = "appended after the rewrite";
	if (bytes === undefined) return line(content);
	const padded = line(content + "x".repeat(bytes - Buffer.byteLength(line(content))));
	if (Buffer.byteLength(padded) !== bytes) throw new Error(`no appended line is ${bytes} bytes long`);
	return padded;
}

describe("a tail rewrite in place leaves a whole file after a crash", () => {
	let plan: Plan;

	beforeAll(async () => {
		// The new tail is several copy chunks long, so the sweep stops the copy between two of them.
		plan = planRewrite(await sessionBytes(600, 10_000), 300, 8_500);
		expect(Buffer.byteLength(plan.head)).toBe(plan.headBytes);
	});

	it("rewrites the tail inside the session file and leaves nothing beside it", async () => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;

		await rewrite(file, plan);

		expect(fs.readFileSync(file).equals(plan.after)).toBe(true);
		expect(fs.statSync(file).ino).toBe(ino);
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it("finishes on load a rewrite stopped at any write into the file", async () => {
		const clean = placeSession(plan.before);
		const writes = await stoppingAtWrite(clean.ino, -1, () => rewrite(clean.file, plan));
		await clean.tempDir.remove();
		// The head, the cut, and a tail long enough to be copied in more than one piece.
		expect(writes).toBeGreaterThan(3);

		for (let failAt = 0; failAt < writes; failAt++) {
			const { tempDir, dir, file, ino } = placeSession(plan.before);
			using _ = tempDir;
			await expect(stoppingAtWrite(ino, failAt, () => rewrite(file, plan))).rejects.toThrow("EIO");

			await loadSessionFile(file);

			expect(fs.readFileSync(file).equals(plan.after), `stopped at write ${failAt}`).toBe(true);
			expect(fs.statSync(file).ino).toBe(ino);
			expect(fs.readdirSync(dir), `stopped at write ${failAt}`).toEqual([SESSION]);
		}
	});

	it.each([
		{
			name: "holds only the head and the tail",
			alter: (journal: string, data: number) => fs.truncateSync(journal, data),
		},
		{
			name: "stops inside its record",
			alter: (journal: string, data: number) => fs.truncateSync(journal, data + 10),
		},
		{
			name: "lacks its last byte",
			alter: (journal: string) => fs.truncateSync(journal, fs.statSync(journal).size - 1),
		},
		{
			// A seal cut across a page by a power loss: the record and its length reached the disk, the magic did not.
			name: "ends in zeros where its seal ends",
			alter: (journal: string) => {
				const bytes = fs.readFileSync(journal);
				bytes.fill(0, bytes.length - 8);
				fs.writeFileSync(journal, bytes);
			},
		},
		{
			name: "holds a record that does not end where its tail does",
			alter: (journal: string, data: number) =>
				resealed(journal, data, record => ({ ...record, tail: Number(record.tail) + 1 })),
		},
	])("drops a journal that $name, and leaves the file as it was", async ({ alter }) => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		const journal = await stopBeforeFirstWrite(file, ino, plan);
		alter(journal, Buffer.byteLength(plan.head + plan.tail));

		await loadSessionFile(file);

		expect(fs.readFileSync(file).equals(plan.before)).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it("fails the load and leaves both files as they are when the journal is in another format", async () => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		await expect(stoppingAtWrite(ino, 2, () => rewrite(file, plan))).rejects.toThrow("EIO");
		const journal = path.join(dir, fs.readdirSync(dir).find(name => name !== SESSION)!);
		resealed(journal, Buffer.byteLength(plan.head + plan.tail), record => ({ ...record, v: 2 }));
		const stopped = fs.readFileSync(file);
		const sealed = fs.readFileSync(journal);

		await expect(loadSessionFile(file)).rejects.toThrow(
			`${file} was left part way through a rewrite, and finishing it from ${journal} failed: it is in journal format 2, and this version reads format 1. Open the session with the version that wrote the journal.`,
		);

		expect(fs.readFileSync(file).equals(stopped)).toBe(true);
		expect(fs.readFileSync(journal).equals(sealed)).toBe(true);
	});

	it("drops the journal of a stopped rewrite once a whole rewrite has replaced the file", async () => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		await expect(stoppingAtWrite(ino, 2, () => rewrite(file, plan))).rejects.toThrow("EIO");
		const replacement = path.join(dir, "replacement");
		fs.writeFileSync(replacement, plan.before);
		fs.renameSync(replacement, file);

		await loadSessionFile(file);

		expect(fs.readFileSync(file).equals(plan.before)).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it("keeps the lines another writer appended after a rewrite that stopped before writing the file", async () => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		await stopBeforeFirstWrite(file, ino, plan);
		fs.appendFileSync(file, appendedLine());

		await loadSessionFile(file);

		expect(fs.readFileSync(file).toString("utf8")).toBe(plan.before.toString("utf8") + appendedLine());
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it.each([
		{ name: "nothing", appended: () => "" },
		{ name: "lines appended since", appended: () => appendedLine() },
		// The file then has the size the rewrite started from, so only its bytes show it is done.
		{
			name: "lines appended since up to the size it had before",
			appended: (p: Plan) => appendedLine(p.before.length - p.after.length),
		},
	])("drops the journal a finished rewrite left, keeping $name", async ({ appended: appendedFor }) => {
		const appended = appendedFor(plan);
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		const unlink = spyOn(fs, "unlinkSync").mockImplementation(((target: fs.PathLike) => {
			unlink.mockRestore();
			throw Object.assign(new Error(`EIO: i/o error, unlink '${String(target)}'`), { code: "EIO" });
		}) as typeof fs.unlinkSync);
		await rewrite(file, plan);
		expect(fs.readdirSync(dir)).toHaveLength(2);
		fs.appendFileSync(file, appended);

		await loadSessionFile(file);

		expect(fs.readFileSync(file).toString("utf8")).toBe(plan.after.toString("utf8") + appended);
		expect(fs.statSync(file).ino).toBe(ino);
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it("stages a copy of the file while the journal of another rewrite is beside it", async () => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		const journal = await stopBeforeFirstWrite(file, ino, plan);

		await rewrite(file, plan);

		expect(fs.readFileSync(file).equals(plan.after)).toBe(true);
		expect(fs.statSync(file).ino).not.toBe(ino);
		expect(fs.existsSync(journal)).toBe(true);
		// That journal was written for the object the copy replaced.
		await loadSessionFile(file);
		expect(fs.readFileSync(file).equals(plan.after)).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it.each([
		{ name: "the bytes it keeps", count: 600, keepLines: 100, exceeds: { kept: true, cap: false } },
		{ name: "8 MiB", count: 2000, keepLines: 1010, exceeds: { kept: false, cap: true } },
	])("stages a copy of the file when the old tail is longer than $name", async ({ count, keepLines, exceeds }) => {
		const longer = planRewrite(await sessionBytes(count, 10_000), keepLines, 8_500);
		// Each row passes one limit and stays inside the other, so each limit is tested alone.
		const oldTail = longer.before.length - longer.keepBytes;
		expect({ kept: oldTail > longer.keepBytes, cap: oldTail > 8 << 20 }).toEqual(exceeds);
		const { tempDir, dir, file, ino } = placeSession(longer.before);
		using _ = tempDir;

		await rewrite(file, longer);

		expect(fs.readFileSync(file).equals(longer.after)).toBe(true);
		expect(fs.statSync(file).ino).not.toBe(ino);
		expect(fs.readdirSync(dir)).toEqual([SESSION]);
	});

	it("rewrites a pruned session's tail inside its file", async () => {
		const { tempDir, dir, file, ino } = placeSession(plan.before);
		using _ = tempDir;
		const manager = await SessionManager.open(file, dir, new FileSessionStorage());
		const entry = manager.getEntries().at(-5);
		if (entry?.type !== "message" || entry.message.role !== "user")
			throw new Error("the session lost its last messages");
		entry.message.content = "pruned in place";

		await manager.rewriteEntries([entry]);
		await manager.close();

		expect(fs.statSync(file).ino).toBe(ino);
		expect(fs.readdirSync(dir).filter(name => name.startsWith("."))).toEqual([]);
		const reloaded = (await loadEntriesFromFile(file)).find(loaded => "id" in loaded && loaded.id === entry.id);
		expect(reloaded).toMatchObject({ message: { content: "pruned in place" } });
	});
});
