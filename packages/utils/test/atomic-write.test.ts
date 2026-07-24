import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	atomicWriteFile,
	atomicWriteFilePreservingMode,
	atomicWriteFileSync,
	atomicWriteFileWith,
	atomicWriteJson,
} from "../src/atomic-write";
import { TempDir } from "../src/temp";
import { collectPackageSources } from "./support/package-sources";

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

// ── Source lock: one home for temp-file + rename ─────────────────────────────
//
// Atomic writes have exactly one owner, packages/utils/src/atomic-write.ts. A
// hand-rolled `write to ${path}.tmp` then `rename` at a call site drifts (the
// copies this lock replaced variously skipped the fsync, the directory flush,
// the Windows rename-clobber fallback, and symlink preservation). This lock
// fails when a production source outside the owner pairs a `.tmp` temp token
// with a `rename` call, so a new copy has to route through the owner instead.
//
// A short allow-list covers the writers that legitimately pair the two for a
// reason the bytes/path owner cannot express. Each is NOT a call-site copy of
// the owner's logic; convert one only if that stops being true, then drop it.
const ATOMIC_OWNER = "utils/src/atomic-write.ts";
const HANDROLLED_ATOMIC_ALLOWED = new Map<string, string>([
	// A synchronous commit-guard fence checks a revoke flag and renames with no
	// await gap between them; the owner's async open/close would reintroduce the
	// gap the fence exists to close.
	["coding-agent/src/session/session-storage.ts", "bespoke commitGuard sync fence"],
	// Clones a git repo into a temp DIRECTORY and renames the directory into
	// place. The owner writes a single file, not a populated tree.
	["coding-agent/src/extensibility/plugins/marketplace/fetcher.ts", "temp clone directory, not a file write"],
	// Restore writes the candidate with exclusive-create (`wx`) and runs a SQLite
	// integrity check on the temp file BETWEEN the write and the rename, rolling
	// back on failure. The owner has no verify-before-rename hook.
	["mnemopi/src/dr/recovery.ts", "DR restore verifies the temp file before renaming"],
	// createProfile seeds a whole agent tree into a staging DIRECTORY and renames
	// the directory into place so a half-seeded profile never appears. The owner
	// writes a single file, not a populated tree.
	["coding-agent/src/cli/profile-cli.ts", "staging profile directory, not a file write"],
	// The global-root migration MOVES existing entries between directories with
	// renameSync (no temp file involved); its `.tmp` mentions are the profile
	// staging-sibling naming convention (`profiles/.name.<pid>.tmp`) in docs and
	// validation, not a temp-write. Nothing here copies the owner's logic.
	["utils/src/dirs.ts", "directory-entry moves + staging-name validation, not a temp-file write"],
	// hashline is a lean patch library that deliberately imports no `@veyyon/*`
	// (its consuming builds pin the published crate and exclude the vendored copy),
	// so it cannot route through the owner without dragging utils' heavy transitive
	// deps into it. `writeFileAtomic` there is a documented node:fs-only copy kept in
	// sync with the owner by behavior, not by import; unifying the two behind a
	// genuinely zero-dependency shared home is tracked as ONE-PLACE-ATOMIC-WRITE-UNIFY.
	["hashline/src/fs.ts", "lean dependency-free patch library; documented node:fs-only copy, cannot import the owner"],
]);

const RENAME_CALL = /\brename(?:Sync)?\s*\(/;
// A `.tmp` temp-file token. The `\b` after `tmp` keeps `os.tmpdir()` (a real,
// unrelated call in directory-migration code) from matching.
const TEMP_TOKEN = /\.tmp\b/;

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources). This lock scans production src only.
describe("atomic-write source lock", () => {
	it("no production source hand-rolls temp-file + rename outside the owner", async () => {
		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === ATOMIC_OWNER) continue;
			if (RENAME_CALL.test(text) && TEMP_TOKEN.test(text)) {
				seen.add(rel);
				if (!HANDROLLED_ATOMIC_ALLOWED.has(rel)) offenders.push(rel);
			}
		}
		const staleAllowed = [...HANDROLLED_ATOMIC_ALLOWED.keys()].filter(rel => !seen.has(rel));
		expect(
			offenders.sort(),
			"new hand-rolled temp+rename — call atomicWriteFile/atomicWriteFileWith from @veyyon/utils instead",
		).toEqual([]);
		expect(staleAllowed, "allow-listed file no longer hand-rolls temp+rename — remove it from the list").toEqual([]);
	});
});

/**
 * `atomicWriteJson` is the single owner of "serialize as pretty JSON + atomic
 * write" used by every on-disk registry/config writer. Before it existed, the
 * plugins installed-registry and marketplace-registry each hand-rolled
 * `atomicWriteFile(path, JSON.stringify(data, null, 2) + "\n")`; these tests lock
 * the exact serialization contract (2-space indent, single trailing newline,
 * round-trippable) so no writer drifts on formatting.
 */
