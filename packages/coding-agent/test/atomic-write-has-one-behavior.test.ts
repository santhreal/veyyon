/**
 * The two atomic-write implementations behave identically, so the second copy cannot drift.
 *
 * WHY THIS SUITE EXISTS. Crash-safe file writing has two homes in this repository, on purpose:
 * `@veyyon/utils/atomic-write` (`atomicWriteFile`, `atomicWriteFilePreservingMode`, and the sync
 * twin) and a self-contained copy inside `@veyyon/hashline/fs` (`writeFileAtomic`). Hashline is
 * published as a lean patch library whose only dependencies are `diff` and `lru-cache`, so importing
 * `@veyyon/utils` would drag winston, handlebars and the native addon into every consumer of a
 * library that just applies patches. The duplication is the lesser cost, and the ONE PLACE rule is
 * satisfied instead by a promise in both doc comments: keep them in step by behavior.
 *
 * A promise in a comment is not a mechanism, and this pair had already drifted in three ways that
 * each cost real data. Hashline followed a symlink ONE hop with `readlink` where utils follows the
 * whole chain with `realpath`, so a source file reached through a link-to-a-link — an ordinary linked
 * package or dotfile layout — had its intermediate link replaced by a regular file while the file the
 * user keeps never received the patch, silently in both directions. Hashline had no
 * regular-file check, so a path naming a FIFO, a socket or a device node was DESTROYED and left as a
 * regular file. Hashline never flushed, so its doc comment's claim of surviving power loss was true
 * of the file's existence and not of its contents. It is the patcher: it writes the user's source
 * files, which is the most consequential write in the product.
 *
 * So this suite drives BOTH implementations through the same scenarios and asserts the same
 * observable result from each. It lives in `coding-agent` because that is the only package that
 * depends on both, and it is the gate a change to either one has to pass: change one, run this, change
 * the other. A behavior that is deliberately different is stated as such below rather than skipped,
 * because an untested difference is indistinguishable from drift.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic as hashlineWrite } from "@veyyon/hashline/fs";
import { atomicWriteFilePreservingMode as utilsWrite } from "@veyyon/utils/atomic-write";
import { collectPackageSources } from "../../utils/test/support/package-sources";

/**
 * The two writers under comparison.
 *
 * `atomicWriteFilePreservingMode` is the right counterpart, not `atomicWriteFile`: hashline always
 * carries the target's current mode forward, and `atomicWriteFile` defaults to 0o600 because its
 * callers write token-bearing config. Comparing against the 0o600 form would report a difference that
 * is a difference of purpose, not of implementation.
 */
const WRITERS: ReadonlyArray<{ name: string; write: (file: string, text: string) => Promise<void> }> = [
	{ name: "hashline writeFileAtomic", write: hashlineWrite },
	{ name: "utils atomicWriteFilePreservingMode", write: (file, text) => utilsWrite(file, text) },
];

let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-atomic-parity-"));
});

afterEach(async () => {
	// chmod back before removal: a test that dropped write permission on a directory to force an
	// error would otherwise leave a tree rm cannot enter.
	await fs.chmod(root, 0o700).catch(() => {});
	for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (entry.isDirectory()) await fs.chmod(path.join(root, entry.name), 0o700).catch(() => {});
	}
	await fs.rm(root, { recursive: true, force: true });
});

/** Mode bits of `file`, following symlinks, as the octal number a chmod call would take. */
async function modeOf(file: string): Promise<number> {
	return (await fs.stat(file)).mode & 0o777;
}

/** Every entry in `dir`, so a leaked temp file is visible rather than merely unlikely. */
async function entries(dir: string): Promise<string[]> {
	return (await fs.readdir(dir)).sort();
}

