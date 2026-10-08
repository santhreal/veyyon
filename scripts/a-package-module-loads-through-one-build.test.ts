/**
 * Shipped source reaches each package module through one build of it.
 *
 * WHY THIS SUITE EXISTS. `lru-cache` publishes one module twice: `lru-cache` resolves to
 * `dist/esm/node/index.min.js` and `lru-cache/raw` to `dist/esm/node/index.js`, and both entries
 * declare the same `dist/esm/node/index.d.ts`. Ten modules imported `lru-cache/raw` and the Mermaid
 * render cache imported `lru-cache`, so every interactive session evaluated the module twice: two
 * copies of the source, two `LRUCache` classes of 53 private names each, and two sets of function
 * executables, for one cache implementation. The type check, the tests and the running product all
 * agree with either specifier, so nothing but the loaded-module list showed it.
 *
 * THE CLASS. Two specifiers of one package that resolve to DIFFERENT runtime files but declare the
 * SAME types file are two builds of one module: minified and readable, ESM and a bundled copy, a
 * browser build and a node build under one condition set. Declaring the same types is the package's
 * own statement that the entries are interchangeable, so the sweep reads it from each package's
 * `exports` rather than from a list of packages known to do this. Workspace packages are swept by
 * the same rule. A package that adds an alias entry in a later version, or a new import of an
 * existing package through its other entry, turns this red without an edit here.
 *
 * WHAT IT DOES NOT CATCH. Two builds that declare their types in two separate files (the sweep then
 * reads them as two modules), a package installed twice at two versions under two `node_modules`
 * directories, and a specifier computed at run time. Test files, scripts and fixtures are not
 * shipped source and are not swept.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { dynamicImportSpecifiersIn, moduleSpecifiersIn, withoutComments } from "@veyyon/utils/module-reach";
import { LEGACY_PI_MODULES_SPECIFIER } from "../packages/coding-agent/scripts/legacy-pi-virtual-module";
import { collectSourceFiles, REPO_ROOT } from "./workspace-layout";

/** One import of a package specifier: what was named and the file that named it. */
interface PackageImport {
	readonly specifier: string;
	readonly from: string;
}

/** Where one specifier landed: the file the runtime evaluates and the file TypeScript reads for it. */
interface ResolvedEntry {
	readonly specifier: string;
	readonly runtime: string;
	readonly declaration: string;
}

/** `require("x")` with a literal specifier. `moduleSpecifiersIn` does not read `require`. */
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

/** Conditions the declaration walk accepts, matching TypeScript's `bundler` resolution under Bun. */
const DECLARATION_CONDITIONS = new Set(["types", "bun", "import", "node", "default"]);

/** The package a bare specifier belongs to: `@scope/name` or `name`. */
function packageOf(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] as string);
}

/** Every specifier `source` loads at run time: static imports (which exclude `import type`), dynamic imports, requires. */
function runtimeSpecifiersIn(source: string): string[] {
	const found = [...moduleSpecifiersIn(source), ...dynamicImportSpecifiersIn(source)];
	for (const match of withoutComments(source).matchAll(REQUIRE_RE)) found.push(match[1] as string);
	return found;
}

/** Package imports in `files`, skipping relative paths and builtins. */
function packageImports(files: readonly string[]): PackageImport[] {
	const found: PackageImport[] = [];
	for (const from of files) {
		for (const specifier of runtimeSpecifiersIn(fs.readFileSync(from, "utf8"))) {
			if (specifier.startsWith(".") || specifier.startsWith("/") || specifier === "bun") continue;
			if (specifier.startsWith("bun:") || isBuiltin(specifier)) continue;
			found.push({ specifier, from });
		}
	}
	return found;
}

/** The directory of the package that owns `file`: the nearest `package.json` named `name`. */
function packageDirectoryOf(file: string, name: string): string | undefined {
	for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const manifestPath = path.join(dir, "package.json");
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown };
		if (manifest.name === name) return dir;
	}
	return undefined;
}

