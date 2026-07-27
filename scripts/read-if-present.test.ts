/**
 * A doc walk must survive a file disappearing between listing and reading, and must NOT survive a file
 * it is merely not allowed to read.
 *
 * WHY THIS SUITE EXISTS. Every markdown walk in `scripts/` is two steps -- list the tracked files, then
 * read each one -- and the tree changes in between. `git ls-files` reports the index, so it includes a
 * doc deleted in the working tree; a parallel session moving prompt files, a rebase, or a generator run
 * removes one after the listing. That killed `install-methods-coverage.test.ts` twice with a raw ENOENT
 * naming `auto-handoff-threshold-focus.md`, a file that has nothing to do with install instructions, and
 * a failure like that is indistinguishable from a real finding until someone reads the stack.
 *
 * The tempting fix is a catch-all around the read, and that is the failure this suite exists to prevent:
 * swallowing every IO error lets a permissions problem shrink the scan silently, so the gate reports a
 * clean pass over files nobody read. `readIfPresent` therefore tolerates exactly ENOENT and rethrows
 * everything else, and both halves are asserted here -- the second half is the one a future
 * "simplification" would delete.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readIfPresent } from "./check-doc-links";

const created: string[] = [];

/** A real directory on disk, since the behaviour under test is what the filesystem reports. */
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-read-if-present-"));
	created.push(dir);
	return dir;
}

/** Mode bits do not restrict root, and Windows does not honour them. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

afterEach(() => {
	for (const dir of created.splice(0)) {
		fs.chmodSync(dir, 0o700);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("a file that is there", () => {
	/** The ordinary case: the contents come back untouched, including trailing whitespace. */
	it("returns its exact contents", () => {
		const dir = tempDir();
		const file = path.join(dir, "guide.md");
		fs.writeFileSync(file, "# Title\n\nbody text\n");

		expect(readIfPresent(file)).toBe("# Title\n\nbody text\n");
	});

	/** An empty file is not a missing file, and `undefined` would make the caller skip a real document. */
	it("returns an empty string for an empty file, not undefined", () => {
		const dir = tempDir();
		const file = path.join(dir, "empty.md");
		fs.writeFileSync(file, "");

		expect(readIfPresent(file)).toBe("");
	});
});

describe("a file that has been deleted since it was listed", () => {
	/** The regression, in the exact order it happens: listed, then gone, then read. */
	it("returns undefined instead of throwing", () => {
		const dir = tempDir();
		const file = path.join(dir, "moved-away.md");
		fs.writeFileSync(file, "# Was here");
		const listed = [file];
		fs.rmSync(file);

		expect(readIfPresent(listed[0] as string)).toBeUndefined();
	});

	/** A path whose parent directory is gone reports ENOENT too, which is the same answer. */
	it("returns undefined when the whole directory is gone", () => {
		const dir = tempDir();
		const file = path.join(dir, "nested", "doc.md");

		expect(readIfPresent(file)).toBeUndefined();
	});
});

describe("a file that cannot be read for any other reason", () => {
	/**
	 * The half that keeps this from being a silent fallback. A doc the walker is not allowed to open is a
	 * real problem: swallowing it would drop the file from the scan and report a pass over a document
	 * nobody checked. This must throw, and it must throw the original error so the message names the cause.
	 */
	it("throws EACCES rather than skipping the file", () => {
		if (!canRestrictAccess()) return;
		const dir = tempDir();
		const file = path.join(dir, "secret.md");
		fs.writeFileSync(file, "# Restricted");
		fs.chmodSync(file, 0o000);

		expect(() => readIfPresent(file)).toThrow(/EACCES/);
	});

	/**
	 * A directory where a file was expected is a listing bug, not a deleted file, and it must not be
	 * silently skipped either -- EISDIR names the actual mistake.
	 */
	it("throws when the path is a directory", () => {
		const dir = tempDir();
		fs.mkdirSync(path.join(dir, "not-a-file.md"));

		expect(() => readIfPresent(path.join(dir, "not-a-file.md"))).toThrow(/EISDIR/);
	});
});