for (const { name, write } of WRITERS) {
	describe(name, () => {
		it("creates a file that does not exist yet and puts the exact bytes in it", async () => {
			const file = path.join(root, "created.ts");

			await write(file, "export const a = 1;\n");

			expect(await Bun.file(file).text()).toBe("export const a = 1;\n");
		});

		it("replaces an existing file's contents byte for byte", async () => {
			// The ordinary patch write. Asserted on exact bytes because a truncating write and an
			// atomic one are indistinguishable on a successful run by any weaker check.
			const file = path.join(root, "replaced.ts");
			await Bun.write(file, "old\n");

			await write(file, "new\n");

			expect(await Bun.file(file).text()).toBe("new\n");
		});

		it("carries the existing file's permission bits forward", async () => {
			// The rename swaps the inode, so the mode has to be read and re-applied. Without this an
			// executable script loses its `+x` on the first patch and stops running, with nothing
			// pointing at the patcher as the cause.
			const file = path.join(root, "script.sh");
			await Bun.write(file, "#!/bin/sh\necho old\n");
			await fs.chmod(file, 0o755);

			await write(file, "#!/bin/sh\necho new\n");

			expect(await modeOf(file)).toBe(0o755);
		});

		it("creates a new file as 0o644 rather than something more restrictive", async () => {
			// Source files are not secrets. 0o600 would be wrong here for the same reason it is right
			// in utils' default writer, which is why the preserving-mode form is the counterpart.
			const file = path.join(root, "fresh.ts");

			await write(file, "x\n");

			// The process umask can only remove bits, so this is the ceiling, not an equality.
			expect((await modeOf(file)) & 0o022).toBe(0);
			expect((await modeOf(file)) & 0o600).toBe(0o600);
		});

		it("leaves no temp file behind on a successful write", async () => {
			// The temp lives in the target's own directory, so a leak is visible to the user as a
			// dotfile beside their source and to tooling as an untracked file.
			const file = path.join(root, "clean.ts");

			await write(file, "one\n");
			await write(file, "two\n");

			expect(await entries(root)).toEqual(["clean.ts"]);
		});

		it("replaces the file at the END of a symlink chain and preserves every link", async () => {
			// THE REGRESSION. `real.ts` <- `middle.ts` <- `entry.ts`. Following one hop replaces
			// `middle.ts` with a regular file: the link is gone, `real.ts` still holds the old text,
			// and a read through `entry.ts` returns the new bytes, so nothing about the result looks
			// wrong until the user opens the file they actually keep.
			const real = path.join(root, "real.ts");
			const middle = path.join(root, "middle.ts");
			const entry = path.join(root, "entry.ts");
			await Bun.write(real, "old\n");
			await fs.symlink(real, middle);
			await fs.symlink(middle, entry);

			await write(entry, "new\n");

			expect(await Bun.file(real).text()).toBe("new\n");
			expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
			expect((await fs.lstat(entry)).isSymbolicLink()).toBe(true);
			expect(await fs.readlink(middle)).toBe(real);
		});

		it("preserves the mode of the file a symlink points at", async () => {
			// `stat` follows the link, so the mode read is the target's. Reading the LINK's mode
			// instead would pick up the 0o777 a symlink carries and widen the real file.
			const real = path.join(root, "real.sh");
			const link = path.join(root, "link.sh");
			await Bun.write(real, "old\n");
			await fs.chmod(real, 0o750);
			await fs.symlink(real, link);

			await write(link, "new\n");

			expect(await modeOf(real)).toBe(0o750);
			expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		});

		it("refuses to write over a directory instead of reporting a bare EISDIR", async () => {
			// `rename` onto a directory fails anyway, but with an error that names no reason. The
			// refusal has to say which path was wrong and what it actually is.
			const dir = path.join(root, "adirectory");
			await fs.mkdir(dir);

			await expect(write(dir, "x\n")).rejects.toThrow(/Refusing to write .*adirectory: it is a directory/);
			expect((await fs.lstat(dir)).isDirectory()).toBe(true);
		});

		it("refuses to write over a named pipe rather than destroying it", async () => {
			// `rename` would succeed here and leave a regular file where the FIFO was, breaking
			// whatever process held the other end, with no error anywhere.
			const fifo = path.join(root, "apipe");
			const made = Bun.spawnSync(["mkfifo", fifo]);
			if (made.exitCode !== 0) return; // no mkfifo on this platform; the directory case covers the rule

			await expect(write(fifo, "x\n")).rejects.toThrow(/Refusing to write .*apipe: it is a named pipe \(FIFO\)/);
			expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
		});

		it("creates missing parent directories for a regular path", async () => {
			// A patch that creates `src/new/mod.ts` in a directory that does not exist yet is an
			// ordinary create, not an error.
			const file = path.join(root, "deep", "nested", "mod.ts");

			await write(file, "x\n");

			expect(await Bun.file(file).text()).toBe("x\n");
		});

		it("does not fabricate the target directory of a dangling symlink", async () => {
			// The other side of the mkdir convenience. A link pointing into a directory that is not
			// there is a broken link, and inventing the tree turns a loud failure into a new
			// directory nobody asked for and a file the link now resolves to by accident.
			const link = path.join(root, "dangling.ts");
			await fs.symlink(path.join(root, "absent", "target.ts"), link);

			await expect(write(link, "x\n")).rejects.toThrow();
			expect(await entries(root)).toEqual(["dangling.ts"]);
		});

		it("names the target, not the temp file, when the directory cannot be written to", async () => {
			// The error the OS produces names a temp path that never existed as far as the caller is
			// concerned and changes on every attempt, which sends people hunting for a stray file
			// instead of at the permissions that stopped them.
			if (process.getuid?.() === 0) return; // root ignores the mode bits

			const dir = path.join(root, "readonly");
			await fs.mkdir(dir);
			const file = path.join(dir, "target.ts");
			await Bun.write(file, "old\n");
			await fs.chmod(dir, 0o500);

			const failure = await write(file, "new\n").then(
				() => undefined,
				(error: unknown) => error as Error,
			);

			expect(failure).toBeInstanceOf(Error);
			expect(failure?.message).toContain("target.ts");
			expect(failure?.message).not.toMatch(/\.tmp/);
			// The original error survives so a caller matching on the code still works.
			expect((failure as NodeJS.ErrnoException).code).toBe("EACCES");
			// And the file it could not replace is untouched.
			await fs.chmod(dir, 0o700);
			expect(await Bun.file(file).text()).toBe("old\n");
		});

		it("leaves no temp file behind when the write fails", async () => {
			if (process.getuid?.() === 0) return;

			const dir = path.join(root, "readonly2");
			await fs.mkdir(dir);
			await Bun.write(path.join(dir, "target.ts"), "old\n");
			await fs.chmod(dir, 0o500);

			await expect(write(path.join(dir, "target.ts"), "new\n")).rejects.toThrow();

			await fs.chmod(dir, 0o700);
			expect(await entries(dir)).toEqual(["target.ts"]);
		});

		it("writes an empty string as an empty file rather than skipping the write", async () => {
			// A patch that deletes every line of a file produces an empty string, and "falsy so
			// nothing to do" is a real way to lose that edit.
			const file = path.join(root, "emptied.ts");
			await Bun.write(file, "content\n");

			await write(file, "");

			expect(await Bun.file(file).text()).toBe("");
			expect((await fs.stat(file)).size).toBe(0);
		});

		it("round-trips bytes that are not plain ASCII", async () => {
			// The temp is written and the target is read back through different APIs in the two
			// implementations, so an encoding difference between them is possible in principle.
			const file = path.join(root, "unicode.ts");
			const text = 'const s = "héllo → 世界 🙂";\n';

			await write(file, text);

			expect(await Bun.file(file).text()).toBe(text);
		});

		it("keeps both writes intact when two writes to different files interleave", async () => {
			// The temp name carries a per-process counter for exactly this reason: a fixed
			// `${path}.tmp` suffix races, and the loser's bytes end up in the winner's file.
			const a = path.join(root, "a.ts");
			const b = path.join(root, "b.ts");

			await Promise.all([write(a, "AAA\n"), write(b, "BBB\n")]);

			expect(await Bun.file(a).text()).toBe("AAA\n");
			expect(await Bun.file(b).text()).toBe("BBB\n");
			expect(await entries(root)).toEqual(["a.ts", "b.ts"]);
		});

		it("gives the replacement a new inode, which is what makes the swap atomic", async () => {
			// The signature of temp+rename rather than truncate-and-stream. If this ever reports the
			// same inode, the implementation went back to writing in place and every crash-safety
			// claim above became decoration.
			const file = path.join(root, "inode.ts");
			await Bun.write(file, "old\n");
			const before = (await fs.stat(file)).ino;

			await write(file, "new\n");

			expect((await fs.stat(file)).ino).not.toBe(before);
		});
	});
}

