/**
 * A workspace reorganization preserves all published package names, binaries,
 * exports subpaths, and barrel export declarations.
 *
 * WHY THIS SUITE EXISTS. In PR #927 ("Everything as a Plugin"), ~804 Rust files moved
 * from `crates/*` to `natives/*`, `packages/tui` moved to `hosts/terminal/engine`,
 * `contracts/view` and `contracts/wire` appeared, `natives/bridge/bindings` replaced
 * `packages/natives`, and tool renderers moved to host-agnostic views.
 *
 * When packages move across directories and barrel files are refactored, subtle regressions
 * can happen in silence: an exports subpath key in `package.json` can be omitted, a bin key
 * can be dropped, a package name can be misspelled or omitted from workspace globs, a named
 * export can disappear from a barrel file, or a re-export `export * from "./x"` can point
 * to a missing file.
 *
 * This suite proves statically against the committed ledger in `scripts/fixtures/published-surface.json`
 * that:
 * 1. Every package name from the baseline still exists in the workspace.
 * 2. Every binary command name from the baseline survives.
 * 3. Every exports subpath key from the baseline survives or has its intentional relocation pinned.
 * 4. Every named export declared in every package entrypoint barrel survives.
 * 5. Every star re-export edge (`export * from "./x"`) in every package entrypoint resolves to an existing file on disk.
 * 6. Every package addition and subpath addition is explicitly pinned by exact equality.
 *
 * WHAT THIS SUITE DOES NOT CATCH. This suite checks static module identity and export surface parity.
 * It does not execute runtime function behavior, type-check internal function parameter types,
 * or verify transitive deep re-exports through multi-hop barrel chains.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseBabel } from "@babel/parser";
import type {
	ArrayPattern,
	AssignmentPattern,
	Declaration,
	ExportNamedDeclaration,
	ExportSpecifier,
	Identifier,
	Node,
	ObjectPattern,
	RestElement,
} from "@babel/types";
import { expandExportsToSubpaths, type PublishedSurfaceLedger } from "./measure-published-surface";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout";

interface WorkspacePackageSnapshot {
	readonly name: string;
	readonly directory: string;
	readonly private: boolean;
	readonly version: string | null;
	readonly main: string | null;
	readonly module: string | null;
	readonly types: string | null;
	readonly binKeys: readonly string[];
	readonly exportsKeys: readonly string[];
	readonly resolvedSubpaths: readonly string[];
	readonly entrypoint: string | null;
	readonly entrypointFilePath: string | null;
	readonly namedExports: readonly string[];
	readonly starEdges: readonly string[];
}

const NEVER_A_SOURCE_DIRECTORY = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

/**
 * Every file under one member, repository-relative, so the head side expands its `exports` patterns
 * against the working tree while the ledger's base side expanded them against a git listing. One
 * expansion function, two file lists: a second implementation is how the two sides stop agreeing.
 */
function filesUnderMember(member: string): string[] {
	const root = join(REPO_ROOT, member);
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (NEVER_A_SOURCE_DIRECTORY.has(entry.name)) continue;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) found.push(relative(REPO_ROOT, full).split("\\").join("/"));
		}
	};
	if (existsSync(root)) walk(root);
	return found;
}

function resolvePackageEntrypoint(pkgData: { exports?: unknown; main?: string; module?: string }): string | null {
	const exports = pkgData.exports;
	if (typeof exports === "string") return exports;
	if (exports && typeof exports === "object" && "." in exports) {
		const dot = (exports as Record<string, unknown>)["."];
		if (typeof dot === "string") return dot;
		if (dot && typeof dot === "object") {
			const record = dot as Record<string, unknown>;
			const candidate = record.import ?? record.default ?? record.types;
			if (typeof candidate === "string") return candidate;
		}
	}
	if (typeof pkgData.main === "string") return pkgData.main;
	if (typeof pkgData.module === "string") return pkgData.module;
	return null;
}

