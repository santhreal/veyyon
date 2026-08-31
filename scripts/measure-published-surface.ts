/**
 * Measure the published surface area (manifest identity, entrypoints, subpath exports,
 * and barrel export declarations) across all workspace packages from a base git ref,
 * and record additions and relocations on HEAD into the committed ledger fixture.
 *
 * WHY THIS SCRIPT EXISTS. Workspace reorganizations (such as PR #927 "Everything as a Plugin")
 * relocate packages across top-level directories, restructure subpath exports, and split barrels.
 * To guarantee that no consumer-visible package name, bin key, exports subpath, or barrel export
 * was dropped accidentally, this generator measures the baseline published surface at the branch
 * point, records it into `scripts/fixtures/published-surface.json`, and records every addition and
 * relocation so the test suite can enforce exact parity without invoking git in CI.
 *
 * The baseline is the merge base, not `origin/main`: main keeps moving, and a module main added
 * after the branch point is not a surface the branch removed.
 *
 * Run: bun scripts/measure-published-surface.ts [base-ref]
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
	readonly resolvedSubpaths: readonly string[];
	readonly entrypoint: string | null;
	readonly namedExports: readonly string[];
	readonly starEdges: readonly string[];
}

export interface AdditionsRecord {
	readonly packages: readonly string[];
	readonly exportsKeys: Readonly<Record<string, readonly string[]>>;
	readonly resolvedSubpaths: Readonly<Record<string, readonly string[]>>;
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
	/**
	 * A resolved subpath main served that this tree serves elsewhere. `to` is either a subpath of the
	 * same package (`./discovery/capability/fs`) or a package-qualified specifier
	 * (`@veyyon/kernel/session/session-entries`) when the module left the package entirely.
	 */
	readonly resolvedSubpaths: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>>;
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

const REF_FILE_LISTS = new Map<string, readonly string[]>();

/** Every path a ref tracks, listed once per ref. */
export function refFiles(ref: string): readonly string[] {
	const cached = REF_FILE_LISTS.get(ref);
	if (cached) return cached;
	const listed = execSync(`git ls-tree -r --name-only ${ref}`, {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		maxBuffer: 16 * 1024 * 1024,
	})
		.trim()
		.split("\n")
		.filter(Boolean);
	REF_FILE_LISTS.set(ref, listed);
	return listed;
}

/** The file an `exports` condition object or string points at, preferring what an importer resolves. */
function exportTarget(value: unknown): string | null {
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
 *
 * WHY A KEY IS NOT A SUBPATH. `"./session/*"` is one key and served 36 importable modules. Moving
 * those modules to another package leaves the key in place and removes every subpath it served, so a
 * ledger of keys reports no change at all. That is how 55 published modules left
 * `@veyyon/coding-agent` in this branch without one key changing, and it is why the parity claim is
 * stated over resolved subpaths instead.
 *
 * `files` is the repository-relative file list of the tree being measured, so the same expansion runs
 * against a git ref's listing and against the working tree without a second implementation.
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
	const allFiles = refFiles(ref);

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

		const resolvedSubpaths = expandExportsToSubpaths(data.exports, member.dir, refFiles(ref));

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
			resolvedSubpaths,
			entrypoint,
			namedExports,
			starEdges,
		};
	}

	return packages;
}

/**
 * The commit this branch started from, which is the tree the claim is about.
 *
 * `origin/main` was the baseline until main gained a module the branch had never seen. The generator
 * read it as a subpath the branch stopped serving, found no rename for it, and aborted — a real
 * answer to the wrong question. A surface claim about a branch compares the branch against what it
 * branched from, which is what a pull request diffs and what `merge-base` names.
 */
