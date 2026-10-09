/**
 * The workspace's own name-to-source map, derived from the `exports` field of every package, for the
 * module-reach walk to resolve a cross-package import with.
 *
 * WHY THIS EXISTS, and it is the same argument as `module-reach.ts` one layer up. That module owns the
 * WALK because four gates had four copies of it and the copies resolved different things. The walk is
 * shared now, but the RESOLUTION TABLE was still written out by hand in each of those four gates, and
 * the copies had drifted exactly the way the walk's copies had:
 *
 *   - `packages/coding-agent/test/architecture/leveraged-imports-stay-cut.test.ts` listed seven packages.
 *   - the suite-total gate beside it (since deleted) listed four of those seven.
 *   - both listed `@veyyon/agent`, which is not the name of any package in this workspace. The directory
 *     is `packages/agent` and the package is `@veyyon/agent-core`, so all 569 `@veyyon/agent-core`
 *     specifiers in the repository resolved to nothing in both gates.
 *   - none of the four knew `@veyyon/mnemopi` (161 specifiers), `@veyyon/natives` (63), `@veyyon/stats`
 *     (37) or `@veyyon/tool-render` (2).
 *
 * Every gate built on this is an UPPER BOUND, so under-resolution is invisible: a specifier the table
 * does not know resolves to nothing, the walk stops there, and the ceiling passes while measuring less
 * than it claims. That is the failure `module-reach.ts` was extracted to end, and hand-copied tables put
 * it straight back. A hand-written table also cannot notice a NEW package: adding one lowers every
 * ceiling in the repository silently.
 *
 * WHY IT IS DERIVED FROM `exports` RATHER THAN LISTED. The `exports` field is what the runtime and
 * `tsc` actually resolve with, so reading it means the gate resolves what the program does, and a
 * package that adds a subpath export gets it for free. Listing the same map by hand is a second
 * definitional home for a fact that already has one (ONE PLACE), and it is the home nobody updates.
 *
 * WHAT IT DOES NOT DO. It does not read `node_modules`, so an external dependency stays outside the
 * measured world, which is deliberate: these gates count the modules this repository instantiates, and
 * `lru-cache` is one edge whether it is 1 module or 30. It does not follow `imports` (`#private`
 * subpaths), because no package here uses them; a package that starts to will fail the completeness
 * check in `packages/utils/test/module-reach-workspace.test.ts` rather than quietly resolve less.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModuleReachResolution } from "./module-reach";

/** The conditions a source-resolving import may hide behind, in the order the bundler reads them. */
const SOURCE_CONDITIONS = ["import", "types", "default", "bun", "node"] as const;

/**
 * The file an `exports` value points at, or `undefined` for one that points nowhere useful here.
 *
 * A value is either a path or a conditions object, and a conditions object may nest. Only relative
 * targets are followed: an entry pointing at a bare package name is re-exporting someone else's code,
 * which is outside the world this table describes.
 */
function exportTarget(value: unknown, depth = 0): string | undefined {
	if (typeof value === "string") return value.startsWith("./") ? value : undefined;
	if (value === null || typeof value !== "object" || depth > 4) return undefined;
	const conditions = value as Record<string, unknown>;
	for (const condition of SOURCE_CONDITIONS) {
		if (condition in conditions) {
			const resolved = exportTarget(conditions[condition], depth + 1);
			if (resolved !== undefined) return resolved;
		}
	}
	return undefined;
}

/**
 * Every workspace member directory that holds a `package.json`, sorted for a stable table.
 *
 * The member list is read from the root manifest's `workspaces.packages` rather than assumed to be
 * the contents of `packages/`. That assumption cost the table nine of its rows the day members
 * moved out: `contracts/*`, `hosts/terminal/engine`, `kernel`, `natives/bridge/bindings` and
 * `plugins/*` stopped resolving, and because every gate built on this resolution is an upper bound,
 * each one kept passing while measuring less.
 */
function packageDirs(repoRoot: string): string[] {
	let patterns: unknown;
	try {
		const manifest: unknown = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
		const workspaces = (manifest as { workspaces?: unknown }).workspaces;
		patterns = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown })?.packages;
	} catch {
		return [];
	}
	if (!Array.isArray(patterns)) return [];

	const dirs = new Set<string>();
	for (const pattern of patterns) {
		if (typeof pattern !== "string") continue;
		for (const dir of expandPattern(repoRoot, pattern.split("/"))) {
			if (fs.existsSync(path.join(dir, "package.json"))) dirs.add(dir);
		}
	}
	return [...dirs].sort();
}

/**
 * The directories a member pattern's segments name, with `*` expanded one level per segment.
 *
 * A literal pattern (`kernel`, `natives/bridge/bindings`) names one directory and a globbed one
 * (`packages/*`, or a nested glob two levels down) names every match, so a member arrives at
 * whatever depth it sits.
 */
function expandPattern(base: string, segments: readonly string[]): string[] {
	const [head, ...rest] = segments;
	if (head === undefined) return [base];
	const heads =
		head === "*"
			? fs
					.readdirSync(base, { withFileTypes: true })
					.filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
					.map(entry => path.join(base, entry.name))
			: [path.join(base, head)];
	const found: string[] = [];
	for (const dir of heads) {
		if (!fs.existsSync(dir)) continue;
		found.push(...expandPattern(dir, rest));
	}
	return found;
}