/** The first target a conditions tree yields under {@link DECLARATION_CONDITIONS}, in key order. */
function conditionTarget(target: unknown): string | undefined {
	if (typeof target === "string") return target;
	if (Array.isArray(target)) {
		for (const candidate of target) {
			const found = conditionTarget(candidate);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (target === null || typeof target !== "object") return undefined;
	for (const [condition, value] of Object.entries(target)) {
		if (!DECLARATION_CONDITIONS.has(condition)) continue;
		const found = conditionTarget(value);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The `exports` target for `subpath`, with a single-`*` pattern key substituted. */
function exportsTarget(exportsField: unknown, subpath: string): unknown {
	if (exportsField === null || typeof exportsField !== "object" || Array.isArray(exportsField)) {
		return subpath === "." ? exportsField : undefined;
	}
	const keys = Object.keys(exportsField);
	if (!keys.every(key => key.startsWith("."))) return subpath === "." ? exportsField : undefined;
	const map = exportsField as Record<string, unknown>;
	if (subpath in map) return map[subpath];
	let best: { key: string; prefix: string; star: string } | undefined;
	for (const key of keys) {
		const star = key.indexOf("*");
		if (star < 0) continue;
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < key.length - 1) continue;
		if (best && best.prefix.length >= prefix.length) continue;
		best = { key, prefix, star: subpath.slice(prefix.length, subpath.length - suffix.length) };
	}
	if (!best) return undefined;
	const matched = best;
	return JSON.parse(JSON.stringify(map[matched.key]).replaceAll("*", matched.star));
}

/** The declaration file beside a runtime file: `x.js` -> `x.d.ts`, `x.mjs` -> `x.d.mts`, `x.cjs` -> `x.d.cts`. */
function siblingDeclaration(file: string): string {
	if (/\.d\.[cm]?ts$/.test(file)) return file;
	return file.replace(/\.(m|c)?[jt]sx?$/, (_match, flavor: string | undefined) => `.d.${flavor ?? ""}ts`);
}

/** The file TypeScript reads for `specifier`, whose runtime file is `runtime`. */
function declarationOf(specifier: string, runtime: string): string {
	const name = packageOf(specifier);
	const dir = packageDirectoryOf(runtime, name);
	if (dir === undefined) return siblingDeclaration(runtime);
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
	const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
	if (manifest.exports !== undefined) {
		const target = conditionTarget(exportsTarget(manifest.exports, subpath));
		if (target !== undefined) return path.resolve(dir, siblingDeclaration(target));
	}
	const typesField = manifest.types ?? manifest.typings;
	if (subpath === "." && typeof typesField === "string") return path.resolve(dir, typesField);
	return siblingDeclaration(runtime);
}

/**
 * Pairs of specifiers that load one package's module through two builds, one line per pair, and the
 * specifiers the runtime cannot resolve from the file that names them.
 *
 * `Bun.resolveSync` because the question is which file Bun evaluates for a specifier named in a given
 * file, under Bun's own condition set; `node:module`'s `createRequire(...).resolve` answers it under
 * `require` conditions, which pick different files for a package that ships both.
 */
function alternateBuilds(imports: readonly PackageImport[]): { duplicates: string[]; unresolved: string[] } {
	const unresolved: string[] = [];
	const byPackage = new Map<string, Map<string, ResolvedEntry>>();
	for (const { specifier, from } of imports) {
		let runtime: string;
		try {
			runtime = fs.realpathSync(Bun.resolveSync(specifier, path.dirname(from)));
		} catch {
			unresolved.push(`${specifier} from ${path.relative(REPO_ROOT, from)}`);
			continue;
		}
		const name = packageOf(specifier);
		const entries = byPackage.get(name) ?? new Map<string, ResolvedEntry>();
		byPackage.set(name, entries);
		if (!entries.has(runtime)) {
			entries.set(runtime, { specifier, runtime, declaration: declarationOf(specifier, runtime) });
		}
	}
	const duplicates: string[] = [];
	for (const [name, entries] of byPackage) {
		const byDeclaration = new Map<string, ResolvedEntry[]>();
		for (const entry of entries.values()) {
			byDeclaration.set(entry.declaration, [...(byDeclaration.get(entry.declaration) ?? []), entry]);
		}
		for (const [declaration, builds] of byDeclaration) {
			if (builds.length < 2) continue;
			const loaded = builds.map(build => `"${build.specifier}" loads ${path.basename(build.runtime)}`).join(", ");
			duplicates.push(`${name}: ${loaded}; one module typed by ${path.basename(declaration)}`);
		}
	}
	return { duplicates: duplicates.sort(), unresolved: unresolved.sort() };
}

describe("shipped source reaches each package module through one build", () => {
	it("no two specifiers of one package load two builds of the module one declaration types", () => {
		const imports = packageImports(collectSourceFiles());
		const { duplicates, unresolved } = alternateBuilds(imports);
		// A specifier the runtime cannot resolve is one the sweep cannot judge. The one exception is the
		// module the binary build supplies through a plugin, which exists nowhere on disk.
		expect(unresolved.map(entry => entry.slice(0, entry.indexOf(" from ")))).toEqual([LEGACY_PI_MODULES_SPECIFIER]);
		expect(duplicates).toEqual([]);
		// The sweep read real imports: an empty import list would pass every assertion above.
		expect(imports.map(entry => packageOf(entry.specifier))).toContain("lru-cache");
	});
});

describe("the two-builds detector", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	/** A workspace with the named packages under `node_modules` and one source file importing `specifiers`. */
	function fixture(packages: Record<string, { manifest: object; files: string[] }>, specifiers: string[]) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-build-"));
		roots.push(root);
		for (const [name, { manifest, files }] of Object.entries(packages)) {
			const dir = path.join(root, "node_modules", name);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
			for (const file of files) {
				fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
				fs.writeFileSync(path.join(dir, file), "export {};\n");
			}
		}
		const from = path.join(root, "src", "index.ts");
		fs.mkdirSync(path.dirname(from), { recursive: true });
		fs.writeFileSync(from, "");
		return alternateBuilds(specifiers.map(specifier => ({ specifier, from })));
	}

	// Scoped, with declarations outside the build directory and a browser branch ahead of the node one,
	// so reading the package name, the exports entry and the condition set are each needed to match.
	const aliased = {
		manifest: {
			exports: {
				"./raw": {
					import: {
						browser: { types: "./types/browser.d.ts", default: "./dist/browser/index.js" },
						node: { types: "./types/node.d.ts", default: "./dist/node/index.js" },
					},
				},
				".": {
					import: {
						browser: { types: "./types/browser.d.ts", default: "./dist/browser/index.min.js" },
						node: { types: "./types/node.d.ts", default: "./dist/node/index.min.js" },
					},
				},
			},
		},
		files: ["dist/node/index.js", "dist/node/index.min.js"],
	};

	it("reports a package whose two entries declare one types file", () => {
		expect(fixture({ "@kit/cache": aliased }, ["@kit/cache", "@kit/cache/raw"]).duplicates).toEqual([
			'@kit/cache: "@kit/cache" loads index.min.js, "@kit/cache/raw" loads index.js; one module typed by node.d.ts',
		]);
	});

	it("does not report one entry imported from many places", () => {
		expect(fixture({ "@kit/cache": aliased }, ["@kit/cache/raw", "@kit/cache/raw"]).duplicates).toEqual([]);
	});

	it("does not report two modules whose only shared declaration is under a condition Bun does not match", () => {
		const distinct = {
			manifest: {
				exports: {
					".": {
						browser: { types: "./types/shared.d.ts", default: "./dist/browser.js" },
						types: "./types/index.d.ts",
						default: "./dist/index.js",
					},
					"./web": {
						browser: { types: "./types/shared.d.ts", default: "./dist/browser.js" },
						types: "./types/web.d.ts",
						default: "./dist/web.js",
					},
				},
			},
			files: ["dist/index.js", "dist/web.js"],
		};
		expect(fixture({ ui: distinct }, ["ui", "ui/web"]).duplicates).toEqual([]);
	});

	it("reads a wildcard entry's declaration from its own substitution", () => {
		const wildcard = {
			manifest: { exports: { "./*": { types: "./types/*.d.ts", default: "./dist/*.js" } } },
			files: ["dist/a.js", "dist/b.js"],
		};
		expect(fixture({ parts: wildcard }, ["parts/a", "parts/b"]).duplicates).toEqual([]);
	});

	it("reports a wildcard entry that types a different build like its explicit twin", () => {
		const twin = {
			manifest: {
				exports: {
					".": { types: "./types/core.d.ts", default: "./dist/core.min.js" },
					"./*": { types: "./types/*.d.ts", default: "./dist/*.js" },
				},
			},
			files: ["dist/core.js", "dist/core.min.js"],
		};
		expect(fixture({ twin }, ["twin", "twin/core"]).duplicates).toEqual([
			'twin: "twin" loads core.min.js, "twin/core" loads core.js; one module typed by core.d.ts',
		]);
	});

	it("types a package without exports from `types` and a deep import from its sibling", () => {
		const legacy = {
			manifest: { main: "lib/index.js", types: "lib/index.d.ts" },
			files: ["lib/index.js", "lib/extra.js"],
		};
		expect(fixture({ legacy }, ["legacy", "legacy/lib/extra.js"]).duplicates).toEqual([]);
		expect(fixture({ legacy }, ["legacy", "legacy/lib/index.js"]).duplicates).toEqual([]);
	});

	it("reports a deep import of the readable build beside a minified main", () => {
		const minified = {
			manifest: { main: "dist/index.min.js", types: "dist/index.d.ts" },
			files: ["dist/index.min.js", "dist/index.js"],
		};
		expect(fixture({ minified }, ["minified", "minified/dist/index.js"]).duplicates).toEqual([
			'minified: "minified" loads index.min.js, "minified/dist/index.js" loads index.js; one module typed by index.d.ts',
		]);
	});

	it("names a specifier the runtime cannot resolve instead of skipping it", () => {
		expect(fixture({ "@kit/cache": aliased }, ["@kit/cache/missing"]).unresolved).toEqual([
			expect.stringMatching(/^@kit\/cache\/missing from /),
		]);
	});

	it("reads the specifiers a module loads at run time, not the ones it names for types", () => {
		const source = [
			'import type { A } from "types-only";',
			'import { B } from "static";',
			'import "side-effect";',
			'export { C } from "re-export";',
			'const lazy = await import("dynamic");',
			'const cjs = require("required");',
			'// import { D } from "commented";',
		].join("\n");
		expect(runtimeSpecifiersIn(source).sort()).toEqual(["dynamic", "re-export", "required", "side-effect", "static"]);
	});
});
