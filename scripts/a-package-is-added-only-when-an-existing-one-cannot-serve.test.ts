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
 * The ceiling, which is the count this branch leaves behind rather than a round
 * number. Raising it is the decision this file exists to make deliberate, so
 * raise it in the same commit that adds the package, and say in the message which
 * existing package was considered and why it could not serve.
 *
 * It went 19 -> 15 here: `deepswe-bench`, `metaharness`, `simulations` and
 * `typescript-edit-benchmark` became subtrees of one `packages/bench`, and
 * `tool-render` became `packages/collab-web/src/tool-render/lib`.
 */
const PACKAGE_CEILING = 15;

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
	 * Asserted as equality rather than as an upper bound, in both directions. A
	 * ceiling above the real count is headroom nobody decided to grant, which is
	 * the same as no ceiling until the slack is used up; so removing a package
	 * lowers the number here in the same commit, and adding one raises it.
	 */
	it("is exactly the recorded budget", () => {
		expect(
			packages,
			`the workspace holds ${packages.length} packages, budget ${PACKAGE_CEILING}. ` +
				"Higher: put the code in the package that already owns the concern, or raise the number in " +
				"this file in the same commit and say which existing package was considered and why it " +
				"could not serve. Lower: a package was removed, so lower the number and keep the budget tight.",
		).toHaveLength(PACKAGE_CEILING);
	});

	it.each(MERGED_AWAY)("does not bring %s back as a package of its own", name => {
		expect(packages).not.toContain(name);
	});
});
