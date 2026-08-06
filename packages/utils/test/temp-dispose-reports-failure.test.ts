/**
 * `TempDir`'s `using`/`await using` disposal must never throw, and must never be
 * silent about a removal it could not do.
 *
 * Disposal runs as a scope exits, frequently while an error is already on its way
 * out, so throwing there would replace the caller's error with one about cleanup.
 * That part was always right. What was wrong is that both dispose methods caught
 * with an empty block, so a directory that could not be removed was left in the
 * system temp directory with nothing anywhere recording it. The only symptom is a
 * disk that fills with directories nobody can account for, which is exactly what
 * happened: a developer machine reached 3,265 abandoned `veyyon-*` directories and
 * 34GB in `/tmp` before anyone noticed, and no log line named a single one of them.
 *
 * These tests pin both halves of the contract, for both the sync and async paths:
 * dispose does not throw, AND dispose reports the path and the reason (Law 10, no
 * silent fallback). The removal is made to fail by taking write permission away
 * from the PARENT directory, which is what a real permission-test leftover looks
 * like and what `rm` actually refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// The spy goes through the package barrel, which is where every other suite in this
// package patches the logger. Spying on `../src/logger` directly does NOT work here:
// `temp.ts` is reached through the barrel too, and the two namespace objects are not
// the same one, so a spy on the inner module patches nothing and every assertion in
// this file passes vacuously.
import { logger, TempDir } from "@veyyon/utils";

/** A parent whose permissions this test controls, so removal of the child fails for real. */
let parent: string;

/**
 * Warnings captured for the duration of a case.
 *
 * The capture pushes into this array rather than reading `spy.mock.calls` later, because
 * `mockRestore()` discards the recorded calls: reading them after restoring yields
 * `undefined` and the assertion fails for a reason that has nothing to do with the code
 * under test. This is the same shape the rest of this package uses.
 */
let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

beforeEach(() => {
	parent = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-dispose-parent-"));
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	// Restore write permission before removing, or this suite becomes the leak it tests for.
	fs.chmodSync(parent, 0o700);
	fs.rmSync(parent, { recursive: true, force: true });
});

/** Make a TempDir under the controlled parent, then take write permission away. */
function unremovableChild(): TempDir {
	const dir = TempDir.createSync(path.join(parent, "veyyon-dispose-child-"));
	fs.writeFileSync(path.join(dir.path(), "occupant.txt"), "held");
	fs.chmodSync(parent, 0o500);
	return dir;
}

// Running as root ignores the permission bits, so the removal would succeed and the
// test would assert nothing. Refuse loudly rather than passing vacuously.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("TempDir disposal when the removal cannot be done", () => {
	it("reports the path and the reason it could not remove it", () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const dir = unremovableChild();

		dir[Symbol.dispose]();

		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe("temp directory could not be removed on dispose; it is left behind");
		expect(warnings[0]?.fields.path).toBe(dir.path());
		// The reason has to be in the line too: "could not remove it" without a cause
		// sends the reader looking for a bug instead of at their own directory permissions.
		expect(String(warnings[0]?.fields.error)).toMatch(/EACCES|EPERM|permission denied/i);
	});

	it("says the directory is left behind, because it is", () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const dir = unremovableChild();

		dir[Symbol.dispose]();

		// The claim in the log line is checked against the filesystem, so the wording
		// cannot drift into saying something the code does not do.
		expect(fs.existsSync(dir.path())).toBe(true);
	});

	it("does not throw out of an `await using` scope either", async () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const dir = unremovableChild();

		await expect(dir[Symbol.asyncDispose]()).resolves.toBeUndefined();
	});

	it("reports on the async path with the same message and fields", async () => {
		if (asRoot) throw new Error("run this suite as a non-root user: root ignores the permission bits it relies on");
		const dir = unremovableChild();

		await dir[Symbol.asyncDispose]();

		// One message for both paths: an operator grepping their log for the leak must
		// not have to know whether the code that made the directory was async.
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe("temp directory could not be removed on dispose; it is left behind");
		expect(warnings[0]?.fields.path).toBe(dir.path());
	});
});

describe("TempDir disposal when the removal succeeds", () => {
	it("removes the directory and says nothing", () => {
		// The negative twin: the report exists for the failure, and a warning on every
		// ordinary scope exit would train operators to ignore the one that matters.
		const dir = TempDir.createSync(path.join(parent, "veyyon-dispose-ok-"));
		const madeAt = dir.path();

		dir[Symbol.dispose]();

		expect(fs.existsSync(madeAt)).toBe(false);
		expect(warnings).toEqual([]);
	});

	it("is idempotent, so a second dispose is not reported as a failure", () => {
		// `remove()` memoizes, and a `using` inside a function that also calls
		// `removeSync()` explicitly disposes twice. That must stay quiet.
		const dir = TempDir.createSync(path.join(parent, "veyyon-dispose-twice-"));
		dir.removeSync();

		dir[Symbol.dispose]();

		expect(warnings).toEqual([]);
	});
});