describe("the two implementations", () => {
	it("produce identical file contents, mode and directory listing for the same sequence", async () => {
		// The parity assertion proper. Everything above is per-implementation; this one runs the same
		// script side by side in two directories and compares the two results to each other, so a
		// change that alters both in the same wrong way is still caught by the per-implementation
		// tests, and a change that alters only one is caught here.
		const results: Array<{ text: string; mode: number; listing: string[] }> = [];

		for (const { write } of WRITERS) {
			const dir = path.join(root, `seq-${results.length}`);
			await fs.mkdir(dir);
			const file = path.join(dir, "mod.ts");

			await write(file, "first\n");
			await fs.chmod(file, 0o640);
			await write(file, "second\n");
			await write(file, "");
			await write(file, "third\n");

			results.push({ text: await Bun.file(file).text(), mode: await modeOf(file), listing: await entries(dir) });
		}

		expect(results[0]).toEqual(results[1]);
		expect(results[0]?.text).toBe("third\n");
		expect(results[0]?.mode).toBe(0o640);
		expect(results[0]?.listing).toEqual(["mod.ts"]);
	});

	it("both refuse the same non-regular target with the same message", async () => {
		// The refusal is user-facing text, and two copies of a message drift faster than two copies
		// of logic. Compared as exact strings after the path is normalized away.
		const messages: string[] = [];

		for (const { write } of WRITERS) {
			const dir = path.join(root, `refuse-${messages.length}`);
			await fs.mkdir(dir);
			const target = path.join(dir, "adir");
			await fs.mkdir(target);
			const failure = await write(target, "x\n").then(
				() => "no error",
				(error: unknown) => (error as Error).message.replaceAll(target, "<TARGET>"),
			);
			messages.push(failure);
		}

		expect(messages[0]).toBe(messages[1]);
		expect(messages[0]).toBe(
			"Refusing to write <TARGET>: it is a directory, and an atomic write would replace it with a regular file. " +
				"Point the write at a regular file path instead.",
		);
	});

	it("both name the target the same way when the OS names the temp", async () => {
		// The restatement is the other piece of shared user-facing text.
		if (process.getuid?.() === 0) return;

		const suffixes: string[] = [];

		for (const _ of WRITERS) {
			const dir = path.join(root, `restate-${suffixes.length}`);
			await fs.mkdir(dir);
			const file = path.join(dir, "t.ts");
			await Bun.write(file, "old\n");
			await fs.chmod(dir, 0o500);
			const writer = WRITERS[suffixes.length];
			const failure = await writer!.write(file, "new\n").then(
				() => "no error",
				(error: unknown) => (error as Error).message,
			);
			await fs.chmod(dir, 0o700);
			suffixes.push(failure.slice(failure.indexOf("(the write is staged")));
		}

		expect(suffixes[0]).toBe(suffixes[1]);
		expect(suffixes[0]).toBe(
			"(the write is staged in a temporary file beside the target, so it can replace it atomically; " +
				"the temporary file is what the operating system named)",
		);
	});
});