function collectPatternIdentifiers(patternNode: Node | null | undefined, names: Set<string>): void {
	if (!patternNode) return;
	if (patternNode.type === "Identifier") {
		names.add((patternNode as Identifier).name);
	} else if (patternNode.type === "ObjectPattern") {
		const obj = patternNode as ObjectPattern;
		for (const prop of obj.properties) {
			if (prop.type === "ObjectProperty") {
				collectPatternIdentifiers(prop.value, names);
			} else if (prop.type === "RestElement") {
				collectPatternIdentifiers((prop as RestElement).argument, names);
			}
		}
	} else if (patternNode.type === "ArrayPattern") {
		const arr = patternNode as ArrayPattern;
		for (const el of arr.elements) {
			if (el) collectPatternIdentifiers(el, names);
		}
	} else if (patternNode.type === "RestElement") {
		collectPatternIdentifiers((patternNode as RestElement).argument, names);
	} else if (patternNode.type === "AssignmentPattern") {
		collectPatternIdentifiers((patternNode as AssignmentPattern).left, names);
	}
}

function parseBarrelExportsFromSource(code: string): {
	namedExports: string[];
	starEdges: string[];
} {
	const ast = parseBabel(code, {
		sourceType: "module",
		plugins: ["typescript", "jsx"],
	});

	const namedExports = new Set<string>();
	const starEdges = new Set<string>();

	for (const node of ast.program.body) {
		if (node.type === "ExportNamedDeclaration") {
			const named = node as ExportNamedDeclaration;
			if (named.declaration) {
				const decl = named.declaration as Declaration;
				if (decl.type === "VariableDeclaration") {
					for (const d of decl.declarations) {
						collectPatternIdentifiers(d.id, namedExports);
					}
				} else if (
					decl.type === "FunctionDeclaration" ||
					decl.type === "ClassDeclaration" ||
					decl.type === "TSTypeAliasDeclaration" ||
					decl.type === "TSInterfaceDeclaration" ||
					decl.type === "TSEnumDeclaration" ||
					decl.type === "TSModuleDeclaration"
				) {
					if (decl.id && "name" in decl.id && typeof decl.id.name === "string") {
						namedExports.add(decl.id.name);
					}
				}
			}
			if (named.specifiers) {
				for (const spec of named.specifiers) {
					if (spec.type === "ExportSpecifier") {
						const exportSpec = spec as ExportSpecifier;
						const name =
							exportSpec.exported.type === "Identifier" ? exportSpec.exported.name : exportSpec.exported.value;
						namedExports.add(name);
					} else if (spec.type === "ExportNamespaceSpecifier") {
						namedExports.add(spec.exported.name);
					}
				}
			}
		} else if (node.type === "ExportAllDeclaration") {
			// A bare `export * from "./x"` is a star edge. `export * as ns from "./x"` is not an
			// `ExportAllDeclaration` at all: Babel reports it as a named export carrying an
			// `ExportNamespaceSpecifier`, which the branch above records by its local name.
			starEdges.add(node.source.value);
		}
	}

	return {
		namedExports: [...namedExports].sort(),
		starEdges: [...starEdges].sort(),
	};
}

/**
 * Workspace package name to the directory that declares it, read once from the members themselves.
 *
 * A barrel used to reach every module it republished through a relative path, so a star edge was
 * always a path. A star edge may now name another workspace package — `src/index.ts` re-exports
 * `@veyyon/kernel/session/session-storage` — and resolving that against the barrel's own directory
 * finds nothing, which reads as an unresolvable edge rather than a cross-package one.
 */
let workspaceDirectoriesByName: Map<string, string> | undefined;

function memberDirectoryOf(packageName: string): string | undefined {
	if (workspaceDirectoriesByName === undefined) {
		workspaceDirectoriesByName = new Map();
		for (const member of typeScriptMembers()) {
			const manifestPath = join(REPO_ROOT, member, "package.json");
			if (!existsSync(manifestPath)) continue;
			const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown };
			if (typeof data.name === "string") workspaceDirectoriesByName.set(data.name, join(REPO_ROOT, member));
		}
	}
	return workspaceDirectoriesByName.get(packageName);
}

