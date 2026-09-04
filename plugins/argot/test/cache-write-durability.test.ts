/**
 * ENV-5: a cache write that fails must leave the disk exactly as it found it.
 *
 * `writeDictFileAtomic` is the only thing that puts an argot dictionary on disk.
 * It writes a uniquely-named temp file beside the target and renames it into
 * place, which is the right shape: a reader sees either no entry or a whole one,
 * never half of one.
 *
 * Two things were missing from that shape, and both of them only bite on the day
 * the disk is full, which is the day you can least afford extra files and extra
 * mysteries.
 *
 * THE LEAK. A failure after the temp was created left the temp behind. The names
 * are unique by construction (pid plus a per-process counter), so nothing ever
 * reclaimed them: every failed attempt added one more partial file to the very
 * directory that had just run out of room, and each retry made the situation
 * slightly worse. A failed write must be a no-op on disk, not a deposit.
 *
 * THE DURABILITY GAP. The old code renamed without flushing. That is enough
 * against a concurrent reader, which is what the comment claimed, but not
 * against a crash: a filesystem may make the rename durable before the data, and
 * the entry comes back after a power loss as a zero-length file. An empty
 * dictionary is worse than a missing one, because a missing entry regenerates
 * and an empty one silently encodes nothing, which shows up as "argot stopped
 * saving tokens" rather than as an error.
 *
 * The failure is also never swallowed (Law 10). A cache write that quietly does
 * nothing becomes a permanent cache miss that reads as "argot is slow".
 *
 * Crash-durability cannot be asserted from a test process, so what is pinned
 * here is everything observable: no leaked temps on any path, the error
 * propagating with its cause intact, exact content, and the private file mode.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDictFileAtomic } from "../src/cache.js";

const roots: string[] = [];

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "argot-write-durability-"));
	roots.push(dir);
	return dir;
}

afterAll(async () => {
	for (const dir of roots) await rm(dir, { force: true, recursive: true });
});

/** Every `.tmp` sibling left in `dir`. A successful or failed write must leave none. */
async function leakedTemps(dir: string): Promise<string[]> {
	const entries = await readdir(dir);
	return entries.filter(name => name.endsWith(".tmp"));
}

describe("a failed write leaves nothing behind", () => {
	/**
	 * THE REGRESSION. The rename cannot land because the target path is a
	 * non-empty directory, so the temp has already been written when the failure
	 * happens. Before the fix that temp stayed on disk forever.
	 */
	test("removes the temp file when the rename fails", async () => {
		const dir = await scratch();
		const target = join(dir, "blocked.dict");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "occupant"), "in the way");

		await expect(writeDictFileAtomic(target, "vocab = 1\n")).rejects.toThrow();

		expect(await leakedTemps(dir)).toEqual([]);
	});

	/**
	 * The error propagates rather than being reported as success. A caller that
	 * believes the entry was saved will not regenerate it and will read a miss
	 * every run afterwards, which never looks like a disk problem.
	 */
	test("rejects instead of reporting a write that did not happen", async () => {
		const dir = await scratch();
		const target = join(dir, "blocked.dict");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "occupant"), "in the way");

		const error = await writeDictFileAtomic(target, "vocab = 1\n").catch((err: unknown) => err);

		expect(error).toBeInstanceOf(Error);
		// The operating system's own reason survives. A wrapped-and-retyped error
		// would tell an operator that argot failed without telling them why.
		expect((error as NodeJS.ErrnoException).code).toBeString();
	});

	/**
	 * Repeated failures do not accumulate. This is the one that distinguishes a
	 * leak from a one-off: the temp names are unique, so five failed writes used
	 * to mean five permanent files.
	 */
	test("leaves no residue after five consecutive failures", async () => {
		const dir = await scratch();
		const target = join(dir, "blocked.dict");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "occupant"), "in the way");

		for (let attempt = 0; attempt < 5; attempt++) {
			await writeDictFileAtomic(target, `attempt ${attempt}\n`).catch(() => {});
		}

		expect(await leakedTemps(dir)).toEqual([]);
	});

	/**
	 * A failed write does not disturb an entry that is already there. Cache
	 * entries are immutable and content-keyed, so losing a good one to a failed
	 * write of a different one would be a correctness loss, not a speed loss.
	 */
	test("leaves an existing unrelated entry untouched", async () => {
		const dir = await scratch();
		const good = join(dir, "good.dict");
		await writeFile(good, "kept = true\n");
		const target = join(dir, "blocked.dict");
		await mkdir(target, { recursive: true });
		await writeFile(join(target, "occupant"), "in the way");

		await writeDictFileAtomic(target, "vocab = 1\n").catch(() => {});

		expect(await readFile(good, "utf8")).toBe("kept = true\n");
	});
});