/**
 * Every module that stages into a `.tmp` sibling and publishes it with a rename, and why it is not
 * simply calling one of the two writers.
 *
 * Two atomic-write implementations are a deliberate cost. A third would be the point where nobody can
 * say which semantics a given call site got, so a new temp-plus-rename has to earn its place here with
 * a reason. Five modules do earn it, and none of them is writing bytes to a file the way the writers
 * do: each stages something the writers cannot express, which is precisely why "just call the writer"
 * is not the fix.
 */
const JUSTIFIED_TEMP_RENAMES: ReadonlyMap<string, string> = new Map([
	["utils/src/atomic-write.ts", "the primary implementation"],
	["hashline/src/fs.ts", "the self-contained copy this suite pins against the primary"],
	[
		"coding-agent/src/cli/profile-cli.ts",
		"stages a whole profile DIRECTORY tree and renames the directory, so a half-built profile is " +
			"never visible under its real name. The writers replace one file and cannot express it.",
	],
	[
		"coding-agent/src/session/session-storage.ts",
		"its guard-check and rename must not be separated by an await, or a concurrent writer can " +
			"publish a fresh body in the gap and this stale one overwrites it. Both writers are async " +
			"between staging and rename, so using them would reopen that window.",
	],
	[
		"mnemopi/src/dr/recovery.ts",
		"opens the staged file as a SQLite database and runs an integrity check, then snapshots the " +
			"current database, BEFORE publishing. The writers rename as soon as the bytes land, so " +
			"there is nowhere to put the verification.",
	],
	[
		"utils/src/dirs.ts",
		"renames individual entries while migrating a legacy config layout, which moves files between " +
			"directories rather than replacing a file's contents.",
	],
	[
		"coding-agent/src/secrets/vault.ts",
		"publishes through the kernel's no-replace and exchange operations (secrets/atomic-path.ts: " +
			"renameat2 RENAME_NOREPLACE / RENAME_EXCHANGE, renameatx_np, ReplaceFileW) rather than a " +
			"plain rename, because the vault replacement is a compare-and-swap: it must refuse when the " +
			"destination appeared under it, and on a replace it inspects the DISPLACED inode's identity " +
			"and content hash and atomically rolls the old vault back when another writer won the race. " +
			"It also stages and publishes through a pinned directory descriptor (/proc/self/fd/N) with " +
			"O_EXCL|O_NOFOLLOW and mode 600, so no step of the transaction can be redirected by a " +
			"swapped parent directory. Both writers take a lexical path and rename unconditionally, so " +
			"calling one would drop the CAS, the rollback and the directory pin at once.",
	],
]);