/** One workspace package's declared name and its `exports` map, normalized to `{ ".": main }` if absent. */
export interface WorkspacePackage {
	/** The declared package name, which is what a specifier says and is not always the directory name. */
	readonly name: string;
	/** Absolute path to the package directory. */
	readonly dir: string;
	/** Subpath key to relative target, with only the source-resolving conditions kept. */
	readonly exports: ReadonlyArray<readonly [string, string]>;
}

/**
 * Read every workspace package's name and export map.
 *
 * A package.json that cannot be parsed is skipped rather than thrown on, because a gate should not
 * become a syntax checker for an unrelated package, and the completeness check in this module's test
 * suite catches the disappearance.
 */
export function workspacePackages(repoRoot: string): WorkspacePackage[] {
	const found: WorkspacePackage[] = [];
	for (const dir of packageDirs(repoRoot)) {
		const manifest = readManifest(dir);
		if (manifest === undefined) continue;
		const name = manifest.name;
		if (typeof name !== "string" || name.length === 0) continue;
		found.push({ name, dir, exports: manifestExports(manifest) });
	}
	return found;
}

/** The parsed `package.json` in `dir`, or `undefined` when it cannot be read or parsed. */
function readManifest(dir: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** A manifest's `exports` entries that resolve to source, or `[".", main]` when it declares no map. */
function manifestExports(manifest: Record<string, unknown>): Array<readonly [string, string]> {
	const declared = manifest.exports;
	const entries: Array<readonly [string, string]> = [];
	if (declared !== null && typeof declared === "object") {
		for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
			const target = exportTarget(value);
			if (target !== undefined) entries.push([key, target]);
		}
	} else if (typeof manifest.main === "string" && manifest.main.startsWith("./")) {
		// No `exports` map: the bare name is all this package offers, and `main` is where it points.
		entries.push([".", manifest.main]);
	}
	return entries;
}

/**
 * The module-reach resolution for this workspace: every package's bare name, every exact subpath export,
 * and a prefix alias for every wildcard export.
 *
 * `repoRoot` is the directory holding `packages/`. Pass it absolute; a gate should compute it from
 * `import.meta.dir` rather than from the process's working directory, since a relative root that lands
 * one directory off resolves nothing and every ceiling built on it passes while measuring almost
 * nothing. That mistake has been made repeatedly against this metric, which is why it is called out
 * here as well as in `module-reach.ts`.
 *
 * Exact subpaths go in `packages` rather than `aliases` because `resolveModuleSpecifier` matches exact
 * names first and takes the longest matching prefix second, so `@veyyon/mnemopi/core` reaches
 * `src/core/index.ts` (its declared target) instead of `src/core.ts` (which does not exist) while
 * `@veyyon/mnemopi/anything-else` still resolves through the `./*` alias.
 */
export function workspaceModuleReachResolution(repoRoot: string): ModuleReachResolution {
	const table: ResolutionTable = { packages: [], aliases: [], seenNames: new Set(), seenPrefixes: new Set() };
	for (const pkg of workspacePackages(repoRoot)) {
		for (const [key, target] of pkg.exports) addExport(table, pkg, key, target);
	}
	return { packages: table.packages, aliases: table.aliases };
}

/** The resolution under construction. The first package to declare a name or a prefix keeps it. */
interface ResolutionTable {
	readonly packages: Array<readonly [string, string]>;
	readonly aliases: Array<readonly [string, string]>;
	readonly seenNames: Set<string>;
	readonly seenPrefixes: Set<string>;
}

/**
 * Add one export entry: `.` and an exact `./sub` as a package name, a trailing `./prefix*` as an alias,
 * and nothing for any other key.
 */
function addExport(table: ResolutionTable, pkg: WorkspacePackage, key: string, target: string): void {
	if (key !== "." && !key.startsWith("./")) return;
	const star = key.indexOf("*");
	if (star === -1) {
		// `.` slices to "", so the bare name and an exact subpath share one spelling.
		const specifier = pkg.name + key.slice(1);
		if (table.seenNames.has(specifier)) return;
		table.seenNames.add(specifier);
		table.packages.push([specifier, path.join(pkg.dir, target)]);
		return;
	}

	// A wildcard export becomes a prefix alias, which needs the `*` to be the LAST thing in the key:
	// `./*.js` and `./*` describe the same prefix with different extensions, and this table maps a
	// prefix to a directory rather than rewriting extensions. `resolveFile` already tries `.ts`, so
	// the `./*` form covers both and the `./*.js` form would only add a duplicate prefix.
	if (star !== key.length - 1) return;
	const targetStar = target.indexOf("*");
	if (targetStar === -1) return;
	const prefix = pkg.name + key.slice(1, star);
	if (table.seenPrefixes.has(prefix)) return;
	table.seenPrefixes.add(prefix);
	table.aliases.push([prefix, path.join(pkg.dir, target.slice(0, targetStar))]);
}