describe("a successful write is exact and tidy", () => {
	/**
	 * The positive case, asserted on exact bytes rather than on the file merely
	 * existing. A durability fix that corrupted or re-encoded the content would be
	 * a far worse bug than the leak it replaced.
	 */
	test("writes the content byte for byte", async () => {
		const dir = await scratch();
		const target = join(dir, "entry.dict");
		const content = '# argot\nfoo = "bar"\nbaz = "qux"\n';

		await writeDictFileAtomic(target, content);

		expect(await readFile(target, "utf8")).toBe(content);
	});

	/** Non-ASCII content round-trips as UTF-8, not as some default encoding. */
	test("round-trips non-ASCII content", async () => {
		const dir = await scratch();
		const target = join(dir, "unicode.dict");
		const content = 'ligne = "café"\nemoji = "🚀"\n';

		await writeDictFileAtomic(target, content);

		expect(await readFile(target, "utf8")).toBe(content);
	});

	/** The temp is consumed by the rename, so a successful write leaves none either. */
	test("leaves no temp file behind", async () => {
		const dir = await scratch();

		await writeDictFileAtomic(join(dir, "entry.dict"), "vocab = 1\n");

		expect(await leakedTemps(dir)).toEqual([]);
	});

	/**
	 * The entry is created private. A dictionary is derived from repository
	 * contents, so a world-readable one in a shared state directory leaks the
	 * shape of a private codebase to every other user on the machine.
	 */
	test("creates the entry with owner-only permissions", async () => {
		if (process.platform === "win32") return;
		const dir = await scratch();
		const target = join(dir, "entry.dict");

		await writeDictFileAtomic(target, "vocab = 1\n");

		expect((await stat(target)).mode & 0o777).toBe(0o600);
	});

	/** The parent directory is created, so a first write into a fresh cache works. */
	test("creates missing parent directories", async () => {
		const dir = await scratch();
		const target = join(dir, "deep", "nested", "entry.dict");

		await writeDictFileAtomic(target, "vocab = 1\n");

		expect(await readFile(target, "utf8")).toBe("vocab = 1\n");
	});

	/**
	 * Concurrent writers of the same entry all succeed and leave one file. This is
	 * the case the unique temp names exist for, and the cleanup must not turn into
	 * one writer deleting another's temp.
	 */
	test("survives eight concurrent writers of the same entry", async () => {
		const dir = await scratch();
		const target = join(dir, "contended.dict");
		const content = "shared = 1\n";

		await Promise.all(Array.from({ length: 8 }, () => writeDictFileAtomic(target, content)));

		expect(await readFile(target, "utf8")).toBe(content);
		expect(await leakedTemps(dir)).toEqual([]);
		expect((await readdir(dir)).sort()).toEqual(["contended.dict"]);
	});

	/**
	 * A rewrite replaces the previous content wholly. A partial overwrite would
	 * leave a dictionary that still parses, which is the failure mode that never
	 * announces itself.
	 */
	test("replaces a shorter existing entry completely", async () => {
		const dir = await scratch();
		const target = join(dir, "entry.dict");
		await writeDictFileAtomic(target, "a = 1\n");

		await writeDictFileAtomic(target, "a = 1\nb = 2\nc = 3\n");
		await writeDictFileAtomic(target, "z = 9\n");

		expect(await readFile(target, "utf8")).toBe("z = 9\n");
	});
});
