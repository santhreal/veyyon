/**
 * Measure the published surface area (manifest identity, entrypoints, subpath exports,
 * and barrel exports) across git revisions and workspace members.
 *
 * All baseline package records are measured dynamically from the pinned Git baseline commit
 * (`aa14e0da82494dac5a06d240180cec88038a105f`) in batched reads via `scripts/git-baseline.ts`.
 * The sparse approval fixture records approved additions, documented key relocations,
 * resolved subpaths, and star-edge relocations under schema version 2.
 *
 * Run: bun scripts/measure-published-surface.ts [base-ref] [head-ref]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { existingOnly } from "./check-doc-links";
import {
	batchReadGitBlobs,
	ensureBaselineAvailable,
	PINNED_BASELINE_COMMIT,
	REPO_ROOT,
	readGitTree,
} from "./git-baseline";
import { typeScriptMembersOf } from "./workspace-layout";

export const PUBLISHED_SURFACE_SCHEMA_VERSION = 2;

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
	readonly resolvedSubpaths: readonly string[];
	readonly entrypoint: string | null;
	readonly namedExports: readonly string[];
	readonly starEdges: readonly string[];
}

export interface PackageAddedResolvedSubpaths {
	readonly subpaths?: readonly string[];
	readonly pairedJsSubpaths?: readonly string[];
}

export type RawPackageAddedResolvedSubpaths = readonly string[] | PackageAddedResolvedSubpaths;

export interface AdditionsRecord {
	readonly packages: readonly string[];
	readonly exportsKeys: Readonly<Record<string, readonly string[]>>;
	readonly resolvedSubpaths: Readonly<Record<string, readonly string[]>>;
	readonly namedExports: Readonly<Record<string, readonly string[]>>;
	readonly starEdges: Readonly<Record<string, readonly string[]>>;
	readonly binKeys: Readonly<Record<string, readonly string[]>>;
}

export interface AdditionsApprovalRecord {
	readonly packages: readonly string[];
	readonly exportsKeys: Readonly<Record<string, readonly string[]>>;
	readonly resolvedSubpaths: Readonly<Record<string, RawPackageAddedResolvedSubpaths>>;
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

export interface PackageResolvedSubpathsRelocations {
	readonly records: Readonly<Record<string, RelocationNote>>;
	readonly jsAliases?: {
		readonly suffixReason?: readonly string[];
		readonly sameReason?: readonly string[];
	};
}

export type RawPackageResolvedSubpathsRelocations =
	| Readonly<Record<string, RelocationNote>>
	| PackageResolvedSubpathsRelocations;

export interface RelocationsRecord {
	readonly exportsKeys: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	/**
	 * A resolved subpath main served that this tree serves elsewhere. `to` is either a subpath of the
	 * same package (`./discovery/capability/fs`) or a package-qualified specifier
	 * (`@veyyon/kernel/session/session-entries`) when the module left the package entirely.
	 */
	readonly resolvedSubpaths: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	readonly starEdges: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface RelocationsApprovalRecord {
	readonly exportsKeys: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
	readonly resolvedSubpaths: Readonly<Record<string, RawPackageResolvedSubpathsRelocations>>;
	readonly starEdges: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface PublishedSurfaceLedger {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly packages: Readonly<Record<string, PackageManifestRecord>>;
	readonly additions: AdditionsRecord;
	readonly relocations: RelocationsRecord;
}

export interface PublishedSurfaceApprovalLedger {
	readonly schemaVersion: number;
	readonly generatedFrom: string;
	readonly additions: AdditionsApprovalRecord;
	readonly relocations: RelocationsApprovalRecord;
}

export interface WorkspacePackageSnapshot {
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

export const FIXTURE_PATH = join(REPO_ROOT, "scripts", "fixtures", "published-surface.json");

/**
 * Every file under one member, repository-relative.
 */
export function filesUnderMember(member: string, repoRoot: string = REPO_ROOT): string[] {
	let stdout: Buffer;
	try {
		stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", member], {
			cwd: repoRoot,
			encoding: "buffer",
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		throw new Error(
			`Failed to enumerate files under "${member}" via git ls-files at ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const raw = stdout.toString("utf-8");
	if (raw.length === 0) return [];
	return existingOnly(
		repoRoot,
		raw.split("\0").filter(entry => entry.length > 0),
	).filter(entry => statSync(join(repoRoot, entry)).isFile());
}

/** The file an `exports` condition object or string points at, preferring what an importer resolves. */
export function exportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const condition of ["import", "types", "default", "require"]) {
		const candidate = record[condition];
		if (typeof candidate === "string") return candidate;
		if (candidate !== null && typeof candidate === "object") {
			const nested = exportTarget(candidate);
			if (nested !== null) return nested;
		}
	}
	return null;
}

/**
 * Every subpath a consumer can import from one package, with each `exports` pattern expanded against
 * the files that exist beside it.
 */
export function expandExportsToFileMap(
	exportsField: unknown,
	packageDir: string,
	files: readonly string[],
): Map<string, string> {
	const resolved = new Map<string, string>();
	if (typeof exportsField === "string") {
		resolved.set(".", posix.join(packageDir, exportsField.replace(/^\.\//, "")));
		return resolved;
	}
	if (exportsField === null || typeof exportsField !== "object") return resolved;
	const prefix = `${packageDir}/`;
	const inPackage = files.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length));

	for (const [key, value] of Object.entries(exportsField as Record<string, unknown>)) {
		const target = exportTarget(value);
		if (target === null) continue;
		const cleaned = target.replace(/^\.\//, "");
		if (!key.includes("*")) {
			if (!cleaned.includes("*") && inPackage.includes(cleaned)) resolved.set(key, prefix + cleaned);
			continue;
		}
		const star = cleaned.indexOf("*");
		if (star < 0) continue;
		const head = cleaned.slice(0, star);
		const tail = cleaned.slice(star + 1);
		for (const file of inPackage) {
			if (!file.startsWith(head) || !file.endsWith(tail)) continue;
			const middle = file.slice(head.length, file.length - tail.length);
			if (middle.length === 0) continue;
			resolved.set(key.replace("*", middle), prefix + file);
		}
	}

	return resolved;
}

/** The subpaths of {@link expandExportsToFileMap}, which is the one expansion both answers come from. */
export function expandExportsToSubpaths(exportsField: unknown, packageDir: string, files: readonly string[]): string[] {
	return [...expandExportsToFileMap(exportsField, packageDir, files).keys()].sort();
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

export function extractPatternIdentifiers(patternNode: Node | null | undefined, names: Set<string>): void {
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
			starEdges.add(node.source.value);
		}
	}

	return {
		namedExports: [...namedExports].sort(),
		starEdges: [...starEdges].sort(),
	};
}

let workspaceDirectoriesByRepo: Map<string, Map<string, string>> | undefined;

export function memberDirectoryOf(packageName: string, repoRoot: string = REPO_ROOT): string | undefined {
	if (workspaceDirectoriesByRepo === undefined) {
		workspaceDirectoriesByRepo = new Map();
	}
	let dirs = workspaceDirectoriesByRepo.get(repoRoot);
	if (dirs === undefined) {
		dirs = new Map();
		for (const member of typeScriptMembersOf(repoRoot)) {
			const manifestPath = join(repoRoot, member, "package.json");
			if (!existsSync(manifestPath)) continue;
			const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown };
			if (typeof data.name === "string") dirs.set(data.name, join(repoRoot, member));
		}
		workspaceDirectoriesByRepo.set(repoRoot, dirs);
	}
	return dirs.get(packageName);
}

/** Resolve a star export specifier (e.g. `./foo` or `@veyyon/kernel/session/...`) to an actual file on disk. */
export function resolveStarSpecifierToDisk(
	fromFile: string,
	specifier: string,
	repoRoot: string = REPO_ROOT,
): string | null {
	let base = dirname(fromFile);
	let body = specifier;
	if (!specifier.startsWith(".")) {
		const scoped = specifier.startsWith("@");
		const parts = specifier.split("/");
		const packageName = scoped ? parts.slice(0, 2).join("/") : parts[0];
		const rest = parts.slice(scoped ? 2 : 1).join("/");
		const memberDir = packageName === undefined ? undefined : memberDirectoryOf(packageName, repoRoot);
		if (memberDir === undefined) return null;
		base = existsSync(join(memberDir, "src")) ? join(memberDir, "src") : memberDir;
		body = (rest === "" ? "index" : rest).replace(/\.js$/, "");
	}
	const dir = base;
	const cleanBody = body.replace(/\.js$/, "");
	const candidates = [
		resolve(dir, body),
		resolve(dir, cleanBody),
		resolve(dir, `${cleanBody}.ts`),
		resolve(dir, `${cleanBody}.tsx`),
		resolve(dir, `${cleanBody}.d.ts`),
		resolve(dir, `${cleanBody}.js`),
		resolve(dir, cleanBody, "index.ts"),
		resolve(dir, cleanBody, "index.tsx"),
		resolve(dir, cleanBody, "index.d.ts"),
		resolve(dir, cleanBody, "index.js"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return null;
}

/**
 * Measure the published surface of a given git ref using batched Git blob reading.
 */
export async function measurePublishedSurface(
	ref: string,
	repoRoot: string = REPO_ROOT,
): Promise<Record<string, PackageManifestRecord>> {
	ensureBaselineAvailable(repoRoot, ref);
	const tree = readGitTree(ref, repoRoot);
	const allFiles = [...tree.keys()];

	// 1. Discover all candidate package.json files
	const candidateManifestPaths = allFiles.filter(f => f.endsWith("/package.json") && f !== "package.json");

	// 2. Batch read root package.json + all candidate manifests
	const manifestSpecs = ["package.json", ...candidateManifestPaths].map(p => `${ref}:${p}`);
	const manifestBlobs = await batchReadGitBlobs(manifestSpecs, repoRoot);

	const rootManifestBuffer = manifestBlobs.get(`${ref}:package.json`);
	if (!rootManifestBuffer) {
		throw new Error(`Could not read root package.json at ${ref}`);
	}
	const rootManifest = JSON.parse(rootManifestBuffer.toString("utf-8")) as {
		workspaces?: { packages?: string[] } | string[];
	};
	const globs = Array.isArray(rootManifest.workspaces)
		? rootManifest.workspaces
		: (rootManifest.workspaces?.packages ?? []);

	// Filter matched manifests
	const matchedManifests: Array<{ dir: string; manifestPath: string; data: Record<string, unknown> }> = [];
	for (const f of candidateManifestPaths) {
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
			const buf = manifestBlobs.get(`${ref}:${f}`);
			if (buf) {
				matchedManifests.push({
					dir: d,
					manifestPath: f,
					data: JSON.parse(buf.toString("utf-8")) as Record<string, unknown>,
				});
			}
		}
	}
	matchedManifests.sort((a, b) => a.dir.localeCompare(b.dir));

	// 3. Collect entrypoint file paths to batch read
	const entrypointSpecs: string[] = [];
	const memberEntrypoints: Map<string, string> = new Map();
	for (const member of matchedManifests) {
		const entry = resolveEntrypoint(member.data);
		if (entry) {
			const entryRelative = entry.replace(/^\.\//, "");
			const entryFilePath = posix.join(member.dir, entryRelative);
			if (tree.has(entryFilePath)) {
				entrypointSpecs.push(`${ref}:${entryFilePath}`);
				memberEntrypoints.set(member.dir, entryFilePath);
			}
		}
	}

	// 4. Batch read all entrypoints
	const entryBlobs = await batchReadGitBlobs(entrypointSpecs, repoRoot);

	// 5. Construct PackageManifestRecord for each workspace package
	const packages: Record<string, PackageManifestRecord> = {};
	for (const member of matchedManifests) {
		const data = member.data;
		const name = typeof data.name === "string" ? data.name : member.dir;
		const priv = Boolean(data.private);
		const version = typeof data.version === "string" ? data.version : null;
		const main = typeof data.main === "string" ? data.main : null;
		const module = typeof data.module === "string" ? data.module : null;
		const types = typeof data.types === "string" ? data.types : null;

		const binKeys =
			typeof data.bin === "object" && data.bin !== null && !Array.isArray(data.bin)
				? Object.keys(data.bin as Record<string, unknown>).sort()
				: typeof data.bin === "string"
					? [name.split("/").pop() ?? name]
					: [];

		const exportsKeys =
			typeof data.exports === "object" && data.exports !== null && !Array.isArray(data.exports)
				? Object.keys(data.exports as Record<string, unknown>).sort()
				: typeof data.exports === "string"
					? ["."]
					: [];
		const resolvedSubpaths = expandExportsToSubpaths(data.exports, member.dir, allFiles);

		const entrypoint = resolveEntrypoint(data);
		let namedExports: string[] = [];
		let starEdges: string[] = [];

		const entryFilePath = memberEntrypoints.get(member.dir);
		if (entryFilePath) {
			const buf = entryBlobs.get(`${ref}:${entryFilePath}`);
			if (buf) {
				const parsed = parseBarrelSource(buf.toString("utf-8"));
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
			resolvedSubpaths,
			entrypoint,
			namedExports,
			starEdges,
		};
	}

	return packages;
}

export function loadHeadPackages(repoRoot: string = REPO_ROOT): Map<string, WorkspacePackageSnapshot> {
	const members = typeScriptMembersOf(repoRoot);
	const packages = new Map<string, WorkspacePackageSnapshot>();

	for (const member of members) {
		const manifestPath = join(repoRoot, member, "package.json");
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
			typeof data.bin === "object" && data.bin !== null && !Array.isArray(data.bin)
				? Object.keys(data.bin as Record<string, unknown>).sort()
				: typeof data.bin === "string"
					? [name.split("/").pop() ?? name]
					: [];

		const exportsKeys =
			typeof data.exports === "object" && data.exports !== null && !Array.isArray(data.exports)
				? Object.keys(data.exports as Record<string, unknown>).sort()
				: typeof data.exports === "string"
					? ["."]
					: [];

		const resolvedSubpaths = expandExportsToSubpaths(data.exports, member, filesUnderMember(member, repoRoot));

		const entrypoint = resolveEntrypoint(data);
		let namedExports: string[] = [];
		let starEdges: string[] = [];
		let entrypointFilePath: string | null = null;

		if (entrypoint) {
			const entryRelative = entrypoint.replace(/^\.\//, "");
			const resolvedPath = resolve(repoRoot, member, entryRelative);
			if (existsSync(resolvedPath)) {
				entrypointFilePath = resolvedPath;
				const code = readFileSync(resolvedPath, "utf-8");
				const parsed = parseBarrelSource(code);
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

const REASON_RULES = [
	{ key: "suffixReason" as const, transform: (why: string) => `${why}.js` },
	{ key: "sameReason" as const, transform: (why: string) => why },
] as const;

export function expandResolvedSubpathsRecord(
	rawPkgRelocations: RawPackageResolvedSubpathsRelocations,
	pkgName: string,
): Record<string, RelocationNote> {
	if (rawPkgRelocations === null || typeof rawPkgRelocations !== "object" || Array.isArray(rawPkgRelocations)) {
		throw new Error(`Resolved subpaths relocations for package "${pkgName}" must be an object`);
	}

	if ("records" in rawPkgRelocations || "jsAliases" in rawPkgRelocations) {
		if (
			!("records" in rawPkgRelocations) ||
			typeof rawPkgRelocations.records !== "object" ||
			rawPkgRelocations.records === null ||
			Array.isArray(rawPkgRelocations.records)
		) {
			throw new Error(`Resolved subpaths relocations for package "${pkgName}" is missing valid "records" object`);
		}

		const rawRecords = rawPkgRelocations.records as Record<string, unknown>;
		const expanded: Record<string, RelocationNote> = {};
		for (const [key, val] of Object.entries(rawRecords)) {
			if (
				val === null ||
				typeof val !== "object" ||
				Array.isArray(val) ||
				typeof (val as RelocationNote).to !== "string" ||
				typeof (val as RelocationNote).why !== "string"
			) {
				throw new Error(
					`Invalid relocation record for "${key}" in package "${pkgName}": must have string "to" and "why"`,
				);
			}
			expanded[key] = { to: (val as RelocationNote).to, why: (val as RelocationNote).why };
		}

		if ("jsAliases" in rawPkgRelocations) {
			if (
				rawPkgRelocations.jsAliases === null ||
				typeof rawPkgRelocations.jsAliases !== "object" ||
				Array.isArray(rawPkgRelocations.jsAliases)
			) {
				throw new Error(`jsAliases in package "${pkgName}" must be an object`);
			}
			const jsAliases = rawPkgRelocations.jsAliases as Record<string, unknown>;
			for (const key of Object.keys(jsAliases)) {
				if (key !== "suffixReason" && key !== "sameReason") {
					throw new Error(`Unknown key "${key}" in jsAliases for package "${pkgName}"`);
				}
			}
			const seenAliases = new Set<string>();

			for (const rule of REASON_RULES) {
				const list = jsAliases[rule.key];
				if (list === undefined) continue;
				if (!Array.isArray(list)) {
					throw new Error(`jsAliases.${rule.key} in package "${pkgName}" must be an array`);
				}
				for (const baseKey of list) {
					if (typeof baseKey !== "string") {
						throw new Error(`jsAliases.${rule.key} in package "${pkgName}" must contain only strings`);
					}
					if (seenAliases.has(baseKey)) {
						throw new Error(`Duplicate alias membership for "${baseKey}" in package "${pkgName}"`);
					}
					seenAliases.add(baseKey);
					const base = expanded[baseKey];
					if (!base) {
						throw new Error(`Missing base record for alias "${baseKey}" in package "${pkgName}"`);
					}
					const aliasKey = `${baseKey}.js`;
					if (aliasKey in rawRecords) {
						throw new Error(
							`Collision: alias "${aliasKey}" is already present in explicit records for package "${pkgName}"`,
						);
					}
					expanded[aliasKey] = {
						to: `${base.to}.js`,
						why: rule.transform(base.why),
					};
				}
			}
		}

		for (const key of Object.keys(rawPkgRelocations)) {
			if (key !== "records" && key !== "jsAliases") {
				throw new Error(`Unknown property "${key}" in resolved subpaths relocations for package "${pkgName}"`);
			}
		}

		return expanded;
	}

	// Plain record map
	const plainMap = rawPkgRelocations as Record<string, unknown>;
	const expanded: Record<string, RelocationNote> = {};
	for (const [key, val] of Object.entries(plainMap)) {
		if (
			val === null ||
			typeof val !== "object" ||
			Array.isArray(val) ||
			typeof (val as RelocationNote).to !== "string" ||
			typeof (val as RelocationNote).why !== "string"
		) {
			throw new Error(
				`Invalid relocation record for "${key}" in package "${pkgName}": must have string "to" and "why"`,
			);
		}
		expanded[key] = { to: (val as RelocationNote).to, why: (val as RelocationNote).why };
	}
	return expanded;
}

export function normalizeResolvedSubpathsRecord(
	rawMap: Record<string, RelocationNote>,
): PackageResolvedSubpathsRelocations | Record<string, RelocationNote> {
	const records: Record<string, RelocationNote> = {};
	const jsAliases: {
		suffixReason: string[];
		sameReason: string[];
	} = {
		suffixReason: [],
		sameReason: [],
	};

	const keys = Object.keys(rawMap).sort();
	const normalizedJsKeys = new Set<string>();

	for (const jsKey of keys) {
		if (!jsKey.endsWith(".js")) continue;
		const baseKey = jsKey.slice(0, -3);
		const jsRecord = rawMap[jsKey];
		const baseRecord = rawMap[baseKey];
		if (!baseRecord) continue;
		if (jsRecord.to !== `${baseRecord.to}.js`) continue;

		if (jsRecord.why === `${baseRecord.why}.js`) {
			jsAliases.suffixReason.push(baseKey);
			normalizedJsKeys.add(jsKey);
		} else if (jsRecord.why === baseRecord.why) {
			jsAliases.sameReason.push(baseKey);
			normalizedJsKeys.add(jsKey);
		}
	}

	if (normalizedJsKeys.size === 0) {
		return rawMap;
	}

	jsAliases.suffixReason.sort();
	jsAliases.sameReason.sort();

	for (const k of keys) {
		if (!normalizedJsKeys.has(k)) {
			records[k] = rawMap[k];
		}
	}

	const result: PackageResolvedSubpathsRelocations = {
		records,
		...(jsAliases.suffixReason.length > 0 || jsAliases.sameReason.length > 0
			? {
					jsAliases: {
						...(jsAliases.suffixReason.length > 0 ? { suffixReason: jsAliases.suffixReason } : {}),
						...(jsAliases.sameReason.length > 0 ? { sameReason: jsAliases.sameReason } : {}),
					},
				}
			: {}),
	};

	return result;
}
export function expandAddedResolvedSubpaths(rawPkgAdded: RawPackageAddedResolvedSubpaths, pkgName: string): string[] {
	if (Array.isArray(rawPkgAdded)) {
		const seen = new Set<string>();
		for (const item of rawPkgAdded) {
			if (typeof item !== "string") {
				throw new Error(`Invalid item in added resolvedSubpaths for package "${pkgName}": must be a string`);
			}
			if (seen.has(item)) {
				throw new Error(`Duplicate subpath "${item}" in added resolvedSubpaths for package "${pkgName}"`);
			}
			seen.add(item);
		}
		return [...rawPkgAdded].sort();
	}

	if (rawPkgAdded !== null && typeof rawPkgAdded === "object") {
		for (const key of Object.keys(rawPkgAdded)) {
			if (key !== "subpaths" && key !== "pairedJsSubpaths") {
				throw new Error(`Unknown property "${key}" in added resolvedSubpaths for package "${pkgName}"`);
			}
		}
		const subpaths = (rawPkgAdded as PackageAddedResolvedSubpaths).subpaths ?? [];
		const paired = (rawPkgAdded as PackageAddedResolvedSubpaths).pairedJsSubpaths ?? [];

		if (!Array.isArray(subpaths)) {
			throw new Error(`Added resolvedSubpaths.subpaths for package "${pkgName}" must be an array`);
		}
		if (!Array.isArray(paired)) {
			throw new Error(`Added resolvedSubpaths.pairedJsSubpaths for package "${pkgName}" must be an array`);
		}

		const seenExplicit = new Set<string>();
		for (const item of subpaths) {
			if (typeof item !== "string") {
				throw new Error(`Invalid subpath in added resolvedSubpaths for package "${pkgName}": must be a string`);
			}
			if (seenExplicit.has(item)) {
				throw new Error(`Duplicate explicit subpath "${item}" in added resolvedSubpaths for package "${pkgName}"`);
			}
			seenExplicit.add(item);
		}

		const expanded: string[] = [...subpaths];
		const seenPaired = new Set<string>();

		for (const base of paired) {
			if (typeof base !== "string") {
				throw new Error(
					`Invalid base in added resolvedSubpaths.pairedJsSubpaths for package "${pkgName}": must be a string`,
				);
			}
			if (seenPaired.has(base)) {
				throw new Error(`Duplicate paired base "${base}" in added resolvedSubpaths for package "${pkgName}"`);
			}
			seenPaired.add(base);

			const jsKey = `${base}.js`;
			if (seenExplicit.has(base)) {
				throw new Error(
					`Collision: base "${base}" is in both subpaths and pairedJsSubpaths for package "${pkgName}"`,
				);
			}
			if (seenExplicit.has(jsKey)) {
				throw new Error(
					`Collision: alias "${jsKey}" is in explicit subpaths while base is in pairedJsSubpaths for package "${pkgName}"`,
				);
			}

			expanded.push(base);
			expanded.push(jsKey);
		}

		return expanded.sort();
	}

	throw new Error(`Invalid added resolvedSubpaths entry for package "${pkgName}"`);
}

export function normalizeAddedResolvedSubpaths(rawList: readonly string[]): RawPackageAddedResolvedSubpaths {
	const rawSet = new Set<string>(rawList);
	const pairedJsSubpaths: string[] = [];
	const consumed = new Set<string>();

	for (const item of rawList) {
		if (item.endsWith(".js")) continue;
		const jsSibling = `${item}.js`;
		if (rawSet.has(jsSibling)) {
			pairedJsSubpaths.push(item);
			consumed.add(item);
			consumed.add(jsSibling);
		}
	}

	const subpaths = rawList.filter(item => !consumed.has(item)).sort();
	pairedJsSubpaths.sort();

	if (pairedJsSubpaths.length === 0) {
		return subpaths;
	}

	const result: PackageAddedResolvedSubpaths = {
		...(subpaths.length > 0 ? { subpaths } : {}),
		...(pairedJsSubpaths.length > 0 ? { pairedJsSubpaths } : {}),
	};
	return result;
}

export function validatePublishedSurfaceLedger(raw: unknown): PublishedSurfaceApprovalLedger {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Published surface ledger is not an object");
	}
	const ledger = raw as Partial<PublishedSurfaceApprovalLedger>;
	if (typeof ledger.schemaVersion !== "number" || ledger.schemaVersion !== PUBLISHED_SURFACE_SCHEMA_VERSION) {
		throw new Error(
			`Published surface ledger schema is stale or unversioned (expected version ${PUBLISHED_SURFACE_SCHEMA_VERSION}, got ${ledger.schemaVersion ?? "unversioned v1"})`,
		);
	}
	if (typeof ledger.generatedFrom !== "string" || ledger.generatedFrom !== PINNED_BASELINE_COMMIT) {
		throw new Error(
			`Published surface ledger generatedFrom commit mismatch: expected pinned baseline ${PINNED_BASELINE_COMMIT}, got ${ledger.generatedFrom ?? "missing"}`,
		);
	}
	if (!ledger.additions || typeof ledger.additions !== "object" || Array.isArray(ledger.additions)) {
		throw new Error("Published surface ledger is missing additions record");
	}
	if (!Array.isArray(ledger.additions.packages)) {
		throw new Error("Published surface ledger additions.packages must be an array");
	}
	for (const pkg of ledger.additions.packages) {
		if (typeof pkg !== "string") {
			throw new Error("Published surface ledger additions.packages elements must be strings");
		}
	}
	if (
		!ledger.additions.exportsKeys ||
		typeof ledger.additions.exportsKeys !== "object" ||
		Array.isArray(ledger.additions.exportsKeys)
	) {
		throw new Error("Published surface ledger additions.exportsKeys must be an object");
	}
	for (const [pkg, keys] of Object.entries(ledger.additions.exportsKeys)) {
		if (!Array.isArray(keys)) {
			throw new Error(`Published surface ledger additions.exportsKeys["${pkg}"] must be an array`);
		}
		for (const key of keys) {
			if (typeof key !== "string") {
				throw new Error(`Published surface ledger additions.exportsKeys["${pkg}"] elements must be strings`);
			}
		}
	}
	if (
		!ledger.additions.resolvedSubpaths ||
		typeof ledger.additions.resolvedSubpaths !== "object" ||
		Array.isArray(ledger.additions.resolvedSubpaths)
	) {
		throw new Error("Published surface ledger additions.resolvedSubpaths must be an object");
	}
	for (const [pkgName, pkgAdded] of Object.entries(ledger.additions.resolvedSubpaths)) {
		expandAddedResolvedSubpaths(pkgAdded as RawPackageAddedResolvedSubpaths, pkgName);
	}
	if (
		!ledger.additions.namedExports ||
		typeof ledger.additions.namedExports !== "object" ||
		Array.isArray(ledger.additions.namedExports)
	) {
		throw new Error("Published surface ledger additions.namedExports must be an object");
	}
	for (const [pkg, keys] of Object.entries(ledger.additions.namedExports)) {
		if (!Array.isArray(keys)) {
			throw new Error(`Published surface ledger additions.namedExports["${pkg}"] must be an array`);
		}
		for (const key of keys) {
			if (typeof key !== "string") {
				throw new Error(`Published surface ledger additions.namedExports["${pkg}"] elements must be strings`);
			}
		}
	}
	if (
		!ledger.additions.starEdges ||
		typeof ledger.additions.starEdges !== "object" ||
		Array.isArray(ledger.additions.starEdges)
	) {
		throw new Error("Published surface ledger additions.starEdges must be an object");
	}
	for (const [pkg, keys] of Object.entries(ledger.additions.starEdges)) {
		if (!Array.isArray(keys)) {
			throw new Error(`Published surface ledger additions.starEdges["${pkg}"] must be an array`);
		}
		for (const key of keys) {
			if (typeof key !== "string") {
				throw new Error(`Published surface ledger additions.starEdges["${pkg}"] elements must be strings`);
			}
		}
	}
	if (
		!ledger.additions.binKeys ||
		typeof ledger.additions.binKeys !== "object" ||
		Array.isArray(ledger.additions.binKeys)
	) {
		throw new Error("Published surface ledger additions.binKeys must be an object");
	}
	for (const [pkg, keys] of Object.entries(ledger.additions.binKeys)) {
		if (!Array.isArray(keys)) {
			throw new Error(`Published surface ledger additions.binKeys["${pkg}"] must be an array`);
		}
		for (const key of keys) {
			if (typeof key !== "string") {
				throw new Error(`Published surface ledger additions.binKeys["${pkg}"] elements must be strings`);
			}
		}
	}
	if (!ledger.relocations || typeof ledger.relocations !== "object" || Array.isArray(ledger.relocations)) {
		throw new Error("Published surface ledger is missing relocations record");
	}
	if (
		!ledger.relocations.exportsKeys ||
		typeof ledger.relocations.exportsKeys !== "object" ||
		Array.isArray(ledger.relocations.exportsKeys)
	) {
		throw new Error("Published surface ledger relocations.exportsKeys must be an object");
	}
	for (const [pkg, map] of Object.entries(ledger.relocations.exportsKeys)) {
		if (!map || typeof map !== "object" || Array.isArray(map)) {
			throw new Error(`Published surface ledger relocations.exportsKeys["${pkg}"] must be an object`);
		}
		for (const [subpath, note] of Object.entries(map as Record<string, unknown>)) {
			if (
				!note ||
				typeof note !== "object" ||
				Array.isArray(note) ||
				typeof (note as RelocationNote).to !== "string" ||
				typeof (note as RelocationNote).why !== "string"
			) {
				throw new Error(
					`Invalid relocation note for "${subpath}" in relocations.exportsKeys["${pkg}"]: must have string "to" and "why"`,
				);
			}
		}
	}
	if (
		!ledger.relocations.resolvedSubpaths ||
		typeof ledger.relocations.resolvedSubpaths !== "object" ||
		Array.isArray(ledger.relocations.resolvedSubpaths)
	) {
		throw new Error("Published surface ledger relocations.resolvedSubpaths must be an object");
	}
	for (const [pkgName, pkgRel] of Object.entries(ledger.relocations.resolvedSubpaths)) {
		expandResolvedSubpathsRecord(pkgRel, pkgName);
	}
	if (
		!ledger.relocations.starEdges ||
		typeof ledger.relocations.starEdges !== "object" ||
		Array.isArray(ledger.relocations.starEdges)
	) {
		throw new Error("Published surface ledger relocations.starEdges must be an object");
	}
	for (const [pkg, map] of Object.entries(ledger.relocations.starEdges)) {
		if (!map || typeof map !== "object" || Array.isArray(map)) {
			throw new Error(`Published surface ledger relocations.starEdges["${pkg}"] must be an object`);
		}
		for (const [fromEdge, toEdge] of Object.entries(map as Record<string, unknown>)) {
			if (typeof toEdge !== "string") {
				throw new Error(
					`Invalid starEdge relocation for "${fromEdge}" in relocations.starEdges["${pkg}"]: target must be a string`,
				);
			}
		}
	}
	for (const key of Object.keys(ledger)) {
		if (key !== "schemaVersion" && key !== "generatedFrom" && key !== "additions" && key !== "relocations") {
			throw new Error(`Unknown top-level property "${key}" in published surface ledger`);
		}
	}
	return raw as PublishedSurfaceApprovalLedger;
}

export async function loadPublishedSurfaceLedger(
	fixturePath: string = FIXTURE_PATH,
	repoRoot: string = REPO_ROOT,
): Promise<PublishedSurfaceLedger> {
	if (!existsSync(fixturePath)) {
		throw new Error(
			`Published surface ledger fixture not found at ${fixturePath}.\n` +
				`Corrective action: Run 'bun scripts/measure-published-surface.ts' to generate the ledger.`,
		);
	}
	const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;
	const approval = validatePublishedSurfaceLedger(raw);
	ensureBaselineAvailable(repoRoot, approval.generatedFrom);

	const basePackages = await measurePublishedSurface(approval.generatedFrom, repoRoot);

	const expandedAddedResolvedSubpaths: Record<string, string[]> = {};
	for (const [pkgName, pkgAdded] of Object.entries(approval.additions.resolvedSubpaths)) {
		expandedAddedResolvedSubpaths[pkgName] = expandAddedResolvedSubpaths(pkgAdded, pkgName);
	}

	const expandedRelocatedResolvedSubpaths: Record<string, Record<string, RelocationNote>> = {};
	for (const [pkgName, pkgRel] of Object.entries(approval.relocations.resolvedSubpaths)) {
		expandedRelocatedResolvedSubpaths[pkgName] = expandResolvedSubpathsRecord(pkgRel, pkgName);
	}

	return {
		schemaVersion: approval.schemaVersion,
		generatedFrom: approval.generatedFrom,
		packages: basePackages,
		additions: {
			packages: approval.additions.packages,
			exportsKeys: approval.additions.exportsKeys as Record<string, string[]>,
			resolvedSubpaths: expandedAddedResolvedSubpaths,
			namedExports: approval.additions.namedExports as Record<string, string[]>,
			starEdges: approval.additions.starEdges as Record<string, string[]>,
			binKeys: approval.additions.binKeys as Record<string, string[]>,
		},
		relocations: {
			exportsKeys: approval.relocations.exportsKeys as Record<string, Record<string, RelocationNote>>,
			resolvedSubpaths: expandedRelocatedResolvedSubpaths,
			starEdges: approval.relocations.starEdges as Record<string, Record<string, string>>,
		},
	};
}

export function writeApprovalFixture(
	ledger: PublishedSurfaceLedger | PublishedSurfaceApprovalLedger,
	fixturePath: string = FIXTURE_PATH,
): void {
	const normalizedAddedResolvedSubpaths: Record<string, RawPackageAddedResolvedSubpaths> = {};
	for (const [pkg, added] of Object.entries(ledger.additions.resolvedSubpaths)) {
		if (Array.isArray(added)) {
			normalizedAddedResolvedSubpaths[pkg] = normalizeAddedResolvedSubpaths(added);
		} else if (added !== null && typeof added === "object") {
			const expanded = expandAddedResolvedSubpaths(added as RawPackageAddedResolvedSubpaths, pkg);
			normalizedAddedResolvedSubpaths[pkg] = normalizeAddedResolvedSubpaths(expanded);
		} else {
			normalizedAddedResolvedSubpaths[pkg] = added as RawPackageAddedResolvedSubpaths;
		}
	}

	const normalizedRelocatedResolvedSubpaths: Record<string, RawPackageResolvedSubpathsRelocations> = {};
	for (const [pkg, rel] of Object.entries(ledger.relocations.resolvedSubpaths)) {
		if (rel !== null && typeof rel === "object" && ("records" in rel || "jsAliases" in rel)) {
			const expanded = expandResolvedSubpathsRecord(rel as RawPackageResolvedSubpathsRelocations, pkg);
			normalizedRelocatedResolvedSubpaths[pkg] = normalizeResolvedSubpathsRecord(expanded);
		} else if (rel !== null && typeof rel === "object") {
			normalizedRelocatedResolvedSubpaths[pkg] = normalizeResolvedSubpathsRecord(
				rel as Record<string, RelocationNote>,
			);
		} else {
			normalizedRelocatedResolvedSubpaths[pkg] = rel as RawPackageResolvedSubpathsRelocations;
		}
	}

	const approvalLedger: PublishedSurfaceApprovalLedger = {
		schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
		generatedFrom: ledger.generatedFrom,
		additions: {
			packages: [...ledger.additions.packages].sort(),
			exportsKeys: Object.fromEntries(
				Object.entries(ledger.additions.exportsKeys)
					.map(([k, v]) => [k, [...v].sort()] as const)
					.sort(([a], [b]) => a.localeCompare(b)),
			),
			resolvedSubpaths: Object.fromEntries(
				Object.entries(normalizedAddedResolvedSubpaths).sort(([a], [b]) => a.localeCompare(b)),
			),
			namedExports: Object.fromEntries(
				Object.entries(ledger.additions.namedExports)
					.map(([k, v]) => [k, [...v].sort()] as const)
					.sort(([a], [b]) => a.localeCompare(b)),
			),
			starEdges: Object.fromEntries(
				Object.entries(ledger.additions.starEdges)
					.map(([k, v]) => [k, [...v].sort()] as const)
					.sort(([a], [b]) => a.localeCompare(b)),
			),
			binKeys: Object.fromEntries(
				Object.entries(ledger.additions.binKeys)
					.map(([k, v]) => [k, [...v].sort()] as const)
					.sort(([a], [b]) => a.localeCompare(b)),
			),
		},
		relocations: {
			exportsKeys: Object.fromEntries(
				Object.entries(ledger.relocations.exportsKeys).sort(([a], [b]) => a.localeCompare(b)),
			),
			resolvedSubpaths: Object.fromEntries(
				Object.entries(normalizedRelocatedResolvedSubpaths).sort(([a], [b]) => a.localeCompare(b)),
			),
			starEdges: Object.fromEntries(
				Object.entries(ledger.relocations.starEdges).sort(([a], [b]) => a.localeCompare(b)),
			),
		},
	};
	mkdirSync(dirname(fixturePath), { recursive: true });
	writeFileSync(fixturePath, `${JSON.stringify(approvalLedger, null, "\t")}\n`, "utf-8");
}

/** Generate the full differential ledger. */
export async function generateLedger(
	baseRef: string = PINNED_BASELINE_COMMIT,
	headRef: string = "HEAD",
	repoRoot: string = REPO_ROOT,
): Promise<PublishedSurfaceLedger> {
	const fixturePath = join(repoRoot, "scripts", "fixtures", "published-surface.json");
	const previous = existsSync(fixturePath) ? await loadPublishedSurfaceLedger(fixturePath, repoRoot) : undefined;
	const basePackages =
		previous?.generatedFrom === baseRef ? previous.packages : await measurePublishedSurface(baseRef, repoRoot);
	const headPackages =
		headRef === "HEAD"
			? loadHeadPackages(repoRoot)
			: new Map<string, WorkspacePackageSnapshot | PackageManifestRecord>(
					Object.entries(await measurePublishedSurface(headRef, repoRoot)),
				);
	const addedPackageNames = [...headPackages.keys()].filter(name => !(name in basePackages)).sort();

	const addedExportsKeys: Record<string, string[]> = {};
	const addedNamedExports: Record<string, string[]> = {};
	const addedStarEdges: Record<string, string[]> = {};
	const addedBinKeys: Record<string, string[]> = {};
	const addedResolvedSubpaths: Record<string, string[]> = {};

	for (const [name, headPkg] of headPackages.entries()) {
		const basePkg = basePackages[name];
		if (!basePkg) continue;

		const addedExp = headPkg.exportsKeys.filter(k => !basePkg.exportsKeys.includes(k));
		if (addedExp.length > 0) addedExportsKeys[name] = [...addedExp].sort();

		const addedResolved = headPkg.resolvedSubpaths.filter(k => !basePkg.resolvedSubpaths.includes(k));
		if (addedResolved.length > 0) addedResolvedSubpaths[name] = [...addedResolved].sort();

		const addedNamed = headPkg.namedExports.filter(k => !basePkg.namedExports.includes(k));
		if (addedNamed.length > 0) addedNamedExports[name] = [...addedNamed].sort();

		const addedStars = headPkg.starEdges.filter(k => !basePkg.starEdges.includes(k));
		if (addedStars.length > 0) addedStarEdges[name] = [...addedStars].sort();

		const addedBins = headPkg.binKeys.filter(k => !basePkg.binKeys.includes(k));
		if (addedBins.length > 0) addedBinKeys[name] = [...addedBins].sort();
	}

	const existingRelocations: RelocationsRecord = previous?.relocations ?? {
		exportsKeys: {},
		resolvedSubpaths: {},
		starEdges: {},
	};

	return {
		schemaVersion: PUBLISHED_SURFACE_SCHEMA_VERSION,
		generatedFrom: baseRef,
		packages: basePackages,
		additions: {
			packages: addedPackageNames,
			exportsKeys: addedExportsKeys,
			resolvedSubpaths: addedResolvedSubpaths,
			namedExports: addedNamedExports,
			starEdges: addedStarEdges,
			binKeys: addedBinKeys,
		},
		relocations: existingRelocations,
	};
}

/**
 * Main execution function when run directly.
 */
export async function main(): Promise<void> {
	const baseRef = process.argv[2] ?? PINNED_BASELINE_COMMIT;
	const headRef = process.argv[3] ?? "HEAD";
	const ledger = await generateLedger(baseRef, headRef);
	writeApprovalFixture(ledger, FIXTURE_PATH);
	process.stdout.write(
		`Wrote the published-surface approval ledger for ${Object.keys(ledger.packages).length} packages, ` +
			`measured against ${ledger.generatedFrom}, to ${FIXTURE_PATH}\n`,
	);
}

if (import.meta.main || process.argv[1]?.endsWith("measure-published-surface.ts")) {
	void main();
}
