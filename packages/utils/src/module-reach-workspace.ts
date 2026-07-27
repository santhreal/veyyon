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
 *   - `packages/coding-agent/test/architecture/test-suite-module-reach.test.ts` listed four of those seven.
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

/** Every directory under `<repoRoot>/packages` that holds a `package.json`, sorted for a stable table. */
function packageDirs(repoRoot: string): string[] {
	const root = path.join(repoRoot, "packages");
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch {
		return [];
	}
	return names
		.map(name => path.join(root, name))
		.filter(dir => fs.existsSync(path.join(dir, "package.json")))
		.sort();
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
		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as Record<string, unknown>;
		} catch {
			continue;
		}
		const name = manifest.name;
		if (typeof name !== "string" || name.length === 0) continue;

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
		found.push({ name, dir, exports: entries });
	}
	return found;
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
	const packages: Array<readonly [string, string]> = [];
	const aliases: Array<readonly [string, string]> = [];
	const seenNames = new Set<string>();
	const seenPrefixes = new Set<string>();

	for (const pkg of workspacePackages(repoRoot)) {
		for (const [key, target] of pkg.exports) {
			if (key === ".") {
				if (seenNames.has(pkg.name)) continue;
				seenNames.add(pkg.name);
				packages.push([pkg.name, path.join(pkg.dir, target)]);
				continue;
			}
			if (!key.startsWith("./")) continue;

			const star = key.indexOf("*");
			if (star === -1) {
				const specifier = pkg.name + key.slice(1);
				if (seenNames.has(specifier)) continue;
				seenNames.add(specifier);
				packages.push([specifier, path.join(pkg.dir, target)]);
				continue;
			}

			// A wildcard export becomes a prefix alias, which needs the `*` to be the LAST thing in the key:
			// `./*.js` and `./*` describe the same prefix with different extensions, and this table maps a
			// prefix to a directory rather than rewriting extensions. `resolveFile` already tries `.ts`, so
			// the `./*` form covers both and the `./*.js` form would only add a duplicate prefix.
			if (star !== key.length - 1) continue;
			const targetStar = target.indexOf("*");
			if (targetStar === -1) continue;
			const prefix = pkg.name + key.slice(1, star);
			if (seenPrefixes.has(prefix)) continue;
			seenPrefixes.add(prefix);
			aliases.push([prefix, path.join(pkg.dir, target.slice(0, targetStar))]);
		}
	}

	return { packages, aliases };
}
