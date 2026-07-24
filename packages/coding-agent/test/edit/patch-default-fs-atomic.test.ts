import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch, defaultFileSystem } from "@veyyon/coding-agent/edit/modes/patch";

/**
 * `defaultFileSystem` is the filesystem `applyPatch` falls back to when a caller
 * does not inject its own — the shipped default behind every programmatic / SDK
 * `apply_patch` consumer. The interactive editor overrides it with the LSP
 * writethrough, which is crash-atomic, so the default must be equally safe:
 * otherwise an SDK consumer relying on the obvious, documented path gets a
 * non-atomic truncate-then-stream write, and a death mid-write (SIGINT, OOM-kill,
 * full disk) leaves the user's real source file truncated or empty.
 *
 * These tests pin the two guarantees the fix added over a bare `Bun.write`:
 *
 *  1. Crash-atomicity — the write goes through a sibling temp + rename, so the
 *     target is only ever the whole old bytes or the whole new bytes, and no
 *     temp file is left behind in the directory.
 *  2. Mode preservation — the rename swaps the inode, so without carrying the
 *     existing file's permission bits forward an executable script would silently
 *     lose its `+x`. New files still take the conventional 0o644 (umask-masked),
 *     not the atomic-writer's private-file 0o600 default.
 *
 * A regression to a plain overwrite would pass a naive "content landed" check but
 * fail these, which is exactly the silent data-loss class this guards.
 */
describe("patch defaultFileSystem crash-atomic writes", () => {
	const POSIX = process.platform !== "win32";
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-patch-default-fs-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	async function dirEntries(): Promise<string[]> {
		return (await fsp.readdir(dir)).sort();
	}

	it("overwrites an existing file with exactly the new content and leaves no temp file", async () => {
		const file = path.join(dir, "note.txt");
		await fsp.writeFile(file, "old contents that are longer than the new ones\n");

		await defaultFileSystem.write(file, "new\n");

		expect(await fsp.readFile(file, "utf8")).toBe("new\n");
		// Only the target file remains: a leaked `.tmp` sibling would mean the
		// rename step was skipped and the write was not atomic.
		expect(await dirEntries()).toEqual(["note.txt"]);
	});

	it("replaces the file via rename (new inode), the observable signature of a crash-atomic write", async () => {
		if (!POSIX) return;
		const file = path.join(dir, "swap.txt");
		await fsp.writeFile(file, "before\n");
		const inodeBefore = (await fsp.stat(file)).ino;

		await defaultFileSystem.write(file, "after\n");

		const inodeAfter = (await fsp.stat(file)).ino;
		// A temp + rename replaces the inode. A plain in-place `Bun.write` truncates
		// and rewrites the SAME inode, which is precisely the non-atomic behavior
		// this fix removed. Asserting the inode changed is what makes a regression
		// back to `Bun.write` fail here instead of passing a shape-only check.
		expect(inodeAfter).not.toBe(inodeBefore);
		expect(await fsp.readFile(file, "utf8")).toBe("after\n");
	});

	it("writes through a symlink by replacing its target, keeping the link intact", async () => {
		if (!POSIX) return;
		const target = path.join(dir, "target.txt");
		const link = path.join(dir, "link.txt");
		await fsp.writeFile(target, "target old\n");
		await fsp.symlink(target, link);

		await defaultFileSystem.write(link, "target new\n");

		// The link must still be a symlink pointing at the same target, and the
		// bytes must have landed on the target the link resolves to (not clobbered
		// the link into a regular file).
		expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fsp.readFile(target, "utf8")).toBe("target new\n");
		expect(await fsp.readFile(link, "utf8")).toBe("target new\n");
	});

	it("writes a brand-new file with exactly the given content", async () => {
		const file = path.join(dir, "fresh.txt");

		await defaultFileSystem.write(file, "hello world\n");

		expect(await fsp.readFile(file, "utf8")).toBe("hello world\n");
		expect(await dirEntries()).toEqual(["fresh.txt"]);
	});

	it("preserves the executable bit of an existing file across the rename", async () => {
		if (!POSIX) return;
		const file = path.join(dir, "run.sh");
		await fsp.writeFile(file, "#!/bin/sh\necho old\n");
		await fsp.chmod(file, 0o755);

		await defaultFileSystem.write(file, "#!/bin/sh\necho new\n");

		expect(await fsp.readFile(file, "utf8")).toBe("#!/bin/sh\necho new\n");
		expect((await fsp.stat(file)).mode & 0o777).toBe(0o755);
	});

	it("preserves a restrictive 0o640 mode of an existing file", async () => {
		if (!POSIX) return;
		const file = path.join(dir, "secret.conf");
		await fsp.writeFile(file, "token=old\n");
		await fsp.chmod(file, 0o640);

		await defaultFileSystem.write(file, "token=new\n");

		expect(await fsp.readFile(file, "utf8")).toBe("token=new\n");
		expect((await fsp.stat(file)).mode & 0o777).toBe(0o640);
	});

	it("gives a new file the conventional 0o644, not the atomic writer's private 0o600", async () => {
		if (!POSIX) return;
		const file = path.join(dir, "created.txt");

		await defaultFileSystem.write(file, "body\n");

		const expected = 0o644 & ~process.umask();
		expect((await fsp.stat(file)).mode & 0o777).toBe(expected);
	});

	it("applyPatch update through the default filesystem lands atomically on disk", async () => {
		const file = path.join(dir, "code.txt");
		await fsp.writeFile(file, "alpha\nbeta\ngamma\n");

		const result = await applyPatch(
			{
				path: file,
				op: "update",
				diff: ["@@", " alpha", "-beta", "+BETA", " gamma"].join("\n"),
			},
			{ cwd: dir },
		);

		expect(result.change.type).toBe("update");
		expect(await fsp.readFile(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
		// The applied update must not leave a temp artifact behind.
		expect(await dirEntries()).toEqual(["code.txt"]);
	});

	it("applyPatch create through the default filesystem writes the new file with no temp leak", async () => {
		const file = path.join(dir, "added.txt");

		const result = await applyPatch(
			{ path: file, op: "create", diff: "brand new line\n" },
			{ cwd: dir },
		);

		expect(result.change.type).toBe("create");
		expect(await fsp.readFile(file, "utf8")).toBe("brand new line\n");
		expect(await dirEntries()).toEqual(["added.txt"]);
	});
});
