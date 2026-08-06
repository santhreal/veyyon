import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn } from "../src/module-reach";

/**
 * Every workspace package a package imports at runtime is a package it declares.
 *
 * WHY THIS SUITE EXISTS. Resolution inside this repo works because the workspace flattens every
 * package into one `node_modules`, so an import of `@veyyon/coding-agent` from a package whose
 * manifest never mentions it resolves anyway. Nothing reports it. The manifests then describe a
 * graph that is not the real one, and the difference is only visible where the flattening stops:
 * build ordering, a pruned install, or a checkout of one package on its own. Five such edges had
 * accumulated, all through test and bench files, which are exactly the files nobody reads a
 * manifest for.
 *
 * It lives in `@veyyon/utils` because this package owns `module-reach`, the reader these
 * assertions parse imports with, and because the invariant is about the whole workspace rather
 * than about any one package in it.
 *
 * Type-only imports are deliberately out of scope: they are erased before the code runs, so they
 * cannot fail to resolve at runtime. This gate is about the edges that survive compilation.
 */

const PACKAGES_DIR = path.resolve(import.meta.dirname, "../..");
const SKIP_DIRS: Record<string, true> = {
	".turbo": true,
	build: true,
	coverage: true,
	dist: true,
	node_modules: true,
	target: true,
};

interface WorkspacePackage {
	name: string;
	dir: string;
	declared: Record<string, string>;
}

function readWorkspacePackages(): WorkspacePackage[] {
	const packages: WorkspacePackage[] = [];
	for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(PACKAGES_DIR, entry.name, "package.json");
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
			name?: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		if (!manifest.name) continue;
		packages.push({
			name: manifest.name,
			dir: path.join(PACKAGES_DIR, entry.name),
			declared: {
				...manifest.dependencies,
				...manifest.devDependencies,
				...manifest.peerDependencies,
				...manifest.optionalDependencies,
			},
		});
	}
	return packages;
}

function sourceFilesUnder(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (SKIP_DIRS[entry.name]) continue;
			sourceFilesUnder(path.join(dir, entry.name), found);
		} else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
			found.push(path.join(dir, entry.name));
		}
	}
	return found;
}

/** The workspace package a specifier names, or `undefined` for anything outside the workspace. */
function workspaceTargetOf(specifier: string, names: Record<string, true>): string | undefined {
	const target = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	return names[target] ? target : undefined;
}

/** Every runtime workspace edge out of one package, as `<target> <file>` lines. */
function runtimeEdgesOf(pkg: WorkspacePackage, names: Record<string, true>): { target: string; file: string }[] {
	const edges: { target: string; file: string }[] = [];
	for (const file of sourceFilesUnder(pkg.dir)) {
		const source = fs.readFileSync(file, "utf8");
		// Nothing here can name a workspace package without naming its scope first, and skipping the
		// parse for the files that do not keeps this a whole-workspace walk rather than a slow gate.
		if (!source.includes("@veyyon/") && !source.includes('"argot') && !source.includes("'argot")) continue;
		for (const specifier of [...moduleSpecifiersIn(source), ...dynamicImportSpecifiersIn(source)]) {
			const target = workspaceTargetOf(specifier, names);
			if (!target || target === pkg.name) continue;
			edges.push({ target, file: path.relative(PACKAGES_DIR, file) });
		}
	}
	return edges;
}

const workspacePackages = readWorkspacePackages();
const workspaceNames: Record<string, true> = {};
for (const pkg of workspacePackages) workspaceNames[pkg.name] = true;

describe("workspace manifests describe the graph the code actually has", () => {
	it("declares every workspace package it imports at runtime", () => {
		const undeclared: string[] = [];
		for (const pkg of workspacePackages) {
			for (const edge of runtimeEdgesOf(pkg, workspaceNames)) {
				if (edge.target in pkg.declared) continue;
				undeclared.push(`${pkg.name} imports ${edge.target} at ${edge.file} without declaring it`);
			}
		}
		expect([...new Set(undeclared)].sort()).toEqual([]);
	}, 30_000);

	/**
	 * `@veyyon/natives` is the bottom of the workspace: utils depends on it, and everything else
	 * depends on utils. It declares no workspace dependency at all, and a single import of one
	 * would put the addon inside a cycle with the logger, handlebars and yaml that utils carries.
	 * Its bench had exactly that import.
	 */
	it("keeps the native addon a leaf, importing no other workspace package", () => {
		const natives = workspacePackages.find(pkg => pkg.name === "@veyyon/natives");
		if (!natives) throw new Error("no @veyyon/natives package in the workspace");
		const reached = runtimeEdgesOf(natives, workspaceNames).map(edge => `${edge.target} at ${edge.file}`);
		expect([...new Set(reached)].sort()).toEqual([]);
	});
});
