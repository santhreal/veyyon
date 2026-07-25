/**
 * What the binary swap must refuse, and what it must never hide.
 *
 * `replaceBinaryForUpdate` renames a downloaded file over the installed binary.
 * Two of its failure paths were wrong in ways no existing suite could see, because
 * both only show up against a REAL file on a real filesystem — a symlink and a
 * read-only directory are not things a mocked `fs` reproduces. So every test here
 * drives the exported function against actual temp files, exactly as the probes
 * that found the defects did.
 *
 *  1. A SYMLINKED target was silently replaced. `~/.local/bin/vey` pointing at a
 *     checkout's build is how you develop on veyyon, and `rename()` over that path
 *     destroys the link: the checkout survives, nothing points at it any more, and
 *     the update reported success. You then keep editing a build that no longer
 *     runs. The probe printed `target still symlink: false` with the checkout
 *     untouched. Refusing is the only honest answer — writing THROUGH the link
 *     would clobber the build artifact instead (Law 10: fail closed, loudly).
 *  2. A CLEANUP failure replaced the real cause. In a read-only bin directory the
 *     swap fails, and then the `unlink` of the temp fails too; that second error
 *     propagated, so the operator was told veyyon could not delete `vey.new` when
 *     what actually happened is that it could not write into the directory at all.
 *     The probe printed `threw: EACCES ... unlink '/tmp/swap-ro-…/bin/vey.new'`.
 *     A cleanup that cannot run is a leaked temp file; the failure being reported
 *     is the one the user needs.
 *
 * Assertions read the thrown message and the files left on disk, never shape: the
 * whole point of both fixes is WHICH error text arrives and WHAT survives, and a
 * test that accepted any rejection would pass on either bug.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate } from "@veyyon/coding-agent/cli/update-cli";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		// A read-only bin dir has to be made writable again or the rm fails.
		await fs.chmod(path.join(dir, "bin"), 0o755).catch(() => {});
		await fs.rm(dir, { recursive: true, force: true });
	}
});

const OLD_BINARY = "#!/bin/sh\necho old\n";
const NEW_BINARY = "#!/bin/sh\necho new\n";

/** A bin directory holding the installed binary and a downloaded replacement. */
async function stageSwap(options: { symlinkTargetOutside?: boolean } = {}): Promise<{
	root: string;
	binDir: string;
	targetPath: string;
	tempPath: string;
	backupPath: string;
	checkoutPath: string;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "swap-"));
	tempDirs.push(root);
	const binDir = path.join(root, "bin");
	await fs.mkdir(binDir);
	const targetPath = path.join(binDir, "vey");
	const checkoutPath = path.join(root, "checkout-vey");

	if (options.symlinkTargetOutside) {
		await fs.writeFile(checkoutPath, OLD_BINARY, { mode: 0o755 });
		await fs.symlink(checkoutPath, targetPath);
	} else {
		await fs.writeFile(targetPath, OLD_BINARY, { mode: 0o755 });
	}
	const tempPath = `${targetPath}.new`;
	await fs.writeFile(tempPath, NEW_BINARY, { mode: 0o755 });
	return { root, binDir, targetPath, tempPath, backupPath: `${targetPath}.1.2.bak`, checkoutPath };
}

function verifierThatSucceeds(version: string) {
	return async () => ({ ok: true as const, version });
}

