/**
 * `TempDir` puts a temporary directory in the temporary directory.
 *
 * WHY THIS SUITE EXISTS. `mkdtemp` resolves a relative path against
 * `process.cwd()`, so `TempDir.createSync("secret-runtime-lifecycle-")` created
 * its scratch directory INSIDE THE REPOSITORY. Nothing said so, and a suite that
 * crashed before its cleanup ran left the directory behind, so they accumulated:
 * forty-six untracked temp directories across the tree when this was found,
 * thirty-six of them from a single suite, with sixteen call sites written the same
 * way.
 *
 * The escape hatch was a leading `@`, which is the wrong way round for a trap.
 * The SAFE spelling looked like a typo and the DANGEROUS one looked like an
 * ordinary name, so every test written without reading `normalizePrefix` got the
 * bad one. A bare name now means the system temp directory, which is what all
 * sixteen of those call sites meant.
 *
 * These tests assert real paths rather than that a directory exists, because the
 * bug produced a perfectly good directory in exactly the wrong place: an existence
 * check passed throughout.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils/temp";

/** `true` when `child` is `parent` or sits underneath it. */
function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

describe("TempDir places its directory", () => {
	/**
	 * THE BUG, by name. This exact call shape is what the sixteen call sites wrote,
	 * and it used to land in `process.cwd()`.
	 */
	it("in the system temp directory for a bare name", () => {
		using dir = TempDir.createSync("veyyon-temp-placement-bare-");
		const created = dir.path();

		expect(isInside(created, os.tmpdir())).toBe(true);
		expect(isInside(created, process.cwd())).toBe(false);
		expect(path.basename(created).startsWith("veyyon-temp-placement-bare-")).toBe(true);
		expect(fs.statSync(created).isDirectory()).toBe(true);
	});

	/**
	 * The same for the async constructor, since the two share `normalizePrefix` and a
	 * fix applied to one of them would be exactly the kind of half-fix this file is
	 * meant to catch.
	 */
	it("in the system temp directory for a bare name, asynchronously too", async () => {
		const dir = await TempDir.create("veyyon-temp-placement-async-");
		try {
			expect(isInside(dir.path(), os.tmpdir())).toBe(true);
			expect(isInside(dir.path(), process.cwd())).toBe(false);
		} finally {
			await dir.remove();
		}
	});

	/**
	 * The `@` spelling still works. It is written at fifty-odd call sites and all of
	 * them are correct, so it stays supported; it is redundant now rather than
	 * load-bearing, and the sigil is stripped from the directory's name.
	 */
	it("in the same place for the older @ spelling, without the sigil in the name", () => {
		using dir = TempDir.createSync("@veyyon-temp-placement-sigil-");

		expect(isInside(dir.path(), os.tmpdir())).toBe(true);
		expect(path.basename(dir.path()).startsWith("veyyon-temp-placement-sigil-")).toBe(true);
		expect(dir.path()).not.toContain("@");
	});

	/**
	 * And an ABSOLUTE prefix is still honoured exactly as given, because that is a
	 * caller saying where rather than naming what. Without this the fix would read as
	 * "always use the temp dir", which would silently move a caller that had chosen a
	 * location on purpose.
	 */
	it("exactly where an absolute prefix says", () => {
		using outer = TempDir.createSync("veyyon-temp-placement-outer-");
		const explicit = path.join(outer.path(), "chosen-");
		using dir = TempDir.createSync(explicit);

		expect(isInside(dir.path(), outer.path())).toBe(true);
		expect(path.basename(dir.path()).startsWith("chosen-")).toBe(true);
	});

	/**
	 * The default, with no prefix at all. Pinned so the no-argument path cannot drift
	 * apart from the named one: they are two branches of the same function and only
	 * one of them was ever wrong.
	 */
	it("in the system temp directory with no prefix at all", () => {
		using dir = TempDir.createSync();

		expect(isInside(dir.path(), os.tmpdir())).toBe(true);
		expect(path.basename(dir.path()).startsWith("pi-temp-")).toBe(true);
	});

	/**
	 * Two directories from the same prefix are two directories. `mkdtemp` guarantees
	 * it, but the fix rewrites the string it is handed, and a rewrite that dropped the
	 * randomising suffix would collide on the second call.
	 */
	it("in a different directory each time for the same prefix", () => {
		using first = TempDir.createSync("veyyon-temp-placement-unique-");
		using second = TempDir.createSync("veyyon-temp-placement-unique-");

		expect(first.path()).not.toBe(second.path());
	});

	/**
	 * Cleanup really removes it. The leak that motivated this file was a crash before
	 * cleanup, not a broken cleanup, but a suite about temp directories that never
	 * checked they go away would be missing the half that matters most.
	 */
	it("and removes it on dispose", () => {
		let created = "";
		{
			using dir = TempDir.createSync("veyyon-temp-placement-dispose-");
			created = dir.path();

			expect(fs.existsSync(created)).toBe(true);
		}

		expect(fs.existsSync(created)).toBe(false);
	});
});
