import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache, readFile } from "@veyyon/coding-agent/capability/fs";
import { logger } from "@veyyon/utils";

const isWindows = process.platform === "win32";

describe("capability/fs readFile on special files", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-fs-special-"));
	});

	afterAll(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	// Contract: discovery scans foreign config dirs (~/.claude, ~/.cursor,
	// project trees). A FIFO/socket dropped where a context file is expected
	// must yield null instead of blocking startup forever on a read that can
	// never see EOF.
	it.skipIf(isWindows)("returns null for a FIFO instead of blocking", async () => {
		const fifo = path.join(dir, "CLAUDE.md");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		expect(made.exitCode).toBe(0);
		clearCache();
		// Real-clock race on purpose: a regressed readFile blocks inside a
		// kernel read() on the FIFO — there is no promise or event to await and
		// fake timers cannot advance a syscall. The sleep only bounds the
		// failure; the passing path returns immediately.
		const result = await Promise.race([readFile(fifo), Bun.sleep(1500).then(() => "HUNG" as const)]);
		if (result === "HUNG") {
			// Regression path: unblock the leaked FIFO reader so the test
			// process can exit, then fail on the assertion below.
			fs.closeSync(fs.openSync(fifo, "w"));
		}
		expect(result).toBeNull();
	});

	// Symlinked context files (CLAUDE.md -> AGENTS.md) are common; the type
	// gate must follow links rather than rejecting them.
	it.skipIf(isWindows)("still reads regular files through symlinks", async () => {
		const target = path.join(dir, "AGENTS.md");
		await Bun.write(target, "# context");
		const link = path.join(dir, "CLAUDE-link.md");
		await fs.promises.symlink(target, link);
		clearCache();
		expect(await readFile(link)).toBe("# context");
	});
});

describe("capability/fs readFile loud-vs-silent error split (Law 10)", () => {
	let dir = "";

	beforeAll(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-fs-errsplit-"));
	});

	afterAll(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	// A genuinely absent file (ENOENT) is the common discovery probe-miss:
	// fail soft to null and stay SILENT so a normal project without a
	// CLAUDE.md does not spam warnings on every startup.
	it("returns null and does NOT warn for a missing file (ENOENT is benign)", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			clearCache();
			const missing = path.join(dir, "does-not-exist.md");
			expect(await readFile(missing)).toBeNull();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	// A path whose parent component is a file yields ENOTDIR — also a benign
	// "not really there" case, so it must stay silent too.
	it("returns null and does NOT warn when a parent path component is a file (ENOTDIR)", async () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const file = path.join(dir, "not-a-dir.md");
			await Bun.write(file, "x");
			clearCache();
			const throughFile = path.join(file, "child.md");
			expect(await readFile(throughFile)).toBeNull();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	// A file that EXISTS but cannot be read (EACCES) is the real Law 10 case:
	// silently dropping it hides project context from the prompt with no
	// operator signal. readFile must fail soft (null, no throw, no hang) AND
	// warn loudly with the path. Root bypasses POSIX permission bits, so skip
	// when the current process can still read the chmod-000 file.
	it.skipIf(isWindows)("returns null AND warns for an existing-but-unreadable file (EACCES)", async () => {
		const secret = path.join(dir, "SECRET.md");
		await Bun.write(secret, "# private context");
		await fs.promises.chmod(secret, 0o000);
		let readableAnyway = false;
		try {
			await fs.promises.readFile(secret, "utf8");
			readableAnyway = true;
		} catch {
			// Expected for a non-root user: the chmod actually denies us.
		}
		if (readableAnyway) {
			// Running as root (common in CI containers): permission bits do not
			// apply, so EACCES cannot be simulated. Restore and skip.
			await fs.promises.chmod(secret, 0o644);
			return;
		}

		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			clearCache();
			const result = await readFile(secret);
			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledTimes(1);
			const [message, context] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
			expect(message).toContain("could not be read");
			expect(context.path).toBe(path.resolve(secret));
			expect(context.code).toBe("EACCES");
		} finally {
			warnSpy.mockRestore();
			await fs.promises.chmod(secret, 0o644);
		}
	});
});
