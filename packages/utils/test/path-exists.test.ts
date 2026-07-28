import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathExists } from "../src/fs-optional";

/**
 * `pathExists`: the async answer to "is it there", and the one that does not hide a fault.
 *
 * WHY THIS SUITE EXISTS. It replaces `fs.existsSync` at call sites inside `async` functions,
 * of which the coding agent had forty-three. Two separate defects live in those sites.
 *
 * The first is the event loop. `existsSync` stops it for the length of a stat, and the probes
 * are usually SEQUENTIAL: the LSP project detector checks up to six marker files in a row
 * before doing any work, and `plugin doctor` checks four paths per installed plugin. On a
 * cold or network filesystem the TUI cannot paint a frame for the whole run.
 *
 * The second is what `existsSync` cannot say. It answers `false` for a path that exists and
 * cannot be stat'd, so a permissions problem, a bad mount or a dangling symlink is
 * indistinguishable from absence and the caller proceeds as though the file were simply not
 * there. For `plugin doctor` that is the exact failure the command exists to find, reported
 * as "not found" and sending the operator after a file that is right in front of them.
 *
 * These cases are driven against a real filesystem rather than a mocked one, because the
 * behaviour under test IS the operating system's: what `stat` does with a symlink, with a
 * directory the process cannot traverse, with a path whose parent is a file.
 */

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-path-exists-"));
});

afterEach(async () => {
	// Restore any mode the tests removed, or the cleanup itself cannot descend.
	await fs.chmod(path.join(root, "sealed"), 0o755).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

describe("pathExists", () => {
	/** A file that is there. The base case, and the one every caller depends on. */
	it("reports a file that exists", async () => {
		const file = path.join(root, "present.txt");
		await Bun.write(file, "x");
		expect(await pathExists(file, "a test file")).toBe(true);
	});

	/** An empty file still exists. `stat` says so; a size check would not. */
	it("reports an empty file as present", async () => {
		const file = path.join(root, "empty.txt");
		await Bun.write(file, "");
		expect(await pathExists(file, "an empty file")).toBe(true);
	});

	/** A directory is a path that exists, which is what the marker-file probes rely on. */
	it("reports a directory as present", async () => {
		const dir = path.join(root, "dir");
		await fs.mkdir(dir);
		expect(await pathExists(dir, "a directory")).toBe(true);
	});

	/** Absence is an answer, not a fault: this is the ordinary state of every optional path. */
	it("reports a missing path as absent", async () => {
		expect(await pathExists(path.join(root, "nope.txt"), "a missing file")).toBe(false);
	});

	/**
	 * A missing path whose PARENT is also missing, which is the shape a marker probe hits on
	 * a `cwd` that does not exist. ENOENT either way, and no throw.
	 */
	it("reports a path under a missing directory as absent", async () => {
		expect(await pathExists(path.join(root, "gone", "deeper", "file.txt"), "a nested miss")).toBe(false);
	});

	/**
	 * A path whose parent is a FILE rather than a directory. The error is ENOTDIR, not
	 * ENOENT, and the answer is still "not there" rather than a thrown exception: a caller
	 * probing for `Cargo.toml` under something that is not a directory wants `false`.
	 */
	it("does not throw when a path segment is a file", async () => {
		const file = path.join(root, "afile");
		await Bun.write(file, "x");
		expect(await pathExists(path.join(file, "under-a-file.txt"), "a path through a file")).toBe(false);
	});

	/**
	 * A symlink to a real file follows through, matching `existsSync`. The conversion must not
	 * change this: a plugin installed by a package manager is often a symlink into a store,
	 * and reporting it absent would make `plugin doctor` call every such install broken.
	 */
	it("follows a symlink to a file that exists", async () => {
		const target = path.join(root, "target.txt");
		await Bun.write(target, "x");
		const link = path.join(root, "link.txt");
		await fs.symlink(target, link);
		expect(await pathExists(link, "a symlinked file")).toBe(true);
	});

	/**
	 * A DANGLING symlink is absent, again matching `existsSync`, because `stat` follows the
	 * link and finds nothing. The link itself is a real directory entry, so a check written
	 * with `lstat` would answer the opposite, and that difference is the reason this is
	 * pinned rather than assumed.
	 */
	it("reports a dangling symlink as absent", async () => {
		const link = path.join(root, "dangling.txt");
		await fs.symlink(path.join(root, "never-existed.txt"), link);
		expect(await pathExists(link, "a dangling symlink")).toBe(false);
	});

	/**
	 * The empty string is not a path. It must answer `false` rather than throwing, since a
	 * caller joining an unset config value can produce one.
	 */
	it("reports the empty path as absent", async () => {
		expect(await pathExists("", "an empty path")).toBe(false);
	});

	/**
	 * The case `existsSync` cannot express, and the reason this helper logs.
	 *
	 * A file inside a directory with no execute bit cannot be stat'd: the error is EACCES,
	 * not ENOENT. `existsSync` collapses that to `false`, so the caller reads a permissions
	 * problem as absence. `pathExists` answers `false` too, because the caller still has
	 * nothing to work with, but `statIfPresent` has logged the path and the reason first, so
	 * the operator has something to find.
	 *
	 * Skipped for root, which traverses regardless of the mode bits and would make the
	 * assertion meaningless rather than failing honestly.
	 */
	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"reports an unreadable path as absent rather than throwing",
		async () => {
			const sealed = path.join(root, "sealed");
			await fs.mkdir(sealed);
			const hidden = path.join(sealed, "inside.txt");
			await Bun.write(hidden, "x");
			await fs.chmod(sealed, 0o000);

			expect(await pathExists(hidden, "a file behind a sealed directory")).toBe(false);
			// And the directory itself is still stat-able, so absence here is about the child.
			expect(await pathExists(sealed, "the sealed directory")).toBe(true);
		},
	);

	/**
	 * Non-vacuity for the pair above: without restoring the mode the suite would report
	 * `false` for both paths and look like it had proven something. Once the bit is back the
	 * file is present again, which shows the earlier `false` came from the permission and
	 * not from the file being missing all along.
	 */
	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"finds the same file once the directory is traversable again",
		async () => {
			const sealed = path.join(root, "sealed");
			await fs.mkdir(sealed);
			const hidden = path.join(sealed, "inside.txt");
			await Bun.write(hidden, "x");

			await fs.chmod(sealed, 0o000);
			expect(await pathExists(hidden, "a file behind a sealed directory")).toBe(false);

			await fs.chmod(sealed, 0o755);
			expect(await pathExists(hidden, "a file behind an open directory")).toBe(true);
		},
	);
});
