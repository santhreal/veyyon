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
 * Three private benchmark packages had each of those costs paid three times over
 * for one purpose — measuring this product — and became `packages/evals`.
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
import { REPO_ROOT, typeScriptRootDirectories } from "./workspace-layout";

/**
 * The budget. Raising it is the decision this file exists to make deliberate, so
 * raise it in the same commit that adds the package, and say in the message which
 * existing package was considered and why it could not serve.
 *
 * The count went 19 -> 17: `deepswe-bench`, `metaharness` and
 * `typescript-edit-benchmark` became suites, backends and a run store inside one
 * `packages/evals`, and `packages/simulations` stayed a package of its own
 * because it drives real sessions rather than scoring models.
 *
 * `tool-render` was folded into `collab-web` here and then restored, which is
 * the counter-example this budget is for. The fold was sound while both of its
 * consumers were `collab-web`; `@veyyon/stats` became a second consumer, and
 * `stats` is publishable while `collab-web` declares `"private": true`, so a
 * published package would have depended on one that resolves for nobody outside
 * this workspace. A shared publishable library with two unrelated consumers is
 * the case where an existing package cannot serve.
 *
 * The count went 17 -> 18 with `contracts/view`. `contracts/wire` is the same
 * package as `packages/wire` under a new root and spends no slot. `view` is a new
 * one: it declares what a tool's output means with no dependency at all, and no
 * existing package can hold that. `wire` is the closest and cannot, because a
 * host that only draws tool cards would take the whole collab protocol with it;
 * `tui` is the terminal, which is the coupling the type exists to remove; and
 * `utils` is a grab bag every package already imports, so a contract there would
 * be a contract nothing can depend on narrowly.
 */
const PACKAGE_BUDGET = 18;

/**
 * Every workspace member, as `<root>/<name>`.
 *
 * The roots are read from the root `package.json` rather than named here: this gate counted
 * `packages/` alone, so moving `wire` under `contracts/` read as a package being deleted and adding
 * `view` beside it counted for nothing at all. Members are qualified by root because two roots may
 * hold a directory of the same name, and a bare name would silently count one of them twice.
 */
function workspacePackages(): string[] {
	const members: string[] = [];
	for (const root of typeScriptRootDirectories()) {
		const rootDir = path.join(REPO_ROOT, root);
		if (!fs.existsSync(rootDir)) continue;
		for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (!fs.existsSync(path.join(rootDir, entry.name, "package.json"))) continue;
			members.push(`${root}/${entry.name}`);
		}
	}
	return members.sort();
}

/**
 * Members that were packages and are now directories inside one. Listed because a count alone cannot
 * see a merge being undone one package at a time: dropping `bench` and restoring `metaharness` keeps
 * the count flat. Each is qualified by its root, the form {@link workspacePackages} returns.
 */
const MERGED_AWAY = [
	"packages/bench",
	"packages/deepswe-bench",
	"packages/metaharness",
	"packages/typescript-edit-benchmark",
];

describe("the workspace package count", () => {
	const packages = workspacePackages();

	it("reads every real workspace root", () => {
		// Non-vacuity: an empty read would satisfy every bound below. `packages/`
		// also holds `tsconfig.workspace.json`, which is shared config and not a
		// package, so the filter above has to be doing something. Both roots are
		// named, because a sweep that found one of them would pass the bounds too.
		expect(packages.length).toBeGreaterThan(10);
		expect(packages).toContain("packages/coding-agent");
		expect(packages).toContain("contracts/wire");
		expect(packages).not.toContain("packages/tsconfig.workspace.json");
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

	it("has no unspent slack", () => {
		// The budget carries no headroom on purpose. A named held slot was tried here
		// and it exempted a package that turned out not to exist on `main` at all,
		// which is a ledger row that guards nothing — the same defect the source-lock
		// ledger had. A slot is added when the package is.
		expect(
			packages.length,
			`${PACKAGE_BUDGET - packages.length} slot(s) of the budget are unaccounted for. ` +
				"A package was removed: lower the number in this file in the same commit.",
		).toBe(PACKAGE_BUDGET);
	});

	it.each(MERGED_AWAY)("does not bring %s back as a package of its own", name => {
		expect(packages).not.toContain(name);
	});
});
