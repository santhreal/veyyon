import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveModuleSpecifier } from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution, workspacePackages } from "@veyyon/utils/module-reach-workspace";

/**
 * Contract: the module-reach gates resolve a cross-package import the way the runtime does, for EVERY
 * package in this workspace, because the table they resolve with is derived from the workspace instead of
 * being typed out per gate.
 *
 * WHAT WENT WRONG AND WHY IT WAS INVISIBLE. Four gates pin a ceiling on the static import graph and each
 * one carried its own hand-written name-to-source table. They disagreed: two coding-agent gates listed
 * seven packages and four packages respectively, and BOTH listed `@veyyon/agent`, which no package in
 * this workspace is called. The directory is `packages/agent` and the name is `@veyyon/agent-core`, so
 * 569 `@veyyon/agent-core` specifiers resolved to nothing, and `@veyyon/mnemopi` (161 specifiers),
 * `@veyyon/natives` (63), `@veyyon/stats` (37) and `@veyyon/tool-render` (2) were unknown to all four.
 *
 * Nothing failed. Every assertion in those gates is an upper bound or a "does not reach", so a specifier
 * the table does not know stops the walk, lowers the count, and PASSES. That is the exact failure mode
 * `module-reach.ts` was extracted to end when the walk itself was duplicated, and copying the table by
 * hand reintroduced it one layer down.
 *
 * WHY THE TESTS BELOW ARE MOSTLY ABOUT DERIVATION. A gate that lists packages can be wrong in one way
 * that matters (a name missing) and it cannot be tested, because the list IS the expectation. A gate that
 * derives them from `package.json` `exports` can be wrong in ways that CAN be tested: a conditions object
 * it does not understand, a wildcard whose prefix it computes wrongly, a `main`-only package it drops.
 * Each of those is a case here, against fixture manifests, plus a completeness check over the real
 * workspace so a new package cannot join it unresolved.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/** Write a fixture workspace: one `packages/<dir>/package.json` per entry, plus any source files named. */
function fixtureWorkspace(packages: Record<string, unknown>, sources: string[] = []): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-reach-workspace-"));
	for (const [dir, manifest] of Object.entries(packages)) {
		const packageDir = path.join(root, "packages", dir);
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageDir, "package.json"),
			typeof manifest === "string" ? manifest : JSON.stringify(manifest),
		);
	}
	for (const relative of sources) {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "export const marker = 1;\n");
	}
	return root;
}

/** Resolve `specifier` in a fixture workspace, from a file that does not need to exist. */
function resolveIn(root: string, specifier: string): string | undefined {
	const resolved = resolveModuleSpecifier(
		path.join(root, "packages", "caller", "src", "caller.ts"),
		specifier,
		workspaceModuleReachResolution(root),
	);
	return resolved === undefined ? undefined : path.relative(root, resolved);
}

