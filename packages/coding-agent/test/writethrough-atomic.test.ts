import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writethroughNoop } from "@veyyon/coding-agent/lsp";

/**
 * The edit/write commit path must be crash-atomic AND permission-preserving.
 *
 * WHY THIS SUITE EXISTS. The production writethrough (`runLspWritethrough` and
 * `writethroughNoop` in `src/lsp/index.ts`) used to persist the user's source
 * with a raw `Bun.write(dst, content)` — a truncate-then-stream. If the process
 * died mid-write (SIGINT, OOM-kill, a full disk) the file was left truncated:
 * silent corruption of the exact file the agent was editing. The fix routes both
 * writes through `commitFileContentAtomic`, which uses `@veyyon/utils`
 * `atomicWriteFile` (write a sibling temp, then `rename` it over the target, so a
 * crash leaves either the whole old file or the whole new one).
 *
 * Atomic-rename-based writes have two regression traps that these tests lock:
 *   1. The rename swaps in a NEW inode, so the replacement takes the temp file's
 *      permissions. `atomicWriteFile` defaults to `0o600`; left unmanaged, every
 *      edit would silently strip a shell script's `+x` and drop group/other read
 *      bits. `commitFileContentAtomic` stats the existing file and carries its
 *      mode forward, so an executable stays executable.
 *   2. Renaming a temp over a symlink NAME would replace the link with a regular
 *      file, detaching a dotfile-managed path from its real target.
 *      `atomicWriteFile` resolves the link and writes the target, so the link
 *      survives and its target receives the bytes.
 * Plus: the temp file must never leak into the directory, and the content must
 * land byte-exact. Crash-atomicity itself is structural (temp + rename) and is
 * covered by `@veyyon/utils`' own atomic-write tests; here we assert the
 * writethrough actually routes through it and upholds the two no-regret
 * properties above.
 *
 * The mode/symlink assertions are POSIX semantics, so they are skipped on
 * Windows where `st_mode` bits and unprivileged symlinks do not apply.
 */

const POSIX = process.platform !== "win32";

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-writethrough-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** Files left in `dir` after a write — used to prove no `.tmp` sibling leaked. */
async function dirEntries(): Promise<string[]> {
	return (await fs.readdir(dir)).sort();
}

describe("writethrough is crash-atomic and permission-preserving", () => {
	it("writes the exact content and leaves no temp file behind", async () => {
		const target = path.join(dir, "note.txt");
		await writethroughNoop(target, "hello world\n");
		expect(await fs.readFile(target, "utf8")).toBe("hello world\n");
		// Only the target — no `.note.txt.<pid>.<n>.tmp` sibling survived.
		expect(await dirEntries()).toEqual(["note.txt"]);
	});

	it("overwrites an existing file with full new content (no partial/append)", async () => {
		const target = path.join(dir, "code.ts");
		await fs.writeFile(target, "const a = 1;\nconst b = 2;\n");
		await writethroughNoop(target, "export const x = 42;\n");
		expect(await fs.readFile(target, "utf8")).toBe("export const x = 42;\n");
		expect(await dirEntries()).toEqual(["code.ts"]);
	});

	it.skipIf(!POSIX)("preserves the executable bit of an existing script (0o755)", async () => {
		const target = path.join(dir, "run.sh");
		await fs.writeFile(target, "#!/bin/sh\necho old\n");
		await fs.chmod(target, 0o755);
		await writethroughNoop(target, "#!/bin/sh\necho new\n");
		expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
		expect(await fs.readFile(target, "utf8")).toBe("#!/bin/sh\necho new\n");
	});

	it.skipIf(!POSIX)("preserves a restrictive existing mode (0o640) rather than widening it", async () => {
		const target = path.join(dir, "secret.env");
		await fs.writeFile(target, "TOKEN=old\n");
		await fs.chmod(target, 0o640);
		await writethroughNoop(target, "TOKEN=new\n");
		expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
	});

	it.skipIf(!POSIX)("creates a brand-new file at 0o644 (masked by umask), never the 0o600 default", async () => {
		const target = path.join(dir, "fresh.txt");
		await writethroughNoop(target, "brand new\n");
		const mode = (await fs.stat(target)).mode & 0o777;
		// The helper opens the temp with 0o644; the OS applies the process umask.
		// Reading umask without an argument does not mutate it.
		const expected = 0o644 & ~process.umask();
		expect(mode).toBe(expected);
		// The whole point: a new source file is not clamped to owner-only 0o600.
		expect(mode & 0o044).not.toBe(0);
	});

	it.skipIf(!POSIX)("writes through a symlink, keeping the link and updating its target", async () => {
		const realTarget = path.join(dir, "real.txt");
		const link = path.join(dir, "link.txt");
		await fs.writeFile(realTarget, "before\n");
		try {
			await fs.symlink(realTarget, link);
		} catch {
			// Unprivileged symlink creation unavailable on this host; nothing to test.
			return;
		}
		await writethroughNoop(link, "after\n");
		// The link is still a link (not clobbered into a regular file)...
		expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
		// ...and its target received the bytes.
		expect(await fs.readFile(realTarget, "utf8")).toBe("after\n");
		expect(await fs.readFile(link, "utf8")).toBe("after\n");
	});
});