describe("atomicWriteJson", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = await TempDir.create("@pi-atomic-json-");
	});

	afterEach(async () => {
		await dir.remove();
	});

	it("writes 2-space-indented JSON with exactly one trailing newline", async () => {
		const target = path.join(dir.path(), "reg.json");
		await atomicWriteJson(target, { version: 2, plugins: { "a@b": [] } });

		expect(fs.readFileSync(target, "utf8")).toBe('{\n  "version": 2,\n  "plugins": {\n    "a@b": []\n  }\n}\n');
	});

	it("round-trips through JSON.parse", async () => {
		const target = path.join(dir.path(), "reg.json");
		const data = { version: 2, plugins: { "x@y": [{ scope: "user", installPath: "/p", enabled: true }] } };
		await atomicWriteJson(target, data);

		expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(data);
	});

	it("creates missing parent directories", async () => {
		const target = path.join(dir.path(), "nested", "deep", "reg.json");
		await atomicWriteJson(target, { ok: 1 });

		expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ ok: 1 });
	});

	it("fully replaces a larger prior file, never leaving a tail", async () => {
		const target = path.join(dir.path(), "reg.json");
		await atomicWriteJson(target, { big: "x".repeat(5000) });
		await atomicWriteJson(target, { small: 1 });

		expect(fs.readFileSync(target, "utf8")).toBe('{\n  "small": 1\n}\n');
	});

	it("defaults the created file to owner-only 0o600 permissions", async () => {
		if (process.platform === "win32") return; // POSIX mode bits only
		const target = path.join(dir.path(), "secret.json");
		await atomicWriteJson(target, { token: "abc" });

		expect(fs.statSync(target).mode & 0o777).toBe(0o600);
	});
});

/**
 * `atomicWriteFilePreservingMode` is the variant for overwriting an existing
 * file whose permissions must not change. Plain `atomicWriteFile` replaces the
 * inode via rename and stamps the temp's `0o600`, which would silently strip a
 * script's `+x` or a file's group-read; this variant stats the target first and
 * carries its mode forward. These tests lock that no-regret behavior (the reason
 * the edit/write and move paths use it) plus the new-file default and the
 * symlink-target preservation it inherits.
 */
describe("atomicWriteFilePreservingMode", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = await TempDir.create("@pi-atomic-preserve-mode-");
	});

	afterEach(async () => {
		await dir.remove();
	});

	it("writes the exact new content over an existing file", async () => {
		const target = path.join(dir.path(), "code.ts");
		await fsp.writeFile(target, "old\n");
		await atomicWriteFilePreservingMode(target, "brand new content\n");
		expect(fs.readFileSync(target, "utf8")).toBe("brand new content\n");
	});

	it("preserves an executable file's mode (0o755) across the rewrite", async () => {
		if (process.platform === "win32") return; // POSIX mode bits only
		const target = path.join(dir.path(), "run.sh");
		await fsp.writeFile(target, "#!/bin/sh\necho old\n");
		await fsp.chmod(target, 0o755);
		await atomicWriteFilePreservingMode(target, "#!/bin/sh\necho new\n");
		expect(fs.statSync(target).mode & 0o777).toBe(0o755);
	});

	it("preserves a restrictive mode (0o640) rather than widening or clamping it", async () => {
		if (process.platform === "win32") return;
		const target = path.join(dir.path(), "data.env");
		await fsp.writeFile(target, "OLD\n");
		await fsp.chmod(target, 0o640);
		await atomicWriteFilePreservingMode(target, "NEW\n");
		expect(fs.statSync(target).mode & 0o777).toBe(0o640);
	});

	it("creates a brand-new file at the 0o644 default (masked by umask), not 0o600", async () => {
		if (process.platform === "win32") return;
		const target = path.join(dir.path(), "fresh.txt");
		await atomicWriteFilePreservingMode(target, "hi\n");
		expect(fs.statSync(target).mode & 0o777).toBe(0o644 & ~process.umask());
	});

	it("honors an explicit defaultMode for a new file", async () => {
		if (process.platform === "win32") return;
		const target = path.join(dir.path(), "exec-new.sh");
		await atomicWriteFilePreservingMode(target, "#!/bin/sh\n", { defaultMode: 0o700 });
		expect(fs.statSync(target).mode & 0o777).toBe(0o700 & ~process.umask());
	});

	it("leaves no temp sibling behind after a successful write", async () => {
		const target = path.join(dir.path(), "note.txt");
		await atomicWriteFilePreservingMode(target, "content\n");
		expect(fs.readdirSync(dir.path())).toEqual(["note.txt"]);
	});

	it("writes through a symlink, keeping the link and preserving the target's mode", async () => {
		if (process.platform === "win32") return; // symlink creation needs privilege on Windows
		const realTarget = path.join(dir.path(), "real.txt");
		const link = path.join(dir.path(), "link.txt");
		await fsp.writeFile(realTarget, "before\n");
		await fsp.chmod(realTarget, 0o600);
		fs.symlinkSync(realTarget, link);
		await atomicWriteFilePreservingMode(link, "after\n");
		// The link survived (was not replaced by a regular file)...
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		// ...the target got the bytes, and its 0o600 mode was carried forward.
		expect(fs.readFileSync(realTarget, "utf8")).toBe("after\n");
		expect(fs.statSync(realTarget).mode & 0o777).toBe(0o600);
	});
});
