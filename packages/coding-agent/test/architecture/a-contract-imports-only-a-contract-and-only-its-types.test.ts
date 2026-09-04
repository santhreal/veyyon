/**
 * WHY: `contracts/` is the layer every host and every plugin is allowed to share, and it is only
 * worth anything while it depends on nothing that runs. A contract that imports `@veyyon/tui` makes a
 * browser client build a terminal renderer; a contract that imports `@veyyon/coding-agent` makes a
 * plugin depend on the whole 466 000-line package it was supposed to be decoupled from. Either way
 * the layer stops being a boundary and becomes another node in the same graph.
 *
 * THE ONE EDGE THE LAYER ADMITS. A contract may `import type` from another contract, and nothing
 * else. Vocabularies compose: a tool result holds the content blocks a message holds, a session event
 * carries a message, and a rule that forbids the edge does not remove the need for the shape; it
 * makes a second copy of it. `contracts/wire` re-declaring `TextContent` and `ImageContent` beside
 * their owner in `@veyyon/model` is what the flat rule produced, with a conformance suite whose only
 * job was to check that the copies still agreed. The edge is admitted under three conditions, each a
 * cell below: the target is a contract, the import is erased (`import type`, `export type`, a clause
 * whose every member is `type`), and the contract graph has no cycle. A fourth cell pins the edge set
 * by exact equality, so a new pair is a recorded decision here and not a side effect.
 *
 * THE DEFECT CLASS. A convenience import added for one type, defended with "it is only a type".
 * Against a non-contract that defence is exactly wrong: type-only or not, the declaration is required
 * to build and the package is required to install. The class also includes the quieter half: a
 * `dependencies` entry added to a contract's manifest before any code imports it, which a source
 * sweep alone cannot see, so the manifest cell asserts the declared set equals the imported set.
 *
 * WHY THIS SUITE AND NOT THE FOUR THAT CAME BEFORE IT. `contracts/wire` already had four locks
 * (`wire-presentation-has-no-agent-imports`, `wire-presentation-has-no-tui-imports`,
 * `presentation-has-no-any`, and the package's own `the-presentation-contract-is-locked`). Each names
 * one directory of one package, which is why a second contract package could be added with no rule
 * over it at all. This suite states the rule for the LAYER, derived from the directory at run time,
 * so a new member arrives covered. It does not replace those four: they pin `wire/src/presentation`
 * specifically, including its named runtime and renderer packages, and they stay.
 *
 * WHAT IT DOES NOT CATCH. Three things. A contract that re-declares a type another contract owns
 * rather than importing it, which is duplication rather than dependency and is a design review. A
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
	valueImportSpecifiers,
} from "./helpers/module-graph";

const CONTRACTS = repoPath("contracts");

/** Shared TypeScript config beside the packages it configures, not a member. */
const NOT_A_CONTRACT: ReadonlySet<string> = new Set(["tsconfig.workspace.json", "node_modules"]);

/** One contract package: its directory name, its published name and the source directory the rule covers. */
interface Contract {
	name: string;
	packageName: string;
	directory: string;
	sourceDirectory: string;
}

/** The parts of a manifest this suite reads. */
interface Manifest {
	name?: unknown;
	dependencies?: unknown;
}

function readManifest(packageJsonPath: string): Manifest {
	const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	return typeof manifest === "object" && manifest !== null ? (manifest as Manifest) : {};
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
		const packageJsonPath = join(directory, "package.json");
		if (!existsSync(packageJsonPath)) continue;
		const { name: packageName } = readManifest(packageJsonPath);
		if (typeof packageName !== "string") throw new Error(`contracts/${name}/package.json declares no name`);
		found.push({ name, packageName, directory, sourceDirectory: join(directory, "src") });
	}
	return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** Declared `dependencies` of a package, which ship to whoever installs it. */
function runtimeDependencyNames(packageJsonPath: string): string[] {
	const { dependencies } = readManifest(packageJsonPath);
	if (typeof dependencies !== "object" || dependencies === null) return [];
	return Object.keys(dependencies).sort();
}

/** The package a `@veyyon/<name>[/subpath]` specifier names, or `undefined` for any other specifier. */
function packageOf(specifier: string): string | undefined {
	const match = specifier.match(/^(@veyyon\/[^/]+)/);
	return match?.[1];
}

/** Whether a relative specifier climbs out of the contract's own directory. */
function escapesPackage(contract: Contract, file: string, specifier: string): boolean {
	if (!specifier.startsWith(".")) return false;
	const target = resolve(join(file, ".."), specifier);
	return !target.startsWith(`${contract.directory}/`);
}

const members = contracts();
const contractNames = new Set(members.map(member => member.packageName));

/** Every `<file> -> <specifier>` edge from a contract source file to a package in this repository. */
function repositoryEdges(): { member: Contract; file: string; specifier: string }[] {
	const edges: { member: Contract; file: string; specifier: string }[] = [];
	for (const member of members) {
		for (const file of typeScriptFiles(member.sourceDirectory)) {
			for (const specifier of importSpecifiers(file)) {
				if (specifier.startsWith("@veyyon/")) edges.push({ member, file, specifier });
			}
		}
	}
	return edges;
}