describe("deriving the table from a package's exports map", () => {
	/**
	 * The bare name, which is the entry that matters most and the easiest one to get wrong: it resolves to
	 * a package's whole barrel, the most expensive import style there is, so omitting it does not fail a
	 * ceiling, it lowers it.
	 */
	it("maps a bare package name to the file its `.` export points at", () => {
		const root = fixtureWorkspace(
			{ shape: { name: "@fixture/shape", exports: { ".": { import: "./src/index.ts" } } } },
			["packages/shape/src/index.ts"],
		);

		expect(resolveIn(root, "@fixture/shape")).toBe(path.join("packages", "shape", "src", "index.ts"));
	});

	/**
	 * The declared NAME, not the directory name. `packages/agent` is `@veyyon/agent-core`, and two gates
	 * that assumed otherwise silently stopped resolving 569 specifiers. Deriving the table cannot make that
	 * mistake, and this case is what says so.
	 */
	it("keys on the declared name even when it differs from the directory name", () => {
		const root = fixtureWorkspace({ core: { name: "@fixture/core-renamed", exports: { ".": "./src/index.ts" } } }, [
			"packages/core/src/index.ts",
		]);

		expect(resolveIn(root, "@fixture/core-renamed")).toBe(path.join("packages", "core", "src", "index.ts"));
		expect(resolveIn(root, "@fixture/core")).toBeUndefined();
	});

	/**
	 * An exact subpath export whose target is an index file. It has to go in `packages` (matched exactly)
	 * rather than through the `./*` alias, or `@fixture/deep/core` resolves to `src/core.ts`, which does not
	 * exist, and the edge disappears.
	 */
	it("maps an exact subpath export to its declared target rather than through the wildcard", () => {
		const root = fixtureWorkspace(
			{
				deep: {
					name: "@fixture/deep",
					exports: {
						".": "./src/index.ts",
						"./core": "./src/core/index.ts",
						"./*": "./src/*.ts",
					},
				},
			},
			["packages/deep/src/index.ts", "packages/deep/src/core/index.ts", "packages/deep/src/other.ts"],
		);

		expect(resolveIn(root, "@fixture/deep/core")).toBe(path.join("packages", "deep", "src", "core", "index.ts"));
		expect(resolveIn(root, "@fixture/deep/other")).toBe(path.join("packages", "deep", "src", "other.ts"));
	});

	/** A nested wildcard export becomes its own, longer prefix, and the longest prefix has to win. */
	it("maps a nested wildcard export to a longer prefix than the top-level one", () => {
		const root = fixtureWorkspace(
			{
				ui: {
					name: "@fixture/ui",
					exports: {
						".": "./src/index.ts",
						"./*": "./src/*.ts",
						"./components/*": "./src/components/*.ts",
					},
				},
			},
			["packages/ui/src/index.ts", "packages/ui/src/components/box.ts"],
		);

		expect(resolveIn(root, "@fixture/ui/components/box")).toBe(
			path.join("packages", "ui", "src", "components", "box.ts"),
		);
	});

	/**
	 * A conditions object, including a nested one. `exports` in this workspace is written as
	 * `{ types, import }` and a package is free to nest a `bun`/`node` split inside that; reading only a
	 * plain string would drop every entry in the repository.
	 */
	it("reads the target out of a conditions object and a nested one", () => {
		const root = fixtureWorkspace(
			{
				cond: {
					name: "@fixture/cond",
					exports: {
						".": { types: "./src/index.d.ts", import: { bun: "./src/index.ts" } },
					},
				},
			},
			["packages/cond/src/index.ts"],
		);

		expect(resolveIn(root, "@fixture/cond")).toBe(path.join("packages", "cond", "src", "index.ts"));
	});

	/** `import` before `types`, because the types entry can point at a `.d.ts` that is not the module. */
	it("prefers the import condition over the types condition", () => {
		const root = fixtureWorkspace(
			{
				both: {
					name: "@fixture/both",
					exports: { ".": { types: "./types/index.d.ts", import: "./src/index.ts" } },
				},
			},
			["packages/both/src/index.ts", "packages/both/types/index.d.ts"],
		);

		expect(resolveIn(root, "@fixture/both")).toBe(path.join("packages", "both", "src", "index.ts"));
	});

	/** A package with no `exports` still offers its bare name through `main`, which `@veyyon/natives` does. */
	it("falls back to main when a package declares no exports map", () => {
		const root = fixtureWorkspace({ legacy: { name: "@fixture/legacy", main: "./native/index.js" } }, [
			"packages/legacy/native/index.js",
		]);

		expect(resolveIn(root, "@fixture/legacy")).toBe(path.join("packages", "legacy", "native", "index.js"));
	});

	/**
	 * An export that re-points at somebody else's package is outside the world these gates measure: the
	 * count is of modules THIS repository instantiates, and an external dependency is one edge whatever its
	 * own size. Following it would also walk into `node_modules` and never come back.
	 */
	it("ignores an export target that names another package rather than a path", () => {
		const root = fixtureWorkspace({ proxy: { name: "@fixture/proxy", exports: { ".": "lru-cache" } } });

		expect(resolveIn(root, "@fixture/proxy")).toBeUndefined();
	});

	/**
	 * `./*.js` and `./*` describe the same prefix with different extensions. This table maps a prefix to a
	 * DIRECTORY and does not rewrite extensions, and `resolveFile` already tries `.ts`, so the `./*` form
	 * covers both; taking the `.js` form as a second alias would register a duplicate prefix whose
	 * behaviour depends on which one the longest-prefix search happened to see first.
	 */
	it("registers one prefix when a package declares both the bare and the .js wildcard", () => {
		const root = fixtureWorkspace(
			{ dual: { name: "@fixture/dual", exports: { "./*": "./src/*.ts", "./*.js": "./src/*.ts" } } },
			["packages/dual/src/leaf.ts"],
		);
		const aliases = workspaceModuleReachResolution(root).aliases ?? [];

		expect(aliases.filter(([prefix]) => prefix === "@fixture/dual/")).toHaveLength(1);
		expect(resolveIn(root, "@fixture/dual/leaf")).toBe(path.join("packages", "dual", "src", "leaf.ts"));
	});

	/**
	 * A manifest that will not parse is skipped rather than thrown on. A dependency ceiling should not turn
	 * into a JSON syntax error for an unrelated package, and the completeness check over the real workspace
	 * below is what notices a package that has gone missing from the table.
	 */
	it("skips an unparseable manifest and keeps the rest of the workspace", () => {
		const root = fixtureWorkspace(
			{
				broken: "{ this is not json",
				fine: { name: "@fixture/fine", exports: { ".": "./src/index.ts" } },
			},
			["packages/fine/src/index.ts"],
		);

		expect(resolveIn(root, "@fixture/fine")).toBe(path.join("packages", "fine", "src", "index.ts"));
	});

	/** A directory with no `package.json`, and a manifest with no name, contribute nothing and throw nothing. */
	it("ignores a package directory with no manifest and a manifest with no name", () => {
		const root = fixtureWorkspace({ nameless: { exports: { ".": "./src/index.ts" } } });
		fs.mkdirSync(path.join(root, "packages", "empty-dir"), { recursive: true });

		expect(workspacePackages(root)).toEqual([]);
		expect(workspaceModuleReachResolution(root).packages).toEqual([]);
	});

	/** No `packages/` at all is an empty world, not a crash: a caller may point this at the wrong root. */
	it("returns an empty table for a root with no packages directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "module-reach-workspace-empty-"));

		expect(workspaceModuleReachResolution(root)).toEqual({ packages: [], aliases: [] });
	});
});

