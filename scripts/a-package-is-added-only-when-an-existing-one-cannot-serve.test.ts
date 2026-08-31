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
import { typeScriptMembers } from "./workspace-layout";

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
 *
 * The count went 18 -> 19 with no package added. `python/veybot/web` is declared as a literal path
 * three levels down, so the root sweep this gate used to run could not see it and had been counting
 * 18 members while the workspace held 19. The member list reaches it, and the budget now states the
 * real number. A future rise still needs the sentence above: which existing package was considered
 * and why it could not serve.
 *
 * The count went 19 -> 20 with `kernel`. It is the plugin loader, the contribution registry and the
 * session spine, and it names no tool and no host, which is the property every other member fails:
 * `coding-agent` is the CLI and owns every tool, `contracts/*` may hold no runtime at all, and
 * `utils` is imported by the plugins the loader has to stay above, so a registry there would be a
 * cycle. A future rise still needs the sentence above: which existing package was considered and
 * why it could not serve.
 */
const PACKAGE_BUDGET = 20;

/**
 * Every workspace member, as `<root>/<name>`.
 *
 * The members are read from the root `package.json` rather than swept across roots: this gate counted
 * `packages/` alone, so moving `wire` under `contracts/` read as a package being deleted and adding
 * `view` beside it counted for nothing at all. The root view was in turn blind to literal paths
 * (`natives/bridge/bindings`, `python/veybot/web`), which `typeScriptMembers()` now reaches.
 */
function workspacePackages(): string[] {
	return typeScriptMembers();
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
		// The two members declared as literal paths rather than matched by a root glob. A sweep that
		// missed them counted a smaller workspace than the one that ships, which is how the budget
		// read 18 for a tree of 19.
		expect(packages).toContain("natives/bridge/bindings");
		expect(packages).toContain("python/veybot/web");
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