/** The contract-to-contract edge set, one entry per ordered pair, as `contracts/<a> -> @veyyon/<b>`. */
function contractGraph(): Map<string, Set<string>> {
	const graph = new Map<string, Set<string>>(members.map(member => [member.packageName, new Set<string>()]));
	for (const { member, specifier } of repositoryEdges()) {
		const target = packageOf(specifier);
		if (target !== undefined && contractNames.has(target)) graph.get(member.packageName)?.add(target);
	}
	return graph;
}

/** The first cycle found in `graph`, as the package names along it, or `undefined` when there is none. */
function firstCycle(graph: Map<string, Set<string>>): string[] | undefined {
	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];
	const visit = (node: string): string[] | undefined => {
		const seen = state.get(node);
		if (seen === "done") return undefined;
		if (seen === "visiting") return [...path.slice(path.indexOf(node)), node];
		state.set(node, "visiting");
		path.push(node);
		for (const next of graph.get(node) ?? []) {
			const cycle = visit(next);
			if (cycle) return cycle;
		}
		path.pop();
		state.set(node, "done");
		return undefined;
	};
	for (const node of graph.keys()) {
		const cycle = visit(node);
		if (cycle) return cycle;
	}
	return undefined;
}

describe("a contract imports only a contract, and only its types", () => {
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

	test("no contract source file imports a non-contract package from this repository", () => {
		const edges: string[] = [];
		for (const { file, specifier } of repositoryEdges()) {
			const target = packageOf(specifier);
			if (target === undefined || !contractNames.has(target)) edges.push(`${repoRelative(file)} -> ${specifier}`);
		}
		expect(edges, "a contract may reach another contract and nothing else in this repository").toEqual([]);
	});

	/**
	 * The admitted edge is erased at build time or it is not admitted. `export * from` a contract is a
	 * runtime re-export and fails here; `export type * from` passes.
	 */
	test("every edge from a contract to a contract is type-only", () => {
		const runtime: string[] = [];
		for (const member of members) {
			for (const file of typeScriptFiles(member.sourceDirectory)) {
				for (const specifier of valueImportSpecifiers(file)) {
					if (specifier.startsWith("@veyyon/")) runtime.push(`${repoRelative(file)} -> ${specifier}`);
				}
			}
		}
		expect(runtime, "a contract-to-contract edge survives type erasure").toEqual([]);
	});

	test("no contract source file climbs out of its own package by relative path", () => {
		const edges: string[] = [];
		for (const member of members) {
			for (const file of typeScriptFiles(member.sourceDirectory)) {
				for (const specifier of importSpecifiers(file)) {
					if (escapesPackage(member, file, specifier)) edges.push(`${repoRelative(file)} -> ${specifier}`);
				}
			}
		}
		expect(edges, "a relative escape reaches whatever sits beside the contract").toEqual([]);
	});

	/**
	 * The whole external surface, stated as one set. A contract may reach a node builtin, a sibling
	 * module or a contract, so this is the cell that catches a third-party package -- a contract that
	 * needs one has stopped being dependency-free even when the package is not from this repository.
	 */
	test("every specifier is a relative sibling, a node builtin or a contract", () => {
		const external: string[] = [];
		for (const member of members) {
			for (const file of typeScriptFiles(member.sourceDirectory)) {
				for (const specifier of importSpecifiers(file)) {
					if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
					const target = packageOf(specifier);
					if (target !== undefined && contractNames.has(target)) continue;
					external.push(specifier);
				}
			}
		}
		expect([...new Set(external)].sort()).toEqual([]);
	});

	/**
	 * The manifest half of the rule. An import sweep sees code; this sees intent. The declared set
	 * equals the imported set, so a dependency declared before the first import of it fails, and an
	 * import with no declaration -- which resolves through the workspace and breaks for an installer --
	 * fails too.
	 */
	test("a contract declares exactly the contracts it imports and nothing else", () => {
		const graph = contractGraph();
		for (const member of members) {
			const declared = runtimeDependencyNames(join(member.directory, "package.json"));
			const imported = [...(graph.get(member.packageName) ?? [])].sort();
			expect(declared, `contracts/${member.name} dependencies`).toEqual(imported);
		}
	});

	test("the contract graph has no cycle", () => {
		expect(firstCycle(contractGraph())).toBeUndefined();
	});

	/**
	 * The edge set, pinned by exact equality. Every pair here was a recorded decision: the importing
	 * contract needed a shape the other owns, and copying it would have made two owners. A new pair
	 * turns this cell red until it is added here with the same justification.
	 *
	 * `@veyyon/session -> @veyyon/model`: an entry records a message, an attribution, a service tier
	 * and the content blocks the model contract owns.
	 * `@veyyon/tool -> @veyyon/model`: a tool result holds the content blocks a message holds.
	 * `@veyyon/wire -> @veyyon/model`: every block, stop reason and usage a guest reads is a
	 * `Pick` of the one the model contract owns, so the two cannot drift.
	 */
	test("every contract-to-contract edge is one recorded here", () => {
		const edges: string[] = [];
		for (const [from, targets] of contractGraph()) {
			for (const to of targets) edges.push(`${from} -> ${to}`);
		}
		expect(edges.sort()).toEqual([
			"@veyyon/session -> @veyyon/model",
			"@veyyon/tool -> @veyyon/model",
			"@veyyon/wire -> @veyyon/model",
		]);
	});
});
