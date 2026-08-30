/**
 * WHY: `contracts/` is the layer every host and every plugin is allowed to share, and it is only
 * worth anything while it depends on nothing. A contract that imports `@veyyon/tui` makes a browser
 * client build a terminal renderer; a contract that imports `@veyyon/coding-agent` makes a plugin
 * depend on the whole 466 000-line package it was supposed to be decoupled from. Either way the
 * layer stops being a boundary and becomes another node in the same graph.
 *
 * THE DEFECT CLASS. A convenience import added for one type, defended with "it is only a type".
 * Type-only or not, the edge is in the module graph and the declaration is required to build. The
 * class also includes the quieter half: a `dependencies` entry added to a contract's manifest before
 * any code imports it, which a source sweep alone cannot see.
 *
 * WHY THIS SUITE AND NOT THE FOUR THAT CAME BEFORE IT. `contracts/wire` already had four locks
 * (`wire-presentation-has-no-agent-imports`, `wire-presentation-has-no-tui-imports`,
 * `presentation-has-no-any`, and the package's own `the-presentation-contract-is-locked`). Each names
 * one directory of one package, which is why a second contract package could be added with no rule
 * over it at all. This suite states the rule for the LAYER, derived from the directory at run time,
 * so a new member arrives covered. It does not replace those four: they pin `wire/src/presentation`
 * specifically, including its named runtime and renderer packages, and they stay.
 *
 * THE RULE IS STRICT ON PURPOSE. A contract may not import another contract either. Composition
 * inside the layer is a reasonable thing to want, and the moment it is actually needed the rule can
 * be relaxed by a recorded decision and an assertion that names the pair. Until then "nothing in
 * this repository" is one sentence with no exceptions to audit.
 *
 * WHAT IT DOES NOT CATCH. Three things. A contract that re-declares a runtime type by hand rather
 * than importing it, which is duplication rather than dependency and is a design review. A
 * `devDependency` used only by the package's own tests -- `contracts/wire` uses `@veyyon/utils` that
 * way, and a test helper is not part of the shipped contract. And a contract whose SHAPE mirrors a
 * host's internals so closely that only one host can satisfy it, which no graph rule can see.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	importSpecifiers,
	isDirectory,
	repoPath,
	repoRelative,
	subdirectories,
	typeScriptFiles,
} from "./helpers/module-graph";

const CONTRACTS = repoPath("contracts");

/** Shared TypeScript config beside the packages it configures, not a member. */
const NOT_A_CONTRACT: ReadonlySet<string> = new Set(["tsconfig.workspace.json", "node_modules"]);

/** One contract package: its name and the source directory the rule covers. */
interface Contract {
	name: string;
	directory: string;
	sourceDirectory: string;
}

/**
 * Every contract package, read from the directory rather than listed here.
 *
 * A member is a subdirectory holding a `package.json`. Deriving it is what makes a new contract fail
 * this suite by default instead of shipping unexamined.
 */
function contracts(): Contract[] {
	if (!isDirectory(CONTRACTS)) return [];
	const found: Contract[] = [];
	for (const directory of subdirectories(CONTRACTS)) {
		const name = basename(directory);
		if (NOT_A_CONTRACT.has(name)) continue;
		if (!existsSync(join(directory, "package.json"))) continue;
		found.push({ name, directory, sourceDirectory: join(directory, "src") });
	}
	return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** Declared `dependencies` of a package, which ship to whoever installs it. */
function runtimeDependencyNames(packageJsonPath: string): string[] {
	const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	if (typeof manifest !== "object" || manifest === null || !("dependencies" in manifest)) return [];
	const declared = manifest.dependencies;
	if (typeof declared !== "object" || declared === null) return [];
	return Object.keys(declared).sort();
}

/**
 * Whether a specifier reaches something in this repository.
 *
 * Two ways it can. A `@veyyon/*` package name is the obvious one. A relative path that climbs out of
 * the contract's own directory is the one that gets missed, because it looks local.
 */
function reachesThisRepository(contract: Contract, file: string, specifier: string): boolean {
	if (specifier.startsWith("@veyyon/")) return true;
	if (!specifier.startsWith(".")) return false;
	const target = resolve(join(file, ".."), specifier);
	return !target.startsWith(`${contract.directory}/`);
}

const members = contracts();

describe("a contract depends on nothing in this repository", () => {
	/**
	 * Anti-vacuity. Every cell below iterates `members`, so a `contracts/` directory this suite could
	 * not read would leave the list empty and pass while checking nothing. The named members are the
	 * ones that exist today; the floor is what makes a new one arrive covered.
	 */
	test("the layer exists and its members are found on disk", () => {
		expect(isDirectory(CONTRACTS)).toBe(true);
		expect(members.map(member => member.name)).toContain("wire");
		expect(members.map(member => member.name)).toContain("view");
		expect(members.length).toBeGreaterThanOrEqual(2);
	});

	test("every member ships a source directory with modules in it", () => {
		for (const member of members) {
			expect(isDirectory(member.sourceDirectory), `contracts/${member.name}/src`).toBe(true);
			expect(
				typeScriptFiles(member.sourceDirectory).length,
				`modules in contracts/${member.name}/src`,
			).toBeGreaterThan(0);
		}
	});

	test("no contract source file imports a package from this repository", () => {
		const edges: string[] = [];
		for (const member of members) {
			for (const file of typeScriptFiles(member.sourceDirectory)) {
				for (const specifier of importSpecifiers(file)) {
					if (specifier.startsWith("@veyyon/")) edges.push(`${repoRelative(file)} -> ${specifier}`);
				}
			}
		}
		expect(edges, "a contract must not import a package from this repository").toEqual([]);
	});

	test("no contract source file climbs out of its own package by relative path", () => {
		const edges: string[] = [];
		for (const member of members) {
			for (const file of typeScriptFiles(member.sourceDirectory)) {
				for (const specifier of importSpecifiers(file)) {
					if (specifier.startsWith("@veyyon/")) continue;
					if (reachesThisRepository(member, file, specifier)) edges.push(`${repoRelative(file)} -> ${specifier}`);
				}
			}
		}
		expect(edges, "a relative escape reaches whatever sits beside the contract").toEqual([]);
	});

	/**
	 * The whole external surface, stated as one set. A contract may reach a node builtin and nothing
	 * else, so this is the cell that catches a third-party package too -- a contract that needs one
	 * has stopped being dependency-free even when the package is not from this repository.
	 */
	test("every specifier is a relative sibling or a node builtin", () => {
		const external: string[] = [];
		for (const member of members) {
			for (const file of typeScriptFiles(member.sourceDirectory)) {
				for (const specifier of importSpecifiers(file)) {
					if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
					external.push(specifier);
				}
			}
		}
		expect([...new Set(external)].sort()).toEqual([]);
	});

	/**
	 * The manifest half of the rule. An import sweep sees code; this sees intent, and fails on a
	 * dependency declared before the first import of it is written.
	 */
	test("no contract declares a runtime dependency at all", () => {
		const declared: string[] = [];
		for (const member of members) {
			for (const dependency of runtimeDependencyNames(join(member.directory, "package.json"))) {
				declared.push(`contracts/${member.name} -> ${dependency}`);
			}
		}
		expect(declared, "a contract's dependencies ship to everyone who installs it").toEqual([]);
	});
});