function resolveStarExportOnDisk(fromFile: string, specifier: string): string | null {
	let base = dirname(fromFile);
	let body = specifier;
	if (!specifier.startsWith(".")) {
		const scoped = specifier.startsWith("@");
		const parts = specifier.split("/");
		const packageName = scoped ? parts.slice(0, 2).join("/") : parts[0];
		const rest = parts.slice(scoped ? 2 : 1).join("/");
		const memberDir = packageName === undefined ? undefined : memberDirectoryOf(packageName);
		if (memberDir === undefined) return null;
		// A member publishes its modules from `src/`, which is the shape every subpath pattern in this
		// workspace expands into; a package with no `src/` still resolves against its own root.
		base = existsSync(join(memberDir, "src")) ? join(memberDir, "src") : memberDir;
		// The `.js` alias every member publishes beside its extensionless subpath resolves to the same
		// TypeScript source, so the suffix is dropped before the extension candidates below are tried.
		body = (rest === "" ? "index" : rest).replace(/\.js$/, "");
	}
	const dir = base;
	const candidates = [
		resolve(dir, body),
		resolve(dir, `${body}.ts`),
		resolve(dir, `${body}.tsx`),
		resolve(dir, `${body}.d.ts`),
		resolve(dir, `${body}.js`),
		resolve(dir, body, "index.ts"),
		resolve(dir, body, "index.tsx"),
		resolve(dir, body, "index.d.ts"),
		resolve(dir, body, "index.js"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return null;
}

function loadHeadPackages(): Map<string, WorkspacePackageSnapshot> {
	const members = typeScriptMembers();
	const packages = new Map<string, WorkspacePackageSnapshot>();

	for (const member of members) {
		const manifestPath = join(REPO_ROOT, member, "package.json");
		if (!existsSync(manifestPath)) continue;

		const raw = readFileSync(manifestPath, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		const name = typeof data.name === "string" ? data.name : member;
		const priv = Boolean(data.private);
		const version = typeof data.version === "string" ? data.version : null;
		const main = typeof data.main === "string" ? data.main : null;
		const module = typeof data.module === "string" ? data.module : null;
		const types = typeof data.types === "string" ? data.types : null;

		const binKeys =
			typeof data.bin === "object" && data.bin !== null
				? Object.keys(data.bin as Record<string, unknown>).sort()
				: typeof data.bin === "string"
					? [name.split("/").pop() ?? name]
					: [];

		const exportsKeys =
			typeof data.exports === "object" && data.exports !== null
				? Object.keys(data.exports as Record<string, unknown>).sort()
				: typeof data.exports === "string"
					? ["."]
					: [];

		const resolvedSubpaths = expandExportsToSubpaths(data.exports, member, filesUnderMember(member));

		const entrypoint = resolvePackageEntrypoint(data);
		let namedExports: string[] = [];
		let starEdges: string[] = [];
		let entrypointFilePath: string | null = null;

		if (entrypoint) {
			const entryRelative = entrypoint.replace(/^\.\//, "");
			const resolvedPath = resolve(REPO_ROOT, member, entryRelative);
			if (existsSync(resolvedPath)) {
				entrypointFilePath = resolvedPath;
				const code = readFileSync(resolvedPath, "utf-8");
				const parsed = parseBarrelExportsFromSource(code);
				namedExports = parsed.namedExports;
				starEdges = parsed.starEdges;
			}
		}

		packages.set(name, {
			name,
			directory: member,
			private: priv,
			version,
			main,
			module,
			types,
			binKeys,
			exportsKeys,
			resolvedSubpaths,
			entrypoint,
			entrypointFilePath,
			namedExports,
			starEdges,
		});
	}

	return packages;
}

const FIXTURE_PATH = join(REPO_ROOT, "scripts", "fixtures", "published-surface.json");
const LEDGER: PublishedSurfaceLedger = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as PublishedSurfaceLedger;
const HEAD_PACKAGES = loadHeadPackages();

describe("a published surface survives the move", () => {
	// (a) no package name lost
	it("(a) no package name lost from origin/main baseline", () => {
		const baseNames = Object.keys(LEDGER.packages).sort();
		const headNames = [...HEAD_PACKAGES.keys()].sort();

		const missingPackages = baseNames.filter(name => !HEAD_PACKAGES.has(name));
		expect(missingPackages).toEqual([]);
		expect(headNames).toEqual(expect.arrayContaining(baseNames));
	});

	// (b) no exports subpath lost
	it("(b) no exports subpath lost without documented relocation", () => {
		const undocumentedMissingSubpaths: Record<string, string[]> = {};

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			if (!headPkg) continue;

			const missing = basePkg.exportsKeys.filter(k => !headPkg.exportsKeys.includes(k));
			const documentedRelocations = LEDGER.relocations.exportsKeys[name] ?? {};
			const undocumented = missing.filter(k => !(k in documentedRelocations));

			if (undocumented.length > 0) {
				undocumentedMissingSubpaths[name] = undocumented;
			}
		}

		expect(undocumentedMissingSubpaths).toEqual({});

		// Pin exact equality of relocated/removed subpaths to prevent silent drift
		for (const [name, documentedMap] of Object.entries(LEDGER.relocations.exportsKeys)) {
			const basePkg = LEDGER.packages[name];
			const headPkg = HEAD_PACKAGES.get(name);
			if (!basePkg || !headPkg) continue;

			const actualMissing = basePkg.exportsKeys.filter(k => !headPkg.exportsKeys.includes(k)).sort();
			const expectedMissing = Object.keys(documentedMap).sort();
			expect(actualMissing).toEqual(expectedMissing);
		}
	});

	// (b2) every relocation names a successor that is published
	it("(b2) every relocated subpath names a key the manifest still publishes", () => {
		// A reason sentence excuses a removal; a successor key proves the entry point is still reachable.
		// The old spelling is gone by design, so the claim worth testing is that its modules are served
		// under the new one.
		const unservedRelocations: Array<{ package: string; from: string; to: string }> = [];
		let checked = 0;

		for (const [name, documentedMap] of Object.entries(LEDGER.relocations.exportsKeys)) {
			const headPkg = HEAD_PACKAGES.get(name);
			expect(headPkg).toBeDefined();
			if (!headPkg) continue;

			for (const [from, note] of Object.entries(documentedMap)) {
				checked++;
				expect(note.why.length).toBeGreaterThan(20);
				if (!headPkg.exportsKeys.includes(note.to)) {
					unservedRelocations.push({ package: name, from, to: note.to });
				}
			}
		}

		expect(unservedRelocations).toEqual([]);
		expect(checked).toBe(29);
	});

	/**
	 * (b3) The claim cells (b) and (b2) cannot make. They compare `exports` KEYS, and a key is not a
	 * subpath: `"./session/*"` is one key and was 36 importable modules. Step 5 moved those modules to
	 * `@veyyon/kernel` and every key stayed exactly where it was, so a ledger of keys reported no
	 * change while 100 resolved subpaths stopped resolving. This cell states parity over what a
	 * consumer can actually import: 5199 subpaths the branch point served, every one of them still
	 * served here or carrying a successor that is.
	 */
	it("(b3) every resolved subpath main served is still served or relocated to one that is", () => {
		const unserved: Array<{ package: string; subpath: string; to: string | null }> = [];
		let compared = 0;

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			expect(headPkg, `${name} is in the baseline and not in the workspace`).toBeDefined();
			if (!headPkg) continue;
			const served = new Set(headPkg.resolvedSubpaths);
			const rows = LEDGER.relocations.resolvedSubpaths[name] ?? {};

			for (const subpath of basePkg.resolvedSubpaths) {
				compared++;
				if (served.has(subpath)) continue;
				const note = rows[subpath];
				if (note === undefined) {
					unserved.push({ package: name, subpath, to: null });
					continue;
				}
				expect(note.why.length).toBeGreaterThan(20);
				// A successor either stays inside the package (`./x`) or names another package outright.
				const [successorPackage, successorSubpath] = note.to.startsWith("@")
					? [note.to.split("/").slice(0, 2).join("/"), `./${note.to.split("/").slice(2).join("/")}`]
					: [name, note.to];
				const successorPkg = HEAD_PACKAGES.get(successorPackage);
				if (successorPkg === undefined || !successorPkg.resolvedSubpaths.includes(successorSubpath)) {
					unserved.push({ package: name, subpath, to: note.to });
				}
			}
		}

		expect(unserved).toEqual([]);
		expect(compared).toBe(5205);
	});

	/**
	 * (b4) The relocation rows themselves, pinned. A successor is derived — from a git rename, a
	 * documented key relocation, or a recorded absorption — so a rule that started matching more than
	 * it should would otherwise pass as a wider set of correct-looking rows.
	 *
	 * 1021 coding-agent subpaths relocated, 100 of them into `@veyyon/kernel`: 53 modules moved and
	 * each is served twice, extensionless and under a `.js` alias, less the three that this branch
	 * added rather than moved (`extensibility/host-view`, `extensibility/widget`,
	 * `session/agent-session-compaction-policy`) and so were never part of the baseline surface. The
	 * rest are the tool modules, each served under both spellings, that moved into the domain
	 * directory they belong to. The 54 `@veyyon/tui` rows are the terminal engine's move to
	 * `hosts/terminal/engine` and the utility modules that went to `@veyyon/utils` with it.
	 */
	it("(b4) resolved-subpath relocations are pinned by exact equality", () => {
		const rows = LEDGER.relocations.resolvedSubpaths;
		expect(Object.keys(rows).sort()).toEqual(["@veyyon/coding-agent", "@veyyon/tui"]);

		const codingAgent = rows["@veyyon/coding-agent"] ?? {};
		expect(Object.keys(codingAgent).length).toBe(1021);
		const intoKernel = Object.values(codingAgent).filter(note => note.to.startsWith("@veyyon/kernel/"));
		expect(intoKernel.length).toBe(100);
		const kernelConcerns = new Set(intoKernel.map(note => note.to.split("/").slice(0, 3).join("/")));
		expect([...kernelConcerns].sort()).toEqual([
			"@veyyon/kernel/loader",
			"@veyyon/kernel/registry",
			"@veyyon/kernel/session",
		]);

		const tui = rows["@veyyon/tui"] ?? {};
		expect(Object.keys(tui).length).toBe(54);

		const successorPackages = new Set(
			Object.entries(rows).flatMap(([owner, table]) =>
				Object.values(table).map(note =>
					note.to.startsWith("@") ? note.to.split("/").slice(0, 2).join("/") : owner,
				),
			),
		);
		expect([...successorPackages].sort()).toEqual([
			"@veyyon/coding-agent",
			"@veyyon/kernel",
			"@veyyon/tui",
			"@veyyon/utils",
		]);
	});

	// (c) no bin key lost
	it("(c) no bin key lost from any workspace package", () => {
		const missingBins: Record<string, string[]> = {};

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			if (!headPkg) continue;

			const missing = basePkg.binKeys.filter(k => !headPkg.binKeys.includes(k));
			if (missing.length > 0) {
				missingBins[name] = missing;
			}
		}

		expect(missingBins).toEqual({});
	});

	// (d) no named barrel export lost
	it("(d) no named barrel export lost from any entrypoint", () => {
		const missingNamedExports: Record<string, string[]> = {};

		for (const [name, basePkg] of Object.entries(LEDGER.packages)) {
			const headPkg = HEAD_PACKAGES.get(name);
			if (!headPkg) continue;

			const missing = basePkg.namedExports.filter(k => !headPkg.namedExports.includes(k));
			if (missing.length > 0) {
				missingNamedExports[name] = missing;
			}
		}

		expect(missingNamedExports).toEqual({});
	});

	// (e) every star edge resolves
	it("(e) every star export edge resolves to a file on disk", () => {
		const unresolvedStarEdges: Array<{ package: string; star: string; fromFile: string }> = [];
		let totalTestedStarEdges = 0;

		for (const [name, headPkg] of HEAD_PACKAGES.entries()) {
			if (!headPkg.entrypointFilePath) continue;

			for (const star of headPkg.starEdges) {
				totalTestedStarEdges++;
				const resolved = resolveStarExportOnDisk(headPkg.entrypointFilePath, star);
				if (!resolved) {
					unresolvedStarEdges.push({
						package: name,
						star,
						fromFile: headPkg.entrypointFilePath,
					});
				}
			}
		}

		expect(unresolvedStarEdges).toEqual([]);
		expect(totalTestedStarEdges).toBeGreaterThan(200);
	});

	// (f) additions pinned by exact equality
	it("(f) additions pinned by exact equality", () => {
		const baseNames = new Set(Object.keys(LEDGER.packages));
		const actualAddedPackages = [...HEAD_PACKAGES.keys()].filter(name => !baseNames.has(name)).sort();
		expect(actualAddedPackages).toEqual([...LEDGER.additions.packages].sort());

		const actualAddedExportsKeys: Record<string, string[]> = {};
		for (const [name, headPkg] of HEAD_PACKAGES.entries()) {
			const basePkg = LEDGER.packages[name];
			if (!basePkg) continue;

			const added = headPkg.exportsKeys.filter(k => !basePkg.exportsKeys.includes(k)).sort();
			if (added.length > 0) {
				actualAddedExportsKeys[name] = added;
			}
		}

		expect(actualAddedExportsKeys).toEqual(LEDGER.additions.exportsKeys as Record<string, string[]>);
	});

	// (g) anti-vacuity
	it("(g) anti-vacuity: sweeps real members, asserts core packages, and trips on simulated loss", () => {
		// Minimum package count threshold
		expect(HEAD_PACKAGES.size).toBeGreaterThan(15);
		expect(Object.keys(LEDGER.packages).length).toBeGreaterThan(15);

		// Assert at least one export from @veyyon/tui, @veyyon/utils, and @veyyon/coding-agent
		const tuiPkg = HEAD_PACKAGES.get("@veyyon/tui");
		expect(tuiPkg).toBeDefined();
		expect(tuiPkg?.starEdges).toContain("./components/box");
		expect(tuiPkg?.starEdges).toContain("./tui");

		const utilsPkg = HEAD_PACKAGES.get("@veyyon/utils");
		expect(utilsPkg).toBeDefined();
		expect(utilsPkg?.namedExports).toContain("logger");
		expect(utilsPkg?.starEdges).toContain("./byte-truncate");

		const codingAgentPkg = HEAD_PACKAGES.get("@veyyon/coding-agent");
		expect(codingAgentPkg).toBeDefined();
		expect(codingAgentPkg?.namedExports).toContain("VERSION");
		expect(codingAgentPkg?.namedExports).toContain("logger");
		expect(codingAgentPkg?.starEdges).toContain("./session/agent-session");

		// Positive control: simulated loss of an export in an in-memory baseline fails the check
		const syntheticMissingName = "FAKE_DROPPED_EXPORT";
		const syntheticBase = {
			...LEDGER.packages["@veyyon/utils"],
			namedExports: [...(LEDGER.packages["@veyyon/utils"]?.namedExports ?? []), syntheticMissingName],
		};

		const testHeadExports = utilsPkg?.namedExports ?? [];
		const detectedLoss = syntheticBase.namedExports.filter(name => !testHeadExports.includes(name));
		expect(detectedLoss).toContain(syntheticMissingName);
	});
});
