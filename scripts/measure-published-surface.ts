/**
 * Measure the published surface area (manifest identity, entrypoints, subpath exports,
 * and barrel export declarations) across all workspace packages from a base git ref,
 * and record additions and relocations on HEAD into the committed ledger fixture.
 *
 * WHY THIS SCRIPT EXISTS. Workspace reorganizations (such as PR #927 "Everything as a Plugin")
 * relocate packages across top-level directories, restructure subpath exports, and split barrels.
 * To guarantee that no consumer-visible package name, bin key, exports subpath, or barrel export
 * was dropped accidentally, this generator measures the baseline published surface on origin/main,
 * records it into `scripts/fixtures/published-surface.json`, and records all intentional additions
 * and relocations so the test suite can enforce exact parity without invoking git in CI.
 *
 * Run: bun scripts/measure-published-surface.ts
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
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

export interface PackageManifestRecord {
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
	readonly namedExports: readonly string[];
	readonly starEdges: readonly string[];
}

export interface AdditionsRecord {
	readonly packages: readonly string[];
	readonly exportsKeys: Readonly<Record<string, readonly string[]>>;
	readonly namedExports: Readonly<Record<string, readonly string[]>>;
	readonly starEdges: Readonly<Record<string, readonly string[]>>;
	readonly binKeys: Readonly<Record<string, readonly string[]>>;
}

/**
 * A published subpath that main served and this tree serves under another name.
 *
 * `to` is the successor key, which the suite resolves against the manifest: a relocation that names
 * nothing, or names a key nobody publishes, is a removal wearing a reason. `why` says what happened.
 */
export interface RelocationNote {
	readonly to: string;
	readonly why: string;
}

