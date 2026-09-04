/**
 * Every package that has tests must load the real-data tripwire.
 *
 * The tripwire is a bunfig `preload` rather than a helper for one reason: the
 * protection must not be opt-in, because the incident it exists for happened in
 * a suite that never called the helper. But Bun reads `bunfig.toml` from the
 * current working directory ONLY and offers no way to inherit a parent config,
 * so the root config protects a root-level `bun test` and nothing else. Each
 * package carries its own pointer to the same file, and a package that forgets
 * one runs its whole suite unguarded the moment anyone does `cd packages/x &&
 * bun test` — which is how most suites are actually run while working.
 *
 * Three packages had forgotten: the two benchmark packages now folded into `evals`,
 * and `swarm-extension`, twenty test files between them with no guard at all. Every
 * existing pointer is identical, so nothing about this is hard; it is just
 * invisible, which is exactly what a test is for. `real-data-tripwire.test.ts`
 * proves the tripwire WORKS where it is loaded; this proves it is loaded
 * everywhere it needs to be.
 *
 * The traversal comes from `./support/package-sources`, the one owner of "what a
 * package file is", rather than being hand-rolled here. A private walk with its
 * own skip-set is how the ownership locks drifted apart in the first place, and
 * `package-sources.test.ts` fails any utils test that grows one.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { collectPackageSourceFiles, memberDirOf, memberKeyOf, PACKAGES_DIR } from "./support/package-sources";

const TRIPWIRE = "real-data-tripwire.ts";

/**
 * Every `.ts` file each package owns, exempt packages included.
 *
 * `dirs: ["."]` because test files are not all under `test/`: the eval suites keep
 * some beside their modules and `coding-agent` keeps others beside the
 * source they cover. `includeExemptPackages` because the `@veyyon/utils`
 * ownership exemption has nothing to do with this question — `argot` has tests
 * like every other package and needs the same guard.
 */
const ownedFiles = await collectPackageSourceFiles({
	dirs: ["."],
	includeTests: true,
	includeExemptPackages: true,
});

/**
 * The member a test file belongs to: `<name>` for a package, `<root>/<name>` for a member under
 * another root, from the one owner of that mapping.
 *
 * This was `relative(PACKAGES_DIR, file)` first segment, so it could only name a member under
 * `packages/`. `contracts/wire` has eight suites and a `bunfig.toml`, and while the walk and this
 * key both stopped at `packages/`, the member with the BROKEN preload pointer was the one member
 * this gate no longer looked at.
 */
const packagesWithTests = [...new Set(ownedFiles.filter(file => file.endsWith(".test.ts")).map(memberKeyOf))]
	.filter(Boolean)
	.sort();

describe("bunfig preload coverage across packages", () => {
	/** Guards the guard: a discovery walk that finds nothing, or only one package,
	 *  would make every assertion below pass without checking anything real. */
	it("finds the packages that have tests", () => {
		expect(packagesWithTests.length).toBeGreaterThan(5);
		expect(packagesWithTests).toContain("utils");
		expect(packagesWithTests).toContain("coding-agent");
		// The exempt package is included on purpose: exempting it here would be a
		// hole in the guard, not a courtesy. Keyed by member path, because the
		// package is exempt from the ownership locks and not from its root.
		expect(packagesWithTests).toContain("plugins/argot");
		// And a member outside `packages/`, which is where this gate went blind.
		expect(packagesWithTests).toContain("contracts/wire");
	});

	/** THE contract. A package with tests and no bunfig runs them with no
	 *  tripwire, so a wrong-isolation suite writes into the developer's real
	 *  config root instead of being refused. */
	it.each(packagesWithTests)("%s declares a bunfig preload", packageName => {
		const bunfig = path.join(memberDirOf(packageName), "bunfig.toml");

		expect(existsSync(bunfig)).toBe(true);
		expect(readFileSync(bunfig, "utf8")).toContain(TRIPWIRE);
	});

	/** The pointer must resolve. A preload path that does not exist is not an
	 *  error Bun reports loudly, so a typo would silently disable the guard for
	 *  that package while this file's existence check still passed. */
	it.each(packagesWithTests)("%s points at a file that exists", packageName => {
		const packageDir = memberDirOf(packageName);
		const contents = readFileSync(path.join(packageDir, "bunfig.toml"), "utf8");
		const match = /preload\s*=\s*\[\s*"([^"]+)"/.exec(contents);

		expect(match).not.toBeNull();
		expect(existsSync(path.resolve(packageDir, match?.[1] ?? ""))).toBe(true);
	});

	/** One tripwire, one file. A package that copied the implementation instead
	 *  of pointing at it would drift, and the copy would not be updated when the
	 *  guard learns a new forbidden path. */
	it("has exactly one tripwire implementation in the repository", () => {
		const found = ownedFiles.filter(file => path.basename(file) === TRIPWIRE).map(memberKeyOf);

		expect(found).toEqual(["utils"]);
	});
});

describe("the root bunfig's test discovery", () => {
	const repoRoot = path.resolve(PACKAGES_DIR, "..");
	const rootBunfig = readFileSync(path.join(repoRoot, "bunfig.toml"), "utf8");

	/**
	 * The benchmark's cloned upstream repositories are not this repository's
	 * tests. Bun does not honour .gitignore, so without the prune a root-level
	 * `bun test` collected nine test files out of a cached Effect checkout and
	 * failed all nine on a dependency this repository does not install — noise
	 * that reads exactly like a real regression in a 29,000-test sweep.
	 */
	it("prunes the eval suites' cloned repositories", () => {
		expect(rootBunfig).toContain("packages/evals/datasets/repo-cache/**");
	});

	/** The package-local config has to prune them too, because a `bun test` run
	 *  from inside that package never reads the root config at all. */
	it("prunes them in the evals package's own config as well", () => {
		const local = readFileSync(path.join(PACKAGES_DIR, "evals/bunfig.toml"), "utf8");

		expect(local).toContain("datasets/repo-cache/**");
		expect(local).toContain(TRIPWIRE);
	});

	/** And the shared source walk must skip it, or every ownership lock reads
	 *  hundreds of thousands of another project's files and judges them against
	 *  this repository's rules. */
	it("is skipped by the shared package-source walk", () => {
		expect(ownedFiles.some(file => file.includes(`${path.sep}repo-cache${path.sep}`))).toBe(false);
	});
});