/** The rejection, as the user would read it. */
async function swapAndCaptureError(options: {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	verify?: (expected: string) => Promise<{ ok: boolean; version?: string }>;
}): Promise<string> {
	try {
		await replaceBinaryForUpdate({
			targetPath: options.targetPath,
			tempPath: options.tempPath,
			backupPath: options.backupPath,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: (options.verify ?? verifierThatSucceeds("9.9.9")) as never,
		});
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error("expected replaceBinaryForUpdate to throw, and it returned");
}

describe("a symlinked install target", () => {
	/** The refusal itself. Before the fix this call SUCCEEDED and reported an
	 * updated veyyon, having quietly deleted the developer's link. */
	it("is refused instead of replaced", async () => {
		const staged = await stageSwap({ symlinkTargetOutside: true });

		const message = await swapAndCaptureError(staged);

		expect(message).toContain("is a symlink to");
	});

	/** Naming both ends is the difference between a message you can act on and one
	 * you have to investigate: the user has to know WHICH path is a link and where
	 * it goes, because the recovery move is performed on the other end. */
	it("names the link and the path it points at", async () => {
		const staged = await stageSwap({ symlinkTargetOutside: true });

		const message = await swapAndCaptureError(staged);

		expect(message).toContain(staged.targetPath);
		expect(message).toContain(staged.checkoutPath);
	});

	/** An error that only says no leaves the user with no way forward. Both routes
	 * are spelled out, including the literal `rm` for the one that discards the link. */
	it("says how to recover, with the exact command", async () => {
		const staged = await stageSwap({ symlinkTargetOutside: true });

		const message = await swapAndCaptureError(staged);

		expect(message).toContain("Update that install directly");
		expect(message).toContain(`rm ${staged.targetPath}`);
	});

	it("leaves the symlink in place, still pointing where it did", async () => {
		const staged = await stageSwap({ symlinkTargetOutside: true });

		await swapAndCaptureError(staged);

		expect((await fs.lstat(staged.targetPath)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(staged.targetPath)).toBe(staged.checkoutPath);
	});

	/** The regression the probe caught: the checkout's build must be byte-identical,
	 * because writing through the link would have clobbered it. */
	it("leaves the checkout's binary byte-identical", async () => {
		const staged = await stageSwap({ symlinkTargetOutside: true });

		await swapAndCaptureError(staged);

		expect(await fs.readFile(staged.checkoutPath, "utf8")).toBe(OLD_BINARY);
	});

	/** Refusing before touching anything is what makes the refusal safe: no backup
	 * to restore, and no downloaded file left behind to confuse the next run. */
	it("creates no backup and cleans up the download", async () => {
		const staged = await stageSwap({ symlinkTargetOutside: true });

		await swapAndCaptureError(staged);

		expect(
			await fs.access(staged.backupPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(staged.tempPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	/** A HARDLINK is not this case and must still update. Package managers and
	 * build caches hardlink freely, the inode is a real binary at that path, and
	 * renaming over it is exactly right — refusing here would break ordinary
	 * installs in the name of a symlink guard. */
	it("does not refuse a hardlinked target", async () => {
		const staged = await stageSwap();
		await fs.link(staged.targetPath, path.join(staged.root, "other-name"));

		const result = await replaceBinaryForUpdate({
			...staged,
			expectedVersion: "9.9.9",
			verifyInstalledVersion: verifierThatSucceeds("9.9.9") as never,
		});

		expect(result.ok).toBe(true);
		expect(await fs.readFile(staged.targetPath, "utf8")).toBe(NEW_BINARY);
	});

	/** A missing target is a different failure with a different message, and the
	 * symlink probe must not turn its ENOENT into "is a symlink to null". */
	it("reports a missing target as missing, not as a symlink", async () => {
		const staged = await stageSwap();
		await fs.rm(staged.targetPath);

		const message = await swapAndCaptureError(staged);

		expect(message).not.toContain("symlink");
	});
});

describe("a failure inside a directory that cannot be written", () => {
	/** Stage a swap whose rename will fail, in a directory whose cleanup unlink
	 * will fail too. That combination is what produced the masked error. */
	async function stageReadOnly(): Promise<Awaited<ReturnType<typeof stageSwap>>> {
		const staged = await stageSwap();
		await fs.chmod(staged.binDir, 0o500);
		return staged;
	}

	/** The fix. Before it, this message was about unlinking `vey.new`. */
	it("reports the failure that actually happened, not the cleanup's", async () => {
		const staged = await stageReadOnly();

		const message = await swapAndCaptureError(staged);

		expect(message).not.toContain("vey.new");
	});

	/** Pinning the cause positively, so the test cannot pass on a message that has
	 * merely stopped mentioning the temp file. */
	it("keeps the underlying permission error as the reported cause", async () => {
		const staged = await stageReadOnly();

		const message = await swapAndCaptureError(staged);

		expect(message).toContain("EACCES");
		expect(message).toContain(staged.targetPath);
	});

	/** The whole reason a cleanup failure is allowed to be swallowed: the binary the
	 * user already had is untouched, which is the property that matters more than a
	 * leaked temp file. */
	it("leaves the installed binary intact and runnable", async () => {
		const staged = await stageReadOnly();

		await swapAndCaptureError(staged);
		await fs.chmod(staged.binDir, 0o755);

		expect(await fs.readFile(staged.targetPath, "utf8")).toBe(OLD_BINARY);
		expect((await fs.stat(staged.targetPath)).mode & 0o111).not.toBe(0);
	});

	/** The leak is the accepted cost, and stating it here is deliberate: if a future
	 * change makes this cleanup succeed, that is fine, but it must not come back as
	 * a throw that eats the cause. `sweepStaleBackups` reclaims leftovers later. */
	it("leaves the download behind rather than failing to remove it", async () => {
		const staged = await stageReadOnly();

		await swapAndCaptureError(staged);
		await fs.chmod(staged.binDir, 0o755);

		expect(await fs.readFile(staged.tempPath, "utf8")).toBe(NEW_BINARY);
	});
});

describe("a verification failure after the swap", () => {
	/** The rollback path is the one place a cleanup throw is still correct, and it
	 * must keep working: a binary that does not report the expected version is
	 * restored from the backup, and the user's message says so. */
	it("restores the previous binary", async () => {
		const staged = await stageSwap();

		const message = await swapAndCaptureError({
			...staged,
			verify: async () => ({ ok: false, version: "1.0.0" }),
		});

		expect(message).toContain("restored previous");
		expect(await fs.readFile(staged.targetPath, "utf8")).toBe(OLD_BINARY);
	});

	it("leaves neither the download nor the backup behind", async () => {
		const staged = await stageSwap();

		await swapAndCaptureError({ ...staged, verify: async () => ({ ok: false, version: "1.0.0" }) });

		expect(
			await fs.access(staged.tempPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(staged.backupPath).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});
});
