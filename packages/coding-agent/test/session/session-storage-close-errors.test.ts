/**
 * Regression: a session file that could not be closed cleanly must say so.
 *
 * `FileSessionStorageWriter.close()` wrapped `fs.closeSync` in a bare catch
 * commented "Ignore close errors", while `#recordError` sat a few lines above
 * routing every WRITE error to `getError()` and the `onError` callback.
 *
 * Ignoring a close is not the harmless tidy-up it looks like. On a network or
 * delayed-allocation filesystem, close is exactly where a deferred write error
 * surfaces, so the session transcript can be short by whatever never landed.
 * Swallowing it made a truncated transcript indistinguishable from a complete
 * one, which is the worst kind of silence: the data is gone and the only signal
 * that it is gone has been discarded (Law 10).
 *
 * Close still must not THROW, because it runs on shutdown and teardown paths
 * where throwing would mask the reason the session is ending. So the contract
 * is precise: report through every channel the writer already has, and resolve.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@veyyon/coding-agent/session/session-storage";
import { logger } from "@veyyon/utils";

describe("FileSessionStorageWriter close error reporting", () => {
	let dir: string;
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-session-close-"));
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** A writer over a real file, plus the errors its callback saw. */
	function writerIn(name: string) {
		const seen: Error[] = [];
		const storage = new FileSessionStorage();
		const writer = storage.openWriter(path.join(dir, name), { onError: (err: Error) => seen.push(err) });
		return { writer, seen };
	}

	it("writes and closes a healthy session file without reporting anything", async () => {
		// The premise of every test below. A warning on the working path is the
		// noise that trains people to ignore the real one.
		const { writer, seen } = writerIn("ok.jsonl");

		await writer.append('{"role":"user"}\n');
		await writer.close();

		expect(fs.readFileSync(path.join(dir, "ok.jsonl"), "utf8")).toBe('{"role":"user"}\n');
		expect(seen).toEqual([]);
		expect(warnings).toEqual([]);
		expect(writer.getError()).toBeUndefined();
	});

	it("reports a failing close through getError() instead of discarding it", async () => {
		// THE regression. The close is forced to fail by closing the descriptor out
		// from under the writer, which is what an EIO or ENOSPC looks like from
		// here: the fd is no longer closable and the last writes may not have
		// landed.
		const { writer } = writerIn("broken.jsonl");
		await writer.append("line\n");
		failNextClose();

		await writer.close();

		expect(writer.getError()).toBeInstanceOf(Error);
	});

	it("passes a failing close to the onError callback, like a write error", async () => {
		// The callback is how a caller learns about trouble without polling. A
		// close error belongs on it for the same reason a write error does.
		const { writer, seen } = writerIn("broken-cb.jsonl");
		await writer.append("line\n");
		failNextClose();

		await writer.close();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeInstanceOf(Error);
	});

	it("warns that the transcript may be missing its last writes, which is the actual consequence", async () => {
		// "close failed" means nothing to an operator. What they need to know is
		// that the file on disk may not be the whole session.
		const { writer } = writerIn("broken-warn.jsonl");
		await writer.append("line\n");
		failNextClose();

		await writer.close();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("the transcript may be missing its last writes");
		expect(String(warnings[0]?.fields.fix)).toContain("writable");
	});

	it("resolves rather than throwing, because close runs on shutdown paths", async () => {
		// Throwing here would mask whatever is actually ending the session, and
		// would turn a degraded save into a crash.
		const { writer } = writerIn("broken-noThrow.jsonl");
		await writer.append("line\n");
		failNextClose();

		await expect(writer.close()).resolves.toBeUndefined();
	});

	it("marks the writer closed even when the close failed", async () => {
		// A writer that reports open after a failed close would invite further
		// appends against a dead descriptor.
		const { writer } = writerIn("broken-state.jsonl");
		await writer.append("line\n");
		failNextClose();
		await writer.close();

		expect(writer.isOpen()).toBe(false);
		await expect(writer.append("more\n")).rejects.toThrow("Writer closed");
	});

	it("reports the close error only once across repeated close calls", async () => {
		// `close()` is idempotent and callers do call it twice (explicit close plus
		// a teardown path). Reporting per call would multiply one problem into a
		// stream of identical warnings.
		const { writer, seen } = writerIn("broken-twice.jsonl");
		await writer.append("line\n");
		failNextClose();

		await writer.close();
		await writer.close();

		expect(warnings).toHaveLength(1);
		expect(seen).toHaveLength(1);
	});

	it("keeps the first error when a write already failed, rather than overwriting it with the close", async () => {
		// The write error is the cause and the close error is a consequence of it.
		// `getError()` should still name the cause.
		const { writer } = writerIn("write-first.jsonl");
		failNextWrite();
		await expect(writer.append("line\n")).rejects.toThrow("ENOSPC");
		const first = writer.getError();
		failNextClose();

		await writer.close();

		expect(writer.getError()).toBe(first);
	});
});

/**
 * Make the writer's next `fs.closeSync` fail, once.
 *
 * This stands in for the real cases (EIO or ENOSPC surfacing at close on a
 * delayed-allocation or network filesystem), which cannot be provoked
 * portably. Only the first call fails and the descriptor is then really closed,
 * so the test leaks nothing and nothing else in the process is affected.
 */
function failNextWrite(): void {
	const spy = vi.spyOn(fs, "writeSync").mockImplementation(() => {
		spy.mockRestore();
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	});
}

function failNextClose(): void {
	const real = fs.closeSync;
	const spy = vi.spyOn(fs, "closeSync").mockImplementation((fd: number) => {
		spy.mockRestore();
		real(fd);
		throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
	});
}
