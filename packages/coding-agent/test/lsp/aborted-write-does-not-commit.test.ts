import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fsp, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writethroughNoop } from "@veyyon/coding-agent/lsp";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";

/**
 * A cancelled write must not change the file.
 *
 * Every file a tool writes goes through one commit, which replaces the target
 * by renaming a fresh temp file over it. That already rules out a half-written
 * file: the rename either happened or it did not. What it did NOT rule out was
 * committing a write the operator had already cancelled. The abort signal was
 * threaded all the way down to the commit and then ignored, so a Ctrl+C during
 * a long edit reported "aborted" while the file on disk had been replaced.
 *
 * That combination is worse than either outcome alone. An operator who is told
 * the write was cancelled does not go back and check the file, so the change
 * they cancelled ships. The fix checks the signal immediately before the
 * rename, which is the last point where refusing costs nothing.
 *
 * These tests read the bytes on disk rather than the function's return value,
 * because "the file was not modified" is the actual contract and a return value
 * cannot prove it.
 */
describe("a file write that was aborted before it committed", () => {
	let dir = "";
	let target = "";
	const original = "the original contents\nsecond line\n";

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "veyyon-aborted-write-"));
		target = path.join(dir, "file.txt");
		writeFileSync(target, original, "utf-8");
	});

	afterEach(async () => {
		if (dir) {
			await fsp.rm(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	/** The core case: an already-aborted signal must stop the commit. */
	it("leaves the file exactly as it was", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(writethroughNoop(target, "replacement content\n", controller.signal)).rejects.toThrow();

		expect(readFileSync(target, "utf-8")).toBe(original);
	});

	/**
	 * The rejection has to be recognisable as an abort, not a generic write
	 * failure. A caller that cannot tell the two apart will report a broken
	 * filesystem when the user simply pressed Ctrl+C, and the retry logic above
	 * it will keep trying to write a file nobody wants written.
	 *
	 * `ToolAbortError` is the type every tool path already checks for, and the
	 * original reason travels as its `cause` so the detail is not lost.
	 */
	it("rejects with a tool abort carrying the original reason", async () => {
		const controller = new AbortController();
		const reason = new Error("user pressed Ctrl+C");
		controller.abort(reason);

		const error = await writethroughNoop(target, "replacement\n", controller.signal).catch(caught => caught);

		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as Error).cause).toBe(reason);
		expect(String(error)).not.toContain("Failed to write");
	});

	/**
	 * Nothing may be left behind. The commit stages into a temp file next to the
	 * target, and refusing after staging would litter the user's directory with
	 * temp files on every cancelled edit.
	 */
	it("leaves no temp file behind", async () => {
		const controller = new AbortController();
		controller.abort();

		await writethroughNoop(target, "replacement\n", controller.signal).catch(() => {});

		expect(await fsp.readdir(dir)).toEqual(["file.txt"]);
	});

	/**
	 * The twin that keeps the check from being a blanket refusal: a signal that
	 * exists but has not fired must write normally. Without this the suite would
	 * pass against an implementation that refused every write with a signal
	 * attached, which is every write the agent makes.
	 */
	it("writes normally when the signal has not fired", async () => {
		const controller = new AbortController();

		await writethroughNoop(target, "replacement content\n", controller.signal);

		expect(readFileSync(target, "utf-8")).toBe("replacement content\n");
	});

	/** A write with no signal at all is unaffected. */
	it("writes normally with no signal", async () => {
		await writethroughNoop(target, "no signal here\n", undefined);

		expect(readFileSync(target, "utf-8")).toBe("no signal here\n");
	});

	/**
	 * A brand-new file must not be created by a cancelled write either. Checking
	 * only the "file already existed" case would miss the write tool's create
	 * path entirely.
	 */
	it("does not create a file that did not exist", async () => {
		const fresh = path.join(dir, "new-file.txt");
		const controller = new AbortController();
		controller.abort();

		await writethroughNoop(fresh, "should never exist\n", controller.signal).catch(() => {});

		expect(await fsp.exists(fresh)).toBe(false);
	});

	/**
	 * The file's mode survives a normal write. The commit replaces the file by
	 * rename, and a replacement that took the temp file's private default would
	 * silently strip a script's executable bit. This is not about aborting, but
	 * it shares the one commit path and must not regress alongside it.
	 */
	it("preserves the file mode on a write that goes through", async () => {
		await fsp.chmod(target, 0o755);

		await writethroughNoop(target, "still executable\n", new AbortController().signal);

		const stat = await fsp.stat(target);
		expect(stat.mode & 0o777).toBe(0o755);
	});
});
