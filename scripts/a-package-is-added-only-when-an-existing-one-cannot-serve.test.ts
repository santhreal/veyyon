/**
 * The workspace does not grow a package because splitting felt tidier.
 *
 * WHY THIS SUITE EXISTS. A package is the most expensive unit in this repository
 * and the cheapest one to create. Each one costs a manifest, a tsconfig, a
 * `bunfig.toml` pointing at the shared tripwire, a changelog the release gate
 * checks, a test-bucket entry, a row in two markdown package tables, an entry in
 * the root catalog, and a name in every hand-written module-reach table that
 * resolves cross-package imports. None of that is visible from `mkdir`, and none
 * of it fails loudly when it is skipped: an unlisted package's tests run nowhere
 * and report green, and a package unknown to a module-reach table lowers every
 * ceiling that walks through it.
 *
 * Four private benchmark packages had each of those costs paid four times over
 * for one purpose — measuring this product — and one publishable package,
 * `@veyyon/tool-render`, existed for two consumers that were both `collab-web`.
 * Five packages became `packages/bench` and `packages/collab-web/src/tool-render`.
 *
 * WHAT THIS DOES NOT ASSERT. Which packages exist, and whether the tables
 * describe them: `scripts/package-map-coverage.test.ts` owns both directions of
 * that, and duplicating its list here would be a second copy to drift. This is a
 * budget, and it only ever answers one question: did the count go up.
 *
 * WHAT IT DOES NOT CATCH. A directory under an existing package that is a
 * package in everything but the manifest, and a package that gets bigger rather
 * than more numerous. Size is `module-size-gates.test.ts`'s job.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES_DIR = path.join(REPO_ROOT, "packages");

/**
 * The budget. Raising it is the decision this file exists to make deliberate, so
 * raise it in the same commit that adds the package, and say in the message which
 * existing package was considered and why it could not serve.
 *
 * The count went 19 -> 15 on this branch: `deepswe-bench`, `metaharness`,
 * `simulations` and `typescript-edit-benchmark` became subtrees of one
 * `packages/bench`, and `tool-render` became
 * `packages/collab-web/src/tool-render/lib`.
 *
 * The budget is 16 rather than 15 because `packages/render-oracle` landed on
 * `main` after this branch left it and arrives with the merge. That is the whole
 * of the slack and it is spoken for; `SPOKEN_FOR` below keeps it from being spent
 * on anything else.
 */
const PACKAGE_BUDGET = 16;

/**
 * Packages the budget accounts for that this checkout may not have yet. Named, so
 * the one unspent slot is a statement about a specific package rather than
 * headroom a later reader reads as room to grow.
 */
const SPOKEN_FOR = ["render-oracle"];

/** A directory under `packages/` that carries a manifest, which is what makes it a package. */
function workspacePackages(): string[] {
	return fs
		.readdirSync(PACKAGES_DIR, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.filter(name => fs.existsSync(path.join(PACKAGES_DIR, name, "package.json")))
		.sort();
}

/**
 * Names that were packages and are now directories inside one. Listed because a
 * count alone cannot see a merge being undone one package at a time: dropping
 * `bench` and restoring `metaharness` keeps the count flat.
 */
const MERGED_AWAY = ["deepswe-bench", "metaharness", "simulations", "tool-render", "typescript-edit-benchmark"];

describe("the workspace package count", () => {
	const packages = workspacePackages();

	it("reads a real packages directory", () => {
		// Non-vacuity: an empty read would satisfy every bound below. `packages/`
		// also holds `tsconfig.workspace.json`, which is shared config and not a
		// package, so the filter above has to be doing something.
		expect(packages.length).toBeGreaterThan(10);
		expect(packages).toContain("coding-agent");
		expect(packages).not.toContain("tsconfig.workspace.json");
	});

	/**
	 * A bound, and a floor under it. A bound alone with slack in it is no bound at
	 * all until the slack is used up, so the floor states how much of the budget is
	 * spent and fails when a package is removed without the number coming down with
	 * it.
	 */
	it("stays within the recorded budget", () => {
		expect(
			packages.length,
			`the workspace holds ${packages.length} packages, budget ${PACKAGE_BUDGET}. ` +
				"Put the code in the package that already owns the concern, or raise the number in this " +
				"file in the same commit and say which existing package was considered and why it could " +
				"not serve.",
		).toBeLessThanOrEqual(PACKAGE_BUDGET);
	});

	it("has no unspent slack beyond the packages the budget names", () => {
		const absent = SPOKEN_FOR.filter(name => !packages.includes(name));

		expect(
			packages.length + absent.length,
			`${PACKAGE_BUDGET - packages.length - absent.length} slot(s) of the budget are unaccounted for. ` +
				"A package was removed: lower the number in this file, or name the package the slot is held for.",
		).toBe(PACKAGE_BUDGET);
	});

	it.each(MERGED_AWAY)("does not bring %s back as a package of its own", name => {
		expect(packages).not.toContain(name);
	});
});