describe("the real workspace resolves completely", () => {
	const resolution = workspaceModuleReachResolution(REPO_ROOT);
	const byName = new Map(resolution.packages?.map(([name, entry]) => [name, entry]) ?? []);

	/**
	 * THE REGRESSION CASE, on the exact name that was wrong. `@veyyon/agent-core` lives in
	 * `packages/agent`, and both coding-agent gates listed the directory name instead, so every one of the
	 * 569 imports of it resolved to nothing and their ceilings held anyway.
	 */
	it("resolves @veyyon/agent-core to packages/agent, which the hand-written tables did not", () => {
		expect(byName.get("@veyyon/agent-core")).toBe(path.join(REPO_ROOT, "packages", "agent", "src", "index.ts"));
	});

	/**
	 * The four packages no hand-written table knew about. Named individually rather than counted, so a
	 * failure says which one stopped resolving.
	 */
	it("resolves the packages the hand-written tables omitted entirely", () => {
		expect(byName.get("@veyyon/mnemopi")).toBe(path.join(REPO_ROOT, "packages", "mnemopi", "src", "index.ts"));
		expect(byName.get("@veyyon/natives")).toBe(path.join(REPO_ROOT, "packages", "natives", "native", "index.js"));
		expect(byName.get("@veyyon/stats")).toBe(path.join(REPO_ROOT, "packages", "stats", "src", "index.ts"));
		expect(byName.get("@veyyon/tool-render")).toBe(
			path.join(REPO_ROOT, "packages", "tool-render", "src", "index.ts"),
		);
	});

	/**
	 * THE COMPLETENESS CHECK, which is the point of deriving the table. Every package that declares a bare
	 * entry has one here, so adding a package to this workspace cannot lower every ceiling in the
	 * repository by being unknown to the walk. This is stated as a set difference rather than a count so
	 * the failure message names the package.
	 */
	it("knows the bare name of every workspace package that declares one", () => {
		const declaring = workspacePackages(REPO_ROOT)
			.filter(pkg => pkg.exports.some(([key]) => key === "."))
			.map(pkg => pkg.name);
		const missing = declaring.filter(name => !byName.has(name));

		expect(missing).toEqual([]);
		// Non-vacuity: an empty `declaring` would satisfy the line above while measuring nothing, and a
		// workspace this size has more than a dozen packages with a bare entry.
		expect(declaring.length).toBeGreaterThanOrEqual(13);
	});

	/**
	 * Every package that exports subpaths has a prefix alias, and the alias points into `src`. The gates
	 * lean on this more than on the bare names by volume: `@veyyon/utils/dirs` and its siblings are the
	 * import style this repository's architecture rules push files toward.
	 */
	it("has a source-directory alias for every package that exports subpaths", () => {
		const wildcarding = workspacePackages(REPO_ROOT).filter(pkg => pkg.exports.some(([key]) => key.endsWith("/*")));
		const prefixes = new Set(resolution.aliases?.map(([prefix]) => prefix) ?? []);

		expect(wildcarding.map(pkg => pkg.name).filter(name => !prefixes.has(`${name}/`))).toEqual([]);
		expect(wildcarding.length).toBeGreaterThanOrEqual(8);
	});

	/**
	 * An external dependency stays outside. If `node_modules` ever became resolvable here every ceiling in
	 * the repository would jump by thousands of modules and stop describing this codebase's own graph.
	 */
	it("leaves an external package unresolved", () => {
		const from = path.join(REPO_ROOT, "packages", "coding-agent", "src", "tools", "fetch.ts");

		expect(resolveModuleSpecifier(from, "lru-cache/raw", resolution)).toBeUndefined();
		expect(resolveModuleSpecifier(from, "zod", resolution)).toBeUndefined();
	});

	/** Subpath and bare name of the same package resolve to different files, which is the whole point. */
	it("separates a package's barrel from its leaves", () => {
		const from = path.join(REPO_ROOT, "packages", "coding-agent", "src", "tools", "fetch.ts");

		expect(resolveModuleSpecifier(from, "@veyyon/utils", resolution)).toBe(
			path.join(REPO_ROOT, "packages", "utils", "src", "index.ts"),
		);
		expect(resolveModuleSpecifier(from, "@veyyon/utils/dirs", resolution)).toBe(
			path.join(REPO_ROOT, "packages", "utils", "src", "dirs.ts"),
		);
	});
});
