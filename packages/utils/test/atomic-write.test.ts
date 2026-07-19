import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, atomicWriteFileSync, atomicWriteFileWith } from "../src/atomic-write";
import { TempDir } from "../src/temp";

describe("atomicWriteFile", () => {
	let dir: TempDir;

	beforeEach(async () => {
		// "@" prefix places the temp dir under the OS temp root as an absolute path
		// (a bare prefix would be CWD-relative and litter the package directory).
		dir = await TempDir.create("@pi-atomic-write-");
	});

	afterEach(async () => {
		await dir.remove();
	});

	// Sibling temp files the writer creates while a write is in flight. A clean
	// success (or a cleaned-up failure) must leave none behind.
	function tempSiblings(target: string): string[] {
		const base = path.basename(target);
		return fs.readdirSync(path.dirname(target)).filter(name => name.startsWith(`.${base}.`) && name.endsWith(".tmp"));
	}

	it("writes string content exactly and leaves no temp file behind", async () => {
		const target = path.join(dir.path(), "config.yml");
		await atomicWriteFile(target, "profiles:\n  work: {}\n");

		expect(fs.readFileSync(target, "utf8")).toBe("profiles:\n  work: {}\n");
		expect(tempSiblings(target)).toEqual([]);
	});

	it("round-trips binary content byte for byte", async () => {
		const target = path.join(dir.path(), "blob.bin");
		const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
		await atomicWriteFile(target, bytes);

		expect(new Uint8Array(fs.readFileSync(target))).toEqual(bytes);
	});

	it("creates missing parent directories", async () => {
		const target = path.join(dir.path(), "nested", "deep", "config.yml");
		await atomicWriteFile(target, "ok");

		expect(fs.readFileSync(target, "utf8")).toBe("ok");
	});

	it("replaces an existing file with the full new content, never a mix", async () => {
		const target = path.join(dir.path(), "config.yml");
		await atomicWriteFile(target, "OLD_CONTENT_LONG\n".repeat(500));
		await atomicWriteFile(target, "NEW\n");

		// The whole old file is gone; only the new bytes remain (no append, no
		// leftover tail from the larger previous write).
		expect(fs.readFileSync(target, "utf8")).toBe("NEW\n");
	});

	it("defaults the created file to owner-only 0o600 permissions", async () => {
		if (process.platform === "win32") return; // POSIX mode bits only
		const target = path.join(dir.path(), "secret.yml");
		await atomicWriteFile(target, "token: abc");

		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
	});

	it("honors an explicit mode", async () => {
		if (process.platform === "win32") return;
		const target = path.join(dir.path(), "shared.yml");
		await atomicWriteFile(target, "x", { mode: 0o644 });

		expect(fs.statSync(target).mode & 0o777).toBe(0o644);
	});

	it("keeps a prior file intact and drops no temp when the write path is invalid", async () => {
		// A pre-existing good file whose path is then blocked: create a file where
		// the parent directory needs to be, so mkdir/open under it must fail.
		const blocker = path.join(dir.path(), "blocker");
		fs.writeFileSync(blocker, "i am a file, not a directory");
		const target = path.join(blocker, "child", "config.yml");

		await expect(atomicWriteFile(target, "data")).rejects.toThrow();

		// The blocker file is untouched and no stray temp files were created under
		// the temp root.
		expect(fs.readFileSync(blocker, "utf8")).toBe("i am a file, not a directory");
		expect(fs.readdirSync(dir.path())).toEqual(["blocker"]);
	});

	it("survives concurrent writes to one path: final content is exactly one complete payload", async () => {
		const target = path.join(dir.path(), "config.yml");
		// Distinct large payloads so a truncated or interleaved result is detectable.
		const payloads = Array.from({ length: 30 }, (_, i) => `PAYLOAD_${i}_`.repeat(4000));

		await Promise.all(payloads.map(p => atomicWriteFile(target, p)));

		const final = fs.readFileSync(target, "utf8");
		// The winner is complete and one of the inputs — never a blend of two.
		expect(payloads).toContain(final);
		expect(tempSiblings(target)).toEqual([]);
	});

	it("preserves a symlinked target, updating the file it points to", async () => {
		if (process.platform === "win32") return; // symlink creation needs privilege on Windows
		// config.yml is a symlink into a synced dotfiles dir, as a dotfile manager sets up.
		const realDir = path.join(dir.path(), "dotfiles");
		fs.mkdirSync(realDir);
		const realFile = path.join(realDir, "config.yml");
		fs.writeFileSync(realFile, "old: 1\n");
		const link = path.join(dir.path(), "config.yml");
		fs.symlinkSync(realFile, link);

		await atomicWriteFile(link, "new: 2\n");

		// The link still exists and still points at the real file, whose content updated.
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(realFile, "utf8")).toBe("new: 2\n");
		expect(fs.readFileSync(link, "utf8")).toBe("new: 2\n");
		expect(tempSiblings(realFile)).toEqual([]);
	});

	it("fails loudly on a dangling symlink instead of fabricating its directory", async () => {
		if (process.platform === "win32") return;
		// A link into a directory that does not exist. Writing must surface the
		// breakage, not silently create the directory and detach the link.
		const link = path.join(dir.path(), "config.yml");
		fs.symlinkSync(path.join(dir.path(), "missing-dir", "config.yml"), link);

		await expect(atomicWriteFile(link, "data")).rejects.toThrow();
		expect(fs.existsSync(path.join(dir.path(), "missing-dir"))).toBe(false);
	});

	it("writes correctly with fsync disabled", async () => {
		const target = path.join(dir.path(), "cache.json");
		await atomicWriteFile(target, '{"n":1}', { fsync: false });

		expect(fs.readFileSync(target, "utf8")).toBe('{"n":1}');
		expect(tempSiblings(target)).toEqual([]);
	});

	it("a reader never observes a partial file during an overwrite", async () => {
		const target = path.join(dir.path(), "config.yml");
		const small = "small";
		const big = "BIG\n".repeat(50000); // ~200 KB, forces a multi-block write
		await atomicWriteFile(target, small);

		// Interleave many reads against a big overwrite. Because the overwrite is a
		// rename, every read sees either the whole small file or the whole big one.
		const overwrite = atomicWriteFile(target, big);
		const reads: string[] = [];
		for (let i = 0; i < 200; i++) {
			reads.push(await fsp.readFile(target, "utf8"));
		}
		await overwrite;
		reads.push(fs.readFileSync(target, "utf8"));

		for (const seen of reads) {
			expect(seen === small || seen === big).toBe(true);
		}
		expect(fs.readFileSync(target, "utf8")).toBe(big);
	});

	describe("atomicWriteFileWith", () => {
		it("renames a path writer's output into place and leaves no temp behind", async () => {
			const target = path.join(dir.path(), "archive.tar");
			await atomicWriteFileWith(target, async tmpPath => {
				await fsp.writeFile(tmpPath, "PACKED_BYTES");
			});

			expect(fs.readFileSync(target, "utf8")).toBe("PACKED_BYTES");
			expect(tempSiblings(target)).toEqual([]);
		});

		it("creates missing parent directories for a path writer", async () => {
			const target = path.join(dir.path(), "nested", "deep", "archive.tar");
			await atomicWriteFileWith(target, tmpPath => fsp.writeFile(tmpPath, "ok"));

			expect(fs.readFileSync(target, "utf8")).toBe("ok");
		});

		it("does not touch the original target until the writer succeeds", async () => {
			const target = path.join(dir.path(), "archive.tar");
			await atomicWriteFile(target, "ORIGINAL");

			let sawOriginalMidWrite = "";
			await atomicWriteFileWith(target, async tmpPath => {
				// The rename has not happened yet, so the target must still read the
				// old content while the writer is producing the replacement.
				sawOriginalMidWrite = fs.readFileSync(target, "utf8");
				await fsp.writeFile(tmpPath, "REPLACEMENT");
			});

			expect(sawOriginalMidWrite).toBe("ORIGINAL");
			expect(fs.readFileSync(target, "utf8")).toBe("REPLACEMENT");
		});

		it("leaves the original intact and drops the temp when the writer throws", async () => {
			const target = path.join(dir.path(), "archive.tar");
			await atomicWriteFile(target, "ORIGINAL");

			await expect(
				atomicWriteFileWith(target, async tmpPath => {
					await fsp.writeFile(tmpPath, "HALF_WRITTEN");
					throw new Error("encoder blew up");
				}),
			).rejects.toThrow("encoder blew up");

			expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL");
			expect(tempSiblings(target)).toEqual([]);
		});

		it("preserves a symlinked target, updating the file it points to", async () => {
			if (process.platform === "win32") return;
			const realDir = path.join(dir.path(), "dotfiles");
			fs.mkdirSync(realDir);
			const realFile = path.join(realDir, "archive.tar");
			fs.writeFileSync(realFile, "old");
			const link = path.join(dir.path(), "archive.tar");
			fs.symlinkSync(realFile, link);

			await atomicWriteFileWith(link, tmpPath => fsp.writeFile(tmpPath, "new"));

			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(realFile, "utf8")).toBe("new");
			expect(tempSiblings(realFile)).toEqual([]);
		});

		it("survives concurrent path writers: final content is exactly one complete payload", async () => {
			const target = path.join(dir.path(), "archive.tar");
			const payloads = Array.from({ length: 20 }, (_, i) => `MEMBER_${i}_`.repeat(3000));

			await Promise.all(payloads.map(p => atomicWriteFileWith(target, tmpPath => fsp.writeFile(tmpPath, p))));

			const final = fs.readFileSync(target, "utf8");
			expect(payloads).toContain(final);
			expect(tempSiblings(target)).toEqual([]);
		});
	});

	describe("atomicWriteFileSync", () => {
		it("writes content exactly, creates parents, and leaves no temp file", () => {
			const target = path.join(dir.path(), "nested", "config.yml");
			atomicWriteFileSync(target, "defaultProfile: work\n");

			expect(fs.readFileSync(target, "utf8")).toBe("defaultProfile: work\n");
			expect(tempSiblings(target)).toEqual([]);
		});

		it("replaces an existing file with the full new content", () => {
			const target = path.join(dir.path(), "config.yml");
			atomicWriteFileSync(target, "OLD\n".repeat(500));
			atomicWriteFileSync(target, "NEW\n");

			expect(fs.readFileSync(target, "utf8")).toBe("NEW\n");
		});

		it("defaults to owner-only 0o600 permissions", () => {
			if (process.platform === "win32") return;
			const target = path.join(dir.path(), "secret.yml");
			atomicWriteFileSync(target, "token: abc");

			expect(fs.statSync(target).mode & 0o777).toBe(0o600);
		});

		it("preserves a symlinked target, updating the file it points to", () => {
			if (process.platform === "win32") return;
			const realDir = path.join(dir.path(), "dotfiles");
			fs.mkdirSync(realDir);
			const realFile = path.join(realDir, "config.yml");
			fs.writeFileSync(realFile, "old: 1\n");
			const link = path.join(dir.path(), "config.yml");
			fs.symlinkSync(realFile, link);

			atomicWriteFileSync(link, "new: 2\n");

			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(realFile, "utf8")).toBe("new: 2\n");
		});

		it("throws and leaves a prior file intact when the write path is invalid", () => {
			const blocker = path.join(dir.path(), "blocker");
			fs.writeFileSync(blocker, "i am a file");
			const target = path.join(blocker, "child", "config.yml");

			expect(() => atomicWriteFileSync(target, "data")).toThrow();
			expect(fs.readFileSync(blocker, "utf8")).toBe("i am a file");
			expect(fs.readdirSync(dir.path())).toEqual(["blocker"]);
		});
	});
});
