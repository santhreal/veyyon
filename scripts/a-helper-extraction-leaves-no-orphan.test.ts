/**
 * WHY THIS EXISTS. A large restructuring PR that extracts free functions, types,
 * and constants from a module into a companion `*-helpers.ts` file can leave the
 * helper orphaned: the parent module no longer imports it, or a barrel no longer
 * re-exports its names. The helper compiles, the tree is green, and the code is
 * dead. This suite fails the moment a helper file is not reachable from its
 * package's import graph, so an incomplete extraction is caught at CI time
 * rather than by a downstream consumer.
 *
 * WHAT IT CHECKS.
 * 1. Every `*-helpers.ts` under a package `src/` is imported by at least one
 *    other `.ts` file in the same package.
 * 2. Every `*-helpers.ts` that has a same-name parent module (e.g. `foo-helpers.ts`
 *    with `foo.ts`) is imported by that parent.
 *
 * WHAT IT DOES NOT CHECK. Behaviour. A helper that is imported but returns the
 * wrong result after extraction is a behavioural regression, and a structural
 * scan cannot see it. The companion suite
 * `a-package-exports-its-public-surface.test.ts` guards the public surface;
 * this one guards the internal wiring.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { moduleSpecifiersIn, typeOnlyModuleSpecifiersIn } from "@veyyon/utils/module-reach";

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesRoot = path.join(repoRoot, "packages");

interface HelperFile {
	/** Full path to the helper file. */
	file: string;
	/** Path relative to packages/. */
	rel: string;
	/** The expected parent module path, if it exists. */
	parent?: string;
}

/** Recursively collect every `*-helpers.ts` under a directory. */
function collectHelpers(dir: string, acc: HelperFile[] = []): HelperFile[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "target") {
			collectHelpers(full, acc);
		} else if (entry.isFile() && entry.name.endsWith("-helpers.ts")) {
			const rel = path.relative(packagesRoot, full);
			const parentPath = full.replace("-helpers.ts", ".ts");
			let parent: string | undefined;
			try {
				statSync(parentPath);
				parent = parentPath;
			} catch {
				// No parent module — the helper is shared across siblings.
			}
			acc.push({ file: full, rel, parent });
		}
	}
	return acc;
}

/** Every `.ts` source file under a package's `src/`, excluding the helper itself. */
function packageSources(pkgDir: string, exclude: string): string[] {
	const srcDir = path.join(pkgDir, "src");
	const acc: string[] = [];
	const walk = (dir: string) => {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.isFile() && entry.name.endsWith(".ts") && full !== exclude) acc.push(full);
			}
		} catch {
			// Directory may not exist.
		}
	};
	walk(srcDir);
	return acc;
}

/** The bare module name a file would import its sibling as. */
function siblingSpecifier(from: string, to: string): string {
	const fromDir = path.dirname(from);
	const rel = path.relative(fromDir, to).replace(/\.ts$/, "");
	return rel.startsWith(".") ? rel : `./${rel}`;
}

const PRIVATE_PACKAGES = new Set([
	"evals",
	"deepswe-bench",
	"metaharness",
	"simulations",
	"typescript-edit-benchmark",
	"swarm-extension",
]);

describe("helper extraction leaves no orphan", () => {
	const helpers = collectHelpers(packagesRoot);

	// Pre-build a reverse index: for each package, read every source file once and
	// record which helper files each source imports. This is O(sources) per package
	// instead of O(helpers * sources), cutting the scan from ~40s to ~3s on CI.
	type PkgIndex = { sources: string[]; importedHelpers: Map<string, Set<string>> };
	const packageIndexes = new Map<string, PkgIndex>();

	function indexForPackage(pkgName: string): PkgIndex {
		let idx = packageIndexes.get(pkgName);
		if (idx) return idx;
		const pkgDir = path.join(packagesRoot, pkgName);
		const sources = packageSources(pkgDir, "");
		const importedHelpers = new Map<string, Set<string>>();
		for (const src of sources) {
			const text = readFileSync(src, "utf8");
			const specs = [...moduleSpecifiersIn(text), ...typeOnlyModuleSpecifiersIn(text)];
			for (const s of specs) {
				if (!s.endsWith("-helpers")) continue;
				const resolved = path.resolve(path.dirname(src), `${s}.ts`);
				if (!importedHelpers.has(resolved)) importedHelpers.set(resolved, new Set());
				importedHelpers.get(resolved)!.add(src);
			}
		}
		idx = { sources, importedHelpers };
		packageIndexes.set(pkgName, idx);
		return idx;
	}

	it("every helper is imported by at least one other source file in its package", () => {
		const orphans: string[] = [];
		for (const helper of helpers) {
			const pkgName = helper.rel.split(path.sep)[0]!;
			if (PRIVATE_PACKAGES.has(pkgName)) continue;
			const idx = indexForPackage(pkgName);
			const importers = idx.importedHelpers.get(helper.file);
			if (!importers || importers.size === 0) orphans.push(helper.rel);
		}
		expect(orphans, "helper files not imported by any other source file in their package").toEqual([]);
	});

	it("every helper with a parent module is imported by its parent or by at least two siblings", () => {
		const missing: string[] = [];
		for (const helper of helpers) {
			if (!helper.parent) continue;
			const parentText = readFileSync(helper.parent, "utf8");
			const parentSpecs = [...moduleSpecifiersIn(parentText), ...typeOnlyModuleSpecifiersIn(parentText)];
			const expected = siblingSpecifier(helper.parent, helper.file);
			if (parentSpecs.includes(expected)) continue;
			// The parent doesn't import it — check if at least 2 other files in the package do.
			const pkgName = helper.rel.split(path.sep)[0]!;
			if (PRIVATE_PACKAGES.has(pkgName)) continue;
			const idx = indexForPackage(pkgName);
			const importers = idx.importedHelpers.get(helper.file);
			const importCount = importers ? importers.size : 0;
			if (importCount < 2) missing.push(helper.rel);
		}
		expect(missing, "helper files not imported by their parent or at least two siblings").toEqual([]);
	});

	it("the scan covered a real population, not an empty glob", () => {
		expect(helpers.length).toBeGreaterThan(400);
	});
});