function mergeBaseWithMain(): string {
	return execSync("git merge-base origin/main HEAD", { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

/**
 * The `exports` keys this branch relocated, with the successor each one resolves to.
 *
 * Hoisted out of the ledger body because the resolved-subpath layer reads the same rows: a subpath
 * served by a relocated key relocates with it, and a git rename cannot see that move when the key
 * changed and the file did not.
 */
const DOCUMENTED_KEY_RELOCATIONS: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>> = {
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
};

/**
 * A module whose contents were absorbed into another module, which is a relocation no rename can
 * show: the destination already existed and grew, so git sees a deletion beside an edit.
 *
 * Both rows were measured, not assumed. `vibe/state.ts` was a four-line `VibeModeState` interface and
 * `session/vibe-runtime.ts` declares it now. The four `motion-*` modules of the terminal engine were
 * folded into `packages/utils/src/motion.ts`, which holds `BlockReveal`, `HoverFade`,
 * `fadeLineTowards` and `SettleValue` today.
 *
 * A row here is checked against the head like any other successor, so it cannot describe a surface
 * that is not served.
 */
const ABSORBED_SUBPATHS: Readonly<Record<string, Readonly<Record<string, RelocationNote>>>> = {
	"@veyyon/coding-agent": {
		"./vibe/state": {
			to: "./session/vibe-runtime",
			why: "VibeModeState is declared in session/vibe-runtime.ts, which publishes it",
		},
	},
	"@veyyon/tui": {
		"./motion-grow": {
			to: "@veyyon/utils/motion",
			why: "BlockReveal is declared in packages/utils/src/motion.ts, which @veyyon/utils publishes as ./motion",
		},
		"./motion-hover": {
			to: "@veyyon/utils/motion",
			why: "HoverFade is declared in packages/utils/src/motion.ts, which @veyyon/utils publishes as ./motion",
		},
		"./motion-paint": {
			to: "@veyyon/utils/motion",
			why: "fadeLineTowards is declared in packages/utils/src/motion.ts, which @veyyon/utils publishes as ./motion",
		},
		"./motion-settle": {
			to: "@veyyon/utils/motion",
			why: "SettleValue is declared in packages/utils/src/motion.ts, which @veyyon/utils publishes as ./motion",
		},
	},
};

/** Generate the full differential ledger. */
export function generateLedger(baseRef = mergeBaseWithMain(), headRef = "HEAD"): PublishedSurfaceLedger {
	const basePackages = measurePublishedSurface(baseRef);
	const headPackages = measurePublishedSurface(headRef);

	const addedPackageNames = Object.keys(headPackages)
		.filter(name => !(name in basePackages))
		.sort();

	const addedExportsKeys: Record<string, string[]> = {};
	const addedNamedExports: Record<string, string[]> = {};
	const addedStarEdges: Record<string, string[]> = {};
	const addedBinKeys: Record<string, string[]> = {};
	const addedResolvedSubpaths: Record<string, string[]> = {};

	for (const [name, headPkg] of Object.entries(headPackages)) {
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

	// A subpath the head no longer serves is either relocated or removed, and the difference is not a
	// judgement call: git already recorded it. Every rename between the two refs is read once, so the
	// file a lost subpath resolved to is followed to wherever it landed, and whichever package
	// publishes it there names the successor. Typing the rule out by hand instead went stale on the
	// first relocation that was not the one being written about: 110 kernel subpaths were described
	// and `./auto-thinking/classifier`, moved in an earlier step of the same branch, aborted the run.
	//
	// A lost subpath with no rename, or one whose destination no package publishes, falls through to
	// the documented key relocations and then aborts the generator: an undescribed removal must not
	// reach the fixture as an absence.
	//
	// The similarity threshold is 25%, not git's default 50%, because a module that moves between
	// directories also has every relative import rewritten. `modes/components/overlay-box.ts` measures
	// 39% similar to where it landed, so the default read it as a deletion beside an unrelated
	// addition. `-l0` removes the rename-detection cap, which a diff this size otherwise exceeds.
	const renamedFiles = new Map<string, string>();
	const renameLines = execSync(`git diff --find-renames=25% -l0 --diff-filter=R --name-status ${baseRef} ${headRef}`, {
		cwd: REPO_ROOT,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\n")
		.filter(Boolean);
	for (const line of renameLines) {
		const [, from, to] = line.split("\t");
		if (from !== undefined && to !== undefined) renamedFiles.set(from, to);
	}

	const baseSubpathFiles = new Map<string, Map<string, string>>();
	const headFileSubpaths = new Map<string, Array<{ pkg: string; subpath: string }>>();
	for (const ref of [baseRef, headRef]) {
		for (const member of discoverWorkspaceManifests(ref)) {
			const pkg = typeof member.data.name === "string" ? member.data.name : member.dir;
			const expanded = expandExportsToFileMap(member.data.exports, member.dir, refFiles(ref));
			if (ref === baseRef) {
				baseSubpathFiles.set(pkg, expanded);
				continue;
			}
			for (const [subpath, file] of expanded) {
				const rows = headFileSubpaths.get(file) ?? [];
				rows.push({ pkg, subpath });
				headFileSubpaths.set(file, rows);
			}
		}
	}

	/**
	 * The subpath a documented key relocation carries this one to, when the key moved and the file did
	 * not. `./modes/components` is one: the barrel was rewritten past the point a rename is detected,
	 * and the row that describes the move is already in {@link DOCUMENTED_KEY_RELOCATIONS}. The
	 * successor is accepted only if the head really serves it, so a stale row cannot describe a loss
	 * into existence.
	 */
	function documentedSuccessor(pkgName: string, subpath: string, served: ReadonlySet<string>): RelocationNote | null {
		const rows = DOCUMENTED_KEY_RELOCATIONS[pkgName];
		if (rows === undefined) return null;
		for (const [key, note] of Object.entries(rows)) {
			if (!key.includes("*")) {
				if (key !== subpath || !served.has(note.to)) continue;
				return note;
			}
			const star = key.indexOf("*");
			const head = key.slice(0, star);
			const tail = key.slice(star + 1);
			if (!subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
			const middle = subpath.slice(head.length, subpath.length - tail.length);
			if (middle.length === 0) continue;
			const candidate = note.to.replace("*", middle);
			if (!served.has(candidate)) continue;
			return { to: candidate, why: note.why };
		}
		return null;
	}

	/**
	 * The successor of an absorbed module, with the `.js` alias carried across so both shapes of the
	 * lost subpath resolve. A cross-package successor is checked against that package's own surface.
	 */
	function absorbedSuccessor(pkgName: string, subpath: string, served: ReadonlySet<string>): RelocationNote | null {
		const rows = ABSORBED_SUBPATHS[pkgName];
		if (rows === undefined) return null;
		const alias = subpath.endsWith(".js") ? ".js" : "";
		const bare = alias === "" ? subpath : subpath.slice(0, -alias.length);
		const note = rows[bare];
		if (note === undefined) return null;
		const to = `${note.to}${alias}`;
		if (to.startsWith("@")) {
			const successorPackage = to.split("/").slice(0, 2).join("/");
			const successorSubpath = `./${to.split("/").slice(2).join("/")}`;
			const surface = headPackages[successorPackage]?.resolvedSubpaths;
			if (surface === undefined || !surface.includes(successorSubpath)) return null;
			return { to, why: note.why };
		}
		if (!served.has(to)) return null;
		return { to, why: note.why };
	}

	/**
	 * The successor of a lost subpath, by three routes: the rename git recorded for the file it
	 * resolved to, then a documented key relocation, then a module that absorbed it. Each answer is
	 * verified against the head's own surface, so no route can name a subpath nobody serves.
	 */
	function successorOf(pkgName: string, subpath: string, served: ReadonlySet<string>): RelocationNote | null {
		const fallback = (): RelocationNote | null =>
			documentedSuccessor(pkgName, subpath, served) ?? absorbedSuccessor(pkgName, subpath, served);
		const from = baseSubpathFiles.get(pkgName)?.get(subpath);
		const to = from === undefined ? undefined : renamedFiles.get(from);
		const candidates = to === undefined ? undefined : headFileSubpaths.get(to);
		if (from === undefined || to === undefined || candidates === undefined || candidates.length === 0) {
			return fallback();
		}
		// An `exports` map publishes the same file twice, extensionless and under a `.js` alias. The
		// successor keeps the shape the lost subpath had, so `./session/x.js` relocates to a `.js`
		// alias and never silently to the extensionless neighbour.
		const wantsAlias = subpath.endsWith(".js");
		const chosen = candidates.find(row => row.subpath.endsWith(".js") === wantsAlias) ?? candidates[0];
		if (chosen === undefined) return fallback();
		const target = chosen.subpath.replace(/^\.\//, "");
		return {
			to: target === "." ? chosen.pkg : `${chosen.pkg}/${target}`,
			why: `${from} moved to ${to}, which ${chosen.pkg} publishes as ${chosen.subpath}`,
		};
	}

	const relocatedResolvedSubpaths: Record<string, Record<string, RelocationNote>> = {};
	for (const [name, basePkg] of Object.entries(basePackages)) {
		const headPkg = headPackages[name];
		if (!headPkg) continue;
		const served = new Set(headPkg.resolvedSubpaths);
		const rows: Record<string, RelocationNote> = {};
		for (const subpath of basePkg.resolvedSubpaths) {
			if (served.has(subpath)) continue;
			const note = successorOf(name, subpath, served);
			if (note === null) {
				throw new Error(
					`${name} no longer serves ${subpath}: no rename and no documented key relocation names a successor`,
				);
			}
			rows[subpath] = note;
		}
		if (Object.keys(rows).length > 0) relocatedResolvedSubpaths[name] = rows;
	}

	const relocations: RelocationsRecord = {
		exportsKeys: DOCUMENTED_KEY_RELOCATIONS,
		resolvedSubpaths: relocatedResolvedSubpaths,
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
			resolvedSubpaths: addedResolvedSubpaths,
			namedExports: addedNamedExports,
			starEdges: addedStarEdges,
			binKeys: addedBinKeys,
		},
		relocations,
	};
}

/**
 * Main execution function when run directly.
 *
 * The first argument names the base commit. It exists because `merge-base` needs both histories, and
 * a partial or shallow clone has neither: the regeneration then names the commit outright rather
 * than reporting every module the shallow boundary hid as a removed surface. The second names the
 * head, for the same reason in reverse: both sides are read from git, so the measurement does not
 * need the commit checked out.
 */
export function main(): void {
	const baseRef = process.argv[2] ?? mergeBaseWithMain();
	const ledger = generateLedger(baseRef, process.argv[3] ?? "HEAD");
	mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
	writeFileSync(FIXTURE_PATH, `${JSON.stringify(ledger, null, "\t")}\n`, "utf-8");
	process.stdout.write(
		`Wrote the published-surface ledger for ${Object.keys(ledger.packages).length} packages, ` +
			`measured against ${ledger.generatedFrom}, to ${FIXTURE_PATH}\n`,
	);
}

if (import.meta.main || process.argv[1]?.endsWith("measure-published-surface.ts")) {
	main();
}
