/**
 * Nothing in this repository writes to a path spelled from an unset variable.
 *
 * WHY THIS SUITE EXISTS. A directory literally named `undefined` appeared at the repository root
 * on 2026-07-25 holding a rendered copy of the root changelog. `undefined` is exactly what
 * `path.join(dir, name)` produces when `dir` is unset, so something built an output path out of a
 * variable nobody had assigned and WROTE THERE instead of failing. Nothing in the tree references
 * that filename, and no script here builds an output path from a value that can be undefined, so
 * the writer was a one-off run rather than shipped code, and it left no other trace.
 *
 * That is the part worth guarding. The failure is silent by construction: the write succeeds, the
 * script reports success, and the only evidence is a directory whose name looks like a typo. By the
 * time anyone notices, the run that produced it is long gone and its arguments are unrecoverable.
 * These assertions fire while the evidence is still fresh: the file's mtime still names the hour,
 * and whoever's tree it is still remembers what they ran.
 *
 * A stray directory is untracked, so a clean checkout and CI are green; this fails only in the tree
 * that produced one, which is the tree that can identify it. Do not satisfy it by deleting the
 * directory unread: read what is in it and find the writer first, because the contents are the only
 * clue to which run wrote them.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

describe("no path is spelled from an unset variable", () => {
	/**
	 * The literal strings JavaScript stringifies a missing value into. `path.join` throws on a
	 * genuine `undefined` argument, so these only ever appear when the value was interpolated into
	 * a template or concatenated, which is the common shape in a quick script.
	 */
	const UNSET_NAMES = ["undefined", "null", "NaN", "[object Object]"];

	it("has no repository-root entry named for a missing value", () => {
		const entries = readdirSync(repoRoot);
		const stray = entries.filter(entry => UNSET_NAMES.includes(entry));

		expect(
			stray,
			`The repository root holds ${stray.join(", ")}, which is what an output path built from an unset ` +
				"variable looks like. Find the writer before removing it: read the files inside and check their " +
				"mtime against your shell history. Whatever wrote them must fail closed on an unset output " +
				"directory rather than writing to a path spelled from the missing value.",
		).toEqual([]);
	});

	it("tracks no file under a path segment named for a missing value", () => {
		// The permanent half. The check above is about a live working tree; this one is about
		// history, and it stays meaningful in CI: a stray output directory that once got committed
		// is invisible to `readdirSync` on a machine that never wrote one.
		const listed = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
		const files = new TextDecoder().decode(listed.stdout).trim().split("\n").filter(Boolean);
		const stray = files.filter(file => file.split("/").some(segment => UNSET_NAMES.includes(segment)));

		expect(stray, `tracked paths spelled from a missing value: ${stray.join(", ")}`).toEqual([]);
	});

	it("finds the tracked file list at all, so the check is not vacuous", () => {
		// Same guard-on-the-guard as above: an empty `git ls-files` would make the assertion pass
		// for the wrong reason.
		const listed = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot });
		const files = new TextDecoder().decode(listed.stdout).trim().split("\n").filter(Boolean);

		expect(files.length).toBeGreaterThan(500);
	});
});
