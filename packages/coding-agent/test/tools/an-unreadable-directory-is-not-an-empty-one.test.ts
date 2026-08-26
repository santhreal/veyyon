/**
 * WHY: reading a directory the process cannot open printed `(empty directory)`.
 * Both listing builders caught the native scan's error and returned an empty
 * tree, whose `totalLines` of 0 is the same value a genuinely empty directory
 * produces, so the read tool could not tell them apart and neither could the
 * caller. A model told a directory is empty stops looking; a model told
 * `EACCES` asks for the path to be fixed.
 *
 * THE CLASS this closes: a listing path substituting an empty result for a
 * failed scan. Both builders are swept, and the concise root path is included
 * because it is reached only when the requested directory IS the working
 * directory root, which is exactly where the report came from.
 *
 * WHAT IT DOES NOT CATCH: a scan that succeeds and returns fewer entries than
 * the directory holds — a partial read is still indistinguishable from a small
 * directory here. It also cannot run as root, where `chmod 000` is not
 * enforced, so the suite skips rather than passing vacuously.
 *
 * The fixture is built under the test's own temp root and every assertion is on
 * an errno, never on a path, so nothing about the machine that ran it is
 * recorded.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildDirectoryTree, buildTopLevelDirectoryListing } from "../../src/workspace-tree";

/** `chmod 000` does not stop root, so the sweep would pass for the wrong reason. */
const CANNOT_ENFORCE_PERMISSIONS = process.getuid?.() === 0 || process.platform === "win32";

const BUILDERS: Array<[string, (dir: string) => Promise<{ totalLines: number }>]> = [
	["buildDirectoryTree", dir => buildDirectoryTree(dir, { maxDepth: 2 })],
	["buildTopLevelDirectoryListing", dir => buildTopLevelDirectoryListing(dir)],
];

describe("a directory that cannot be scanned reports why", () => {
	let root = "";

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "veyyon-unreadable-"));
	});

	afterEach(async () => {
		// Restore the mode first, or the cleanup cannot descend into it either.
		await chmod(path.join(root, "locked"), 0o700).catch(() => {});
		await rm(root, { recursive: true, force: true });
	});

	it.each(BUILDERS)("%s throws instead of reporting an empty tree", async (_name, build) => {
		if (CANNOT_ENFORCE_PERMISSIONS) return;
		const locked = path.join(root, "locked");
		await mkdir(locked);
		await writeFile(path.join(locked, "secret.txt"), "content\n");
		await chmod(locked, 0o000);

		expect(build(locked)).rejects.toThrow();
	});

	/**
	 * NON-VACUITY. A builder that threw on every input would satisfy the sweep
	 * above and break every listing, so a readable directory still returns its
	 * entries, and an empty one still reports itself empty by the same measure
	 * the read tool uses.
	 */
	it.each(BUILDERS)("%s still lists a readable directory", async (_name, build) => {
		await mkdir(path.join(root, "child"));
		await writeFile(path.join(root, "child", "file.txt"), "content\n");

		expect((await build(root)).totalLines).toBeGreaterThan(1);
	});

	it.each(BUILDERS)("%s still reports a genuinely empty directory as empty", async (_name, build) => {
		const empty = path.join(root, "empty");
		await mkdir(empty);

		expect((await build(empty)).totalLines).toBeLessThanOrEqual(1);
	});
});
