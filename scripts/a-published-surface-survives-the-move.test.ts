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
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import type { PublishedSurfaceLedger } from "./measure-published-surface.ts";
import { REPO_ROOT, typeScriptMembers } from "./workspace-layout.ts";

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
	readonly entrypoint: string | null;
	readonly entrypointFilePath: string | null;
	readonly namedExports: readonly string[];
	readonly starEdges: readonly string[];
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

function resolveStarExportOnDisk(fromFile: string, specifier: string): string | null {
	const dir = dirname(fromFile);
	const candidates = [
		resolve(dir, specifier),
		resolve(dir, `${specifier}.ts`),
		resolve(dir, `${specifier}.tsx`),
		resolve(dir, `${specifier}.d.ts`),
		resolve(dir, `${specifier}.js`),
		resolve(dir, specifier, "index.ts"),
		resolve(dir, specifier, "index.tsx"),
		resolve(dir, specifier, "index.d.ts"),
		resolve(dir, specifier, "index.js"),
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
