import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesystem, sameExistingFile } from "../src/fs";

/**
 * `NodeFilesystem` is the shipped disk-backed default of the hashline patcher —
 * the filesystem a CLI consumer gets when it does not provide its own. Its
 * writes must be crash-atomic: the patcher is the most consequential write path
 * in the library (it rewrites the user's real source), and a plain in-place
 * `Bun.write` would leave the file truncated if the process died mid-write.
 *
 * These tests pin the observable signatures of the temp + rename the fix added,
 * for both `writeText` and the content form of `move`:
 *
 *  - exact bytes land and no temp sibling is left behind;
 *  - an overwrite replaces the inode (the signature of temp + rename — an
 *    in-place `Bun.write` keeps the same inode), which is what makes a
 *    regression back to a non-atomic write fail here instead of passing a
 *    shape-only "the content is there" check;
 *  - an existing file's mode (including a script's +x) is carried across the
 *    write, and a new file takes 0o644;
 *  - writing through a symlink replaces the link's target and keeps the link;
 *  - a content-move overwrites the destination atomically and the same-file
 *    guard still refuses to delete the bytes it just wrote.
 */
describe("NodeFilesystem crash-atomic writes", () => {
	const POSIX = process.platform !== "win32";
	let dir: string;
	let fs: NodeFilesystem;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hashline-node-fs-atomic-"));
		fs = new NodeFilesystem();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function entries(): string[] {
		return readdirSync(dir).sort();
	}

	it("writeText overwrites with exactly the new content and leaves no temp file", async () => {
		const file = join(dir, "note.txt");
		writeFileSync(file, "old content that is noticeably longer than the replacement\n");

		const result = await fs.writeText(file, "new\n");

		expect(result.text).toBe("new\n");
		expect(readFileSync(file, "utf8")).toBe("new\n");
		expect(entries()).toEqual(["note.txt"]);
	});

	it("writeText replaces the inode via rename, the signature of a crash-atomic write", async () => {
		if (!POSIX) return;
		const file = join(dir, "swap.txt");
		writeFileSync(file, "before\n");
		const inodeBefore = statSync(file).ino;

		await fs.writeText(file, "after\n");

		expect(statSync(file).ino).not.toBe(inodeBefore);
		expect(readFileSync(file, "utf8")).toBe("after\n");
	});

	it("writeText preserves an existing file's executable bit", async () => {
		if (!POSIX) return;
		const file = join(dir, "run.sh");
		writeFileSync(file, "#!/bin/sh\necho old\n");
		chmodSync(file, 0o755);

		await fs.writeText(file, "#!/bin/sh\necho new\n");

		expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho new\n");
		expect(statSync(file).mode & 0o777).toBe(0o755);
	});

	it("writeText preserves a restrictive 0o640 mode", async () => {
		if (!POSIX) return;
		const file = join(dir, "secret.conf");
		writeFileSync(file, "token=old\n");
		chmodSync(file, 0o640);

		await fs.writeText(file, "token=new\n");

		expect(statSync(file).mode & 0o777).toBe(0o640);
	});

	it("writeText gives a brand-new file 0o644", async () => {
		if (!POSIX) return;
		const file = join(dir, "fresh.txt");

		await fs.writeText(file, "hello\n");

		const expected = 0o644 & ~process.umask();
		expect(statSync(file).mode & 0o777).toBe(expected);
		expect(readFileSync(file, "utf8")).toBe("hello\n");
	});

	it("writeText through a symlink replaces the target and keeps the link", async () => {
		if (!POSIX) return;
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		writeFileSync(target, "target old\n");
		symlinkSync(target, link);

		await fs.writeText(link, "target new\n");

		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("target new\n");
		expect(readFileSync(link, "utf8")).toBe("target new\n");
	});

	it("move(content) overwrites the destination atomically and removes the source", async () => {
		const from = join(dir, "from.txt");
		const to = join(dir, "to.txt");
		writeFileSync(from, "source\n");
		writeFileSync(to, "destination old content, longer than the new\n");
		const toInodeBefore = statSync(to).ino;

		await fs.move(from, to, "moved content\n");

		expect(readFileSync(to, "utf8")).toBe("moved content\n");
		expect(statSync(to).ino).not.toBe(toInodeBefore);
		expect(entries()).toEqual(["to.txt"]);
	});

	it("move(content) onto the same file via symlink keeps the bytes it just wrote", async () => {
		if (!POSIX) return;
		const target = join(dir, "real.txt");
		const link = join(dir, "alias.txt");
		writeFileSync(target, "real old\n");
		symlinkSync(target, link);

		// `from` (the link) and `to` (the real file) resolve to the same inode, so
		// the same-file guard must skip the delete and preserve the written bytes.
		expect(await sameExistingFile(link, target)).toBe(true);
		await fs.move(link, target, "real new\n");

		expect(readFileSync(target, "utf8")).toBe("real new\n");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});
});