describe("the source tree", () => {
	it("has a stated reason for every temp-plus-rename outside the two writers", async () => {
		// The lock that keeps this suite meaningful. A new hand-rolled staging rename anywhere in the
		// repository fails here, and the first fix to reach for is calling one of the two writers;
		// adding a row above is the fallback for a pattern they genuinely cannot express, and it costs
		// you writing down which one that is.
		const offenders: string[] = [];

		for (const source of await collectPackageSources()) {
			if (JUSTIFIED_TEMP_RENAMES.has(source.rel)) continue;
			// Matched on the temp-name construction AND a rename, not on `rename` alone: a plain
			// `rename(from, to)` for a move is legitimate and common, and flagging it would make this
			// lock noise that gets exempted wholesale.
			if (/\.tmp`|"\.tmp"|'\.tmp'/.test(source.text) && /\brename(Sync)?\s*\(/.test(source.text)) {
				offenders.push(source.rel);
			}
		}

		expect(offenders, "call atomicWriteFile or hashline's writeFileAtomic, or state a reason above").toEqual([]);
	});

	it("still finds every module it has a reason for, so no row is silently stale", async () => {
		// The other direction, and the reason the list above cannot rot: a module that stopped
		// hand-rolling (because it moved to one of the writers, or was deleted) leaves a row that
		// reads as a live exemption and would cover a NEW hand-roll appearing in the same file.
		const sources = new Map((await collectPackageSources()).map(source => [source.rel, source.text]));
		const stale: string[] = [];

		for (const rel of JUSTIFIED_TEMP_RENAMES.keys()) {
			const text = sources.get(rel);
			if (text === undefined || !/\brename(Sync)?\s*\(/.test(text)) stale.push(rel);
		}

		expect(stale, "remove the row: this module no longer stages a rename").toEqual([]);
	});
});