export interface RelocationsRecord {
	readonly exportsKeys: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	readonly starEdges: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface PublishedSurfaceLedger {
	readonly generatedFrom: string;
	readonly packages: Readonly<Record<string, PackageManifestRecord>>;
	readonly additions: AdditionsRecord;
	readonly relocations: RelocationsRecord;
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_PATH = join(REPO_ROOT, "scripts", "fixtures", "published-surface.json");

/** Extract git file text from a specific git ref. */
export function readGitFile(ref: string, relativePath: string): string | null {
	try {
		return execSync(`git show ${ref}:${relativePath}`, {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["pipe", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/** Resolve entrypoint string from package.json `exports["."]`, `main`, or `module`. */
export function resolveEntrypoint(pkgData: { exports?: unknown; main?: string; module?: string }): string | null {
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

function extractPatternIdentifiers(patternNode: Node | null | undefined, names: Set<string>): void {
	if (!patternNode) return;
	if (patternNode.type === "Identifier") {
		names.add((patternNode as Identifier).name);
	} else if (patternNode.type === "ObjectPattern") {
		const obj = patternNode as ObjectPattern;
		for (const prop of obj.properties) {
			if (prop.type === "ObjectProperty") {
				extractPatternIdentifiers(prop.value, names);
			} else if (prop.type === "RestElement") {
				extractPatternIdentifiers((prop as RestElement).argument, names);
			}
		}
	} else if (patternNode.type === "ArrayPattern") {
		const arr = patternNode as ArrayPattern;
		for (const el of arr.elements) {
			if (el) extractPatternIdentifiers(el, names);
		}
	} else if (patternNode.type === "RestElement") {
		extractPatternIdentifiers((patternNode as RestElement).argument, names);
	} else if (patternNode.type === "AssignmentPattern") {
		extractPatternIdentifiers((patternNode as AssignmentPattern).left, names);
	}
}

/** Parse a TypeScript or JavaScript barrel source code into named exports and star edges. */
export function parseBarrelSource(code: string): {
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
						extractPatternIdentifiers(d.id, namedExports);
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

/** Resolve a relative star export specifier (e.g. `./foo`) to an actual file on disk. */
export function resolveStarSpecifierToDisk(fromFile: string, specifier: string): string | null {
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

/** Discover workspace member package manifests from a git ref. */
export function discoverWorkspaceManifests(
	ref: string,
): Array<{ dir: string; manifestPath: string; data: Record<string, unknown> }> {
	const rootManifestRaw = readGitFile(ref, "package.json");
	if (!rootManifestRaw) throw new Error(`Could not read root package.json at ${ref}`);
	const rootManifest = JSON.parse(rootManifestRaw) as {
		workspaces?: { packages?: string[] };
	};
	const globs = rootManifest.workspaces?.packages ?? [];
	const allFiles = execSync(`git ls-tree -r --name-only ${ref}`, {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
	})
		.trim()
		.split("\n")
		.filter(Boolean);

	const manifests: Array<{ dir: string; manifestPath: string; data: Record<string, unknown> }> = [];
	for (const f of allFiles) {
		if (f.endsWith("/package.json") && f !== "package.json") {
			const d = f.slice(0, -"/package.json".length);
			let matched = false;
			for (const g of globs) {
				if (g.endsWith("/*")) {
					const prefix = g.slice(0, -2);
					if (d.startsWith(`${prefix}/`) && !d.slice(prefix.length + 1).includes("/")) {
						matched = true;
						break;
					}
				} else if (g === d) {
					matched = true;
					break;
				}
			}
			if (matched) {
				const content = readGitFile(ref, f);
				if (content) {
					manifests.push({
						dir: d,
						manifestPath: f,
						data: JSON.parse(content) as Record<string, unknown>,
					});
				}
			}
		}
	}

	return manifests.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Measure the published surface of a given git ref. */
export function measurePublishedSurface(ref: string): Record<string, PackageManifestRecord> {
	const workspaceManifests = discoverWorkspaceManifests(ref);
	const packages: Record<string, PackageManifestRecord> = {};

	for (const member of workspaceManifests) {
		const data = member.data;
		const name = typeof data.name === "string" ? data.name : member.dir;
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

		const entrypoint = resolveEntrypoint(data);
		let namedExports: string[] = [];
		let starEdges: string[] = [];

		if (entrypoint) {
			const entryRelative = entrypoint.replace(/^\.\//, "");
			const entryFilePath = posix.join(member.dir, entryRelative);
			const code = readGitFile(ref, entryFilePath);
			if (code) {
				const parsed = parseBarrelSource(code);
				namedExports = parsed.namedExports;
				starEdges = parsed.starEdges;
			}
		}

		packages[name] = {
			name,
			directory: member.dir,
			private: priv,
			version,
			main,
			module,
			types,
			binKeys,
			exportsKeys,
			entrypoint,
			namedExports,
			starEdges,
		};
	}

	return packages;
}

/** Generate the full differential ledger. */
export function generateLedger(baseRef = "origin/main", headRef = "HEAD"): PublishedSurfaceLedger {
	const basePackages = measurePublishedSurface(baseRef);
	const headPackages = measurePublishedSurface(headRef);

	const addedPackageNames = Object.keys(headPackages)
		.filter(name => !(name in basePackages))
		.sort();

	const addedExportsKeys: Record<string, string[]> = {};
	const addedNamedExports: Record<string, string[]> = {};
	const addedStarEdges: Record<string, string[]> = {};
	const addedBinKeys: Record<string, string[]> = {};

	for (const [name, headPkg] of Object.entries(headPackages)) {
		const basePkg = basePackages[name];
		if (!basePkg) continue;

		const addedExp = headPkg.exportsKeys.filter(k => !basePkg.exportsKeys.includes(k));
		if (addedExp.length > 0) addedExportsKeys[name] = [...addedExp].sort();

		const addedNamed = headPkg.namedExports.filter(k => !basePkg.namedExports.includes(k));
		if (addedNamed.length > 0) addedNamedExports[name] = [...addedNamed].sort();

		const addedStars = headPkg.starEdges.filter(k => !basePkg.starEdges.includes(k));
		if (addedStars.length > 0) addedStarEdges[name] = [...addedStars].sort();

		const addedBins = headPkg.binKeys.filter(k => !basePkg.binKeys.includes(k));
		if (addedBins.length > 0) addedBinKeys[name] = [...addedBins].sort();
	}

	const relocations: RelocationsRecord = {
		exportsKeys: {
			"@veyyon/coding-agent": {
				"./capability": {
					to: "./discovery/capability",
					why: "the same modules are published at ./discovery/capability after the move",
				},
				"./capability/*": {
					to: "./discovery/capability/*",
					why: "the same modules are published at ./discovery/capability/* after the move",
				},
				"./cli/commands/*": {
					to: "./cli/*",
					why: "the command dispatchers sit directly under src/cli/, which ./cli/* serves",
				},
				"./commit/git/*": {
					to: "./commit/*",
					why: "the git helpers sit directly under src/commit/, which ./commit/* serves",
				},
				"./dap": { to: "./debug/dap", why: "the same modules are published at ./debug/dap after the move" },
				"./dap/*": { to: "./debug/dap/*", why: "the same modules are published at ./debug/dap/* after the move" },
				"./hindsight": {
					to: "./memory/hindsight",
					why: "the same modules are published at ./memory/hindsight after the move",
				},
				"./hindsight/*": {
					to: "./memory/hindsight/*",
					why: "the same modules are published at ./memory/hindsight/* after the move",
				},
				"./markit": {
					to: "./export/markit",
					why: "the same modules are published at ./export/markit after the move",
				},
				"./markit/*": {
					to: "./export/markit/*",
					why: "the same modules are published at ./export/markit/* after the move",
				},
				"./memories": {
					to: "./memory/*",
					why: "the memory modules are flat under src/memory/, which ./memory/* serves",
				},
				"./memories/*": {
					to: "./memory/*",
					why: "the memory modules are flat under src/memory/, which ./memory/* serves",
				},
				"./memory-backend": {
					to: "./memory/*",
					why: "the backend modules are flat under src/memory/, which ./memory/* serves",
				},
				"./memory-backend/*": {
					to: "./memory/*",
					why: "the backend modules are flat under src/memory/, which ./memory/* serves",
				},
				"./modes/components": {
					to: "./modes/terminal/components",
					why: "the same modules are published at ./modes/terminal/components after the move",
				},
				"./modes/components/*": {
					to: "./modes/terminal/components/*",
					why: "the same modules are published at ./modes/terminal/components/* after the move",
				},
				"./modes/components/extensions": {
					to: "./modes/terminal/components/extensions",
					why: "the same modules are published at ./modes/terminal/components/extensions after the move",
				},
				"./modes/components/extensions/*": {
					to: "./modes/terminal/components/extensions/*",
					why: "the same modules are published at ./modes/terminal/components/extensions/* after the move",
				},
				"./modes/components/status-line": {
					to: "./modes/terminal/components/status-line",
					why: "the same modules are published at ./modes/terminal/components/status-line after the move",
				},
				"./modes/components/status-line/*": {
					to: "./modes/terminal/components/status-line/*",
					why: "the same modules are published at ./modes/terminal/components/status-line/* after the move",
				},
				"./modes/controllers/*": {
					to: "./modes/terminal/controllers/*",
					why: "the same modules are published at ./modes/terminal/controllers/* after the move",
				},
				"./modes/setup-wizard": {
					to: "./modes/terminal/setup-wizard",
					why: "the same modules are published at ./modes/terminal/setup-wizard after the move",
				},
				"./modes/setup-wizard/*": {
					to: "./modes/terminal/setup-wizard/*",
					why: "the same modules are published at ./modes/terminal/setup-wizard/* after the move",
				},
				"./modes/theme/*": { to: "./theme/*", why: "the same modules are published at ./theme/* after the move" },
				"./modes/theme/defaults": {
					to: "./theme/defaults",
					why: "the same modules are published at ./theme/defaults after the move",
				},
				"./modes/utils/*": {
					to: "./modes/terminal/utils/*",
					why: "the same modules are published at ./modes/terminal/utils/* after the move",
				},
				"./stt": { to: "./speech/stt", why: "the same modules are published at ./speech/stt after the move" },
				"./stt/*": { to: "./speech/stt/*", why: "the same modules are published at ./speech/stt/* after the move" },
				"./tool-discovery/*": {
					to: "./discovery/*",
					why: "the discovery modules are flat under src/discovery/, which ./discovery/* serves",
				},
			},
		},
		starEdges: {
			"@veyyon/coding-agent": {
				"./modes/components": "replaced by ./modes/terminal/components in decoupled TUI layout",
				"./modes/theme/theme": "replaced by ./theme/theme in decoupled theme layout",
			},
			"@veyyon/tui": {
				"./autocomplete": "string/math utilities moved to @veyyon/utils directly",
				"./deccara": "DECCARA optimization moved to @veyyon/utils directly",
				"./editor-component": "moved to ./components/editor-component",
				"./fuzzy": "fuzzy matching moved to @veyyon/utils directly",
				"./keybindings": "keybinding parser moved to @veyyon/utils directly",
				"./keys": "Kitty keyboard parser moved to @veyyon/utils directly",
				"./kitty-graphics": "Kitty graphics encoding moved to @veyyon/utils directly",
				"./latex-block": "LaTeX block parsing moved to @veyyon/utils directly",
				"./latex-to-unicode": "LaTeX unicode conversion moved to @veyyon/utils directly",
				"./motion": "motion curves moved to @veyyon/utils directly",
				"./motion-grow": "motion animation curves moved to @veyyon/utils directly",
				"./motion-hover": "motion hover curves moved to @veyyon/utils directly",
				"./motion-paint": "motion painting moved to @veyyon/utils directly",
				"./motion-settle": "motion settle curves moved to @veyyon/utils directly",
				"./mouse": "mouse event decoding moved to @veyyon/utils directly",
				"./paint-columns": "column painting moved to @veyyon/utils directly",
				"./paint-ground": "background fill math moved to @veyyon/utils directly",
				"./paint-surface": "surface painting moved to @veyyon/utils directly",
				"./sub-cell-bar": "sub-cell rendering moved to @veyyon/utils directly",
				"./symbols": "symbol tables moved to @veyyon/utils directly",
				"./ttyid": "terminal ID queries moved to @veyyon/utils directly",
				"./utils": "shared TUI utilities moved to @veyyon/utils directly",
			},
		},
	};

	// The commit, not the ref that named it: `origin/main` moves and a stamped ref name cannot say
	// which tree the rows were measured against.
	const baseSha = execSync(`git rev-parse ${baseRef}`, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();

	return {
		generatedFrom: baseSha,
		packages: basePackages,
		additions: {
			packages: addedPackageNames,
			exportsKeys: addedExportsKeys,
			namedExports: addedNamedExports,
			starEdges: addedStarEdges,
			binKeys: addedBinKeys,
		},
		relocations,
	};
}

/** Main execution function when run directly. */
export function main(): void {
	const ledger = generateLedger("origin/main", "HEAD");
	mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
	writeFileSync(FIXTURE_PATH, `${JSON.stringify(ledger, null, "\t")}\n`, "utf-8");
	process.stdout.write(
		`Wrote the published-surface ledger for ${Object.keys(ledger.packages).length} packages to ${FIXTURE_PATH}\n`,
	);
}

if (import.meta.main || process.argv[1]?.endsWith("measure-published-surface.ts")) {
	main();
}
