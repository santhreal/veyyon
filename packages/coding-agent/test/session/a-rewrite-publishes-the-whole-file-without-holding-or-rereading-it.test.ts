import { afterEach, describe, expect, it, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: publishing a whole session used to cost two copies of the transcript and
 * a full read of it, and the process felt it.
 *
 * A rewrite (compaction, elision, a title-change fallback, a recovered error)
 * republishes the entire file. It built the body by string concatenation, handed
 * the one flattened string to the filesystem, and re-read the file first to see
 * whether another writer had appended to it. On a 253MiB transcript that was
 * 1056MiB of peak RSS, 604ms of it in one unbroken stretch, and 246ms spent
 * reading a file back to learn nothing. The body is now produced in ~1MiB chunks
 * by a factory, and the read-back is skipped while the file is still byte for
 * byte the one this manager published.
 *
 * The class these rows close is "a whole-file publish writes something other than
 * the whole file, or stops noticing another writer". Two hazards, both here:
 * chunking can drop, duplicate or truncate a chunk (and the EPERM fallback writes
 * the same body a SECOND time, which a spent generator cannot do), and a skipped
 * read-back can miss a change it needed to see. The foreign-line class itself is
 * owned by `two-managers-on-one-transcript.test.ts`, which is the suite that
 * proves a line another writer appended survives a publish; these rows defend the
 * conditions under which the read that finds it is allowed to be skipped.
 *
 * MEASURED (mutation matrix, each mutant applied alone, rows in file order):
 * - M1 the final partial chunk is never yielded: rows 1, 5 red. Row 6 stays green,
 *   which is the point of having both: it hands the storage a ready-made list of
 *   chunks and so proves the WRITER rather than the chunker.
 * - M2 the synchronous chunk writer stops after one chunk: row 6 red.
 * - M3 the asynchronous chunk writer stops after one chunk: row 1 red.
 * - M4 a body can be consumed only once: row 6 red, rows 1 and 5 green - one pass
 *   is all any other path asks for, and only the fallback asks twice.
 * - M5 the chunk writers open with "a" instead of "w": row 6 red.
 * - M6 the published size is counted in characters instead of UTF-8 bytes: row 2 red.
 * - M7 the skip compares size and ignores identity: row 4 red.
 * - M8 it compares identity and ignores size: rows 3, 7 red.
 * - M9 it answers true whenever anything has been published: rows 3, 4, 7 red.
 * - M10 the atomic publish stops recording what it published: row 2 red.
 *
 * WHAT THIS DOES NOT CATCH:
 * - A same-length in-place overwrite by something that is not a veyyon manager.
 *   Every publish in this product stages a temp file and renames it, so the inode
 *   changes; a foreign process that opened the path and overwrote it with exactly
 *   as many bytes keeps both halves of the check equal and is missed. Row 4 pins
 *   the case the product can actually produce.
 * - A backend that reports no identity. The memory and indexed backends do not,
 *   so they never skip and always read; these rows run on real files, which is
 *   where the product runs.
 * - Peak RSS and stall length. Those are cost claims and live in the measurement
 *   harness, not in an assertion here.
 */

/** Counts the reads a publish performs, which is what the skip is about. */
class ReadCountingStorage extends FileSessionStorage {
	reads: string[] = [];

	override readText(filePath: string): Promise<string> {
		this.reads.push(filePath);
		return super.readText(filePath);
	}

	override readTextSync(filePath: string): string | undefined {
		this.reads.push(filePath);
		return super.readTextSync(filePath);
	}
}

class FsCodeError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** Windows-style EPERM on the publish rename, which makes the body get written twice. */
class RenameEpermOnceStorage extends FileSessionStorage {
	failNextReplace = false;

	override renameSync(source: string, target: string): void {
		if (this.failNextReplace && source.includes(".tmp") && target.endsWith(".jsonl") && this.existsSync(target)) {
			this.failNextReplace = false;
			throw new FsCodeError("EPERM", `EPERM: operation not permitted, rename '${source}' -> '${target}'`);
		}
		super.renameSync(source, target);
	}
}

/** Multibyte on purpose: a body counted in characters is shorter than the file. */
const WIDE_TEXT = `${"réponse ".repeat(80)}${"漢字".repeat(80)}`;

async function seedSession(file: string, dir: string, storage: FileSessionStorage, count: number) {
	const manager = await SessionManager.open(file, dir, storage);
	for (let i = 0; i < count; i++) {
		manager.appendMessage({ role: "user", content: `${i} ${WIDE_TEXT}`, timestamp: Date.now() });
	}
	await manager.flush();
	return manager;
}

/** A line no manager here wrote, as another writer's append looks on disk. */
function foreignLine(id: string, text = "from somewhere else"): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text },
	})}\n`;
}

describe("a rewrite publishes the whole file without holding or re-reading it", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("republishes a clean transcript byte for byte, however many chunks it takes", async () => {
		using tempDir = TempDir.createSync("@veyyon-rewrite-chunks-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");
		const storage = new FileSessionStorage();
		// Past the chunk target several times over, counted the way the chunker
		// counts (characters, not bytes), so the body really is written in pieces and
		// a lost or repeated piece cannot pass unnoticed.
		const manager = await seedSession(file, dir, storage, 3000);

		const before = await fs.readFile(file);
		expect(before.toString("utf8").length).toBeGreaterThan(2 * (1 << 20));

		await manager.rewriteEntries();

		const after = await fs.readFile(file);
		expect(after.byteLength).toBe(before.byteLength);
		expect(after.equals(before)).toBe(true);

		await manager.close();
	});

	it("reads nothing back when the file is still the one it published", async () => {
		using tempDir = TempDir.createSync("@veyyon-rewrite-skip-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");
		const storage = new ReadCountingStorage();
		const manager = await seedSession(file, dir, storage, 40);

		// The first publish is what establishes what is on disk.
		await manager.rewriteEntries();
		manager.appendMessage({ role: "user", content: `after ${WIDE_TEXT}`, timestamp: Date.now() });
		await manager.flush();
		storage.reads = [];

		await manager.rewriteEntries();

		expect(storage.reads).toEqual([]);
		// Non-vacuity: the same counter sees the read when the file did change,
		// which rows 3 and 4 assert as behaviour rather than as a count.
		await fs.appendFile(file, foreignLine("outsider-after-skip"));
		await manager.rewriteEntries();
		expect(storage.reads).toContain(file);

		await manager.close();
	});

	it("reads the file back and keeps the line when another writer appended", async () => {
		using tempDir = TempDir.createSync("@veyyon-rewrite-append-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");
		const storage = new FileSessionStorage();
		const manager = await seedSession(file, dir, storage, 20);
		await manager.rewriteEntries();

		await fs.appendFile(file, foreignLine("outsider-append"));
		await manager.rewriteEntries();

		const raw = await fs.readFile(file, "utf8");
		expect(raw).toContain("outsider-append");
		expect(raw.split("\n").filter(line => line.includes("outsider-append"))).toHaveLength(1);

		await manager.close();
	});

	it("reads the file back when another writer replaced it with a body of the same length", async () => {
		using tempDir = TempDir.createSync("@veyyon-rewrite-swap-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");
		const storage = new FileSessionStorage();
		const manager = await seedSession(file, dir, storage, 20);
		await manager.rewriteEntries();

		// Another writer publishes the way every writer here does: stage a temp file,
		// rename it over the path. Same length, new inode. Size alone cannot see it.
		const current = await fs.readFile(file, "utf8");
		const marker = foreignLine("outsider-swap", "x");
		const padded = foreignLine("outsider-swap", "x".repeat(Buffer.byteLength(current, "utf8") - marker.length + 1));
		expect(Buffer.byteLength(padded, "utf8")).toBe(Buffer.byteLength(current, "utf8"));
		const staged = `${file}.other-writer.tmp`;
		await fs.writeFile(staged, padded);
		await fs.rename(staged, file);

		await manager.rewriteEntries();

		const raw = await fs.readFile(file, "utf8");
		expect(raw).toContain("outsider-swap");

		await manager.close();
	});

	it("writes the whole body again when the publish falls back after EPERM", async () => {
		using tempDir = TempDir.createSync("@veyyon-rewrite-eperm-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");
		const storage = new RenameEpermOnceStorage();
		const manager = await seedSession(file, dir, storage, 40);
		const before = await fs.readFile(file);

		storage.failNextReplace = true;
		await manager.rewriteEntries();

		const after = await fs.readFile(file);
		expect(after.byteLength).toBe(before.byteLength);
		expect(after.equals(before)).toBe(true);

		await manager.close();
	});

	it("writes every chunk at the target, twice, when the synchronous publish hits EPERM", async () => {
		using tempDir = TempDir.createSync("@veyyon-sync-eperm-");
		const target = path.join(tempDir.path(), "session.jsonl");
		// Longer than the body about to replace it, so a writer that appends instead
		// of truncating leaves a tail behind that the assertion can see.
		await fs.writeFile(target, "z".repeat(4096));

		const chunks = ["first chunk\n", "second chunk\n", `${"third chunk ".repeat(64)}\n`];
		let passes = 0;
		const body = () => {
			passes += 1;
			return chunks;
		};
		// The synchronous publish stages a temp file and renames it. EPERM on that
		// rename is the Windows case, and its fallback asks for the SAME body a
		// second time and writes it straight at the target: a body handed over as a
		// spent iterator has nothing left to give it.
		vi.spyOn(nodeFs, "renameSync").mockImplementationOnce(() => {
			throw new FsCodeError("EPERM", "EPERM: operation not permitted, rename");
		});

		new FileSessionStorage().writeTextSync(target, body);

		expect(await fs.readFile(target, "utf8")).toBe(chunks.join(""));
		expect(passes).toBe(2);
	});

	it("keeps noticing another writer after a publish that skipped the read", async () => {
		using tempDir = TempDir.createSync("@veyyon-rewrite-after-skip-");
		const dir = tempDir.path();
		const file = path.join(dir, "session.jsonl");
		const storage = new FileSessionStorage();
		const manager = await seedSession(file, dir, storage, 20);

		// Publish, publish again (this one skips the read), then let somebody else
		// append: the state the skip trusts has to have been refreshed by the
		// publish that skipped, or this line is deleted.
		await manager.rewriteEntries();
		await manager.rewriteEntries();
		await fs.appendFile(file, foreignLine("outsider-late"));
		await manager.rewriteEntries();

		const raw = await fs.readFile(file, "utf8");
		expect(raw).toContain("outsider-late");

		await manager.close();
	});
});
