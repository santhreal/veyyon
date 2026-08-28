/**
 * The static import graph of a module: every file a Bun process evaluates when
 * it imports that entry, with `await import(...)` treated as a cut.
 *
 * Evaluation at startup is decided by static reachability — a dynamic import
 * evaluates nothing until it is called — so walking `import` statements answers
 * "does this load when the CLI starts" without running the CLI, and without a
 * loader plugin that would have to re-parse third-party CommonJS.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const jsTranspiler = new Bun.Transpiler({ loader: "js" });

export interface WorkspacePackage {
	name: string;
	dir: string;
	exports?: unknown;
}

export interface StartupImportGraph {
	/** Absolute paths of every source file the entry evaluates. */
	files: ReadonlySet<string>;
	/** Package names resolved out of the walk: workspace packages and node_modules alike. */
	packages: ReadonlySet<string>;
	/** Files whose imports could not be scanned. A non-empty list invalidates the walk. */
	unscannable: readonly string[];
}

interface PackageManifest {
	name?: string;
	exports?: Record<string, unknown>;
	dependencies?: Record<string, string>;
}

function readManifest(dir: string): PackageManifest | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageManifest;
	} catch {
		return undefined;
	}
}

/** Every workspace package under `<repoRoot>/packages`, keyed by its declared name. */
export function workspacePackages(repoRoot: string): Map<string, WorkspacePackage> {
	const found = new Map<string, WorkspacePackage>();
	const packagesDir = join(repoRoot, "packages");
	for (const entry of new Bun.Glob("*/package.json").scanSync({ cwd: packagesDir })) {
		const dir = join(packagesDir, dirname(entry));
		const manifest = readManifest(dir);
		if (manifest?.name) found.set(manifest.name, { name: manifest.name, dir, exports: manifest.exports });
	}
	return found;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function firstExisting(base: string): string | undefined {
	const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")];
	return candidates.find(isFile);
}

function exportTarget(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") {
		for (const condition of ["bun", "import", "default", "node", "require"]) {
			const nested = (entry as Record<string, unknown>)[condition];
			if (nested !== undefined) return exportTarget(nested);
		}
	}
	return undefined;
}

/** Resolve `spec` against a workspace package's exports map, or its `src` layout. */
function resolveWorkspace(spec: string, packages: Map<string, WorkspacePackage>): string | undefined {
	const segments = spec.split("/");
	const name = spec.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
	const pkg = name === undefined ? undefined : packages.get(name);
	if (!pkg) return undefined;
	const subpath = `.${spec.slice(name.length)}`;
	const map = pkg.exports as Record<string, unknown> | undefined;
	if (map) {
		const direct = exportTarget(map[subpath]);
		if (direct) return firstExisting(join(pkg.dir, direct));
		for (const [pattern, value] of Object.entries(map)) {
			if (!pattern.includes("*")) continue;
			const [prefix, suffix] = pattern.split("*");
			if (prefix === undefined || suffix === undefined) continue;
			if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
			const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
			const target = exportTarget(value);
			const resolved = target ? firstExisting(join(pkg.dir, target.replace("*", middle))) : undefined;
			if (resolved) return resolved;
		}
	}
	return firstExisting(join(pkg.dir, "src", subpath === "." ? "index" : subpath.slice(2)));
}

function transpilerFor(path: string): Bun.Transpiler {
	if (path.endsWith(".tsx") || path.endsWith(".jsx")) return tsxTranspiler;
	if (path.endsWith(".ts")) return tsTranspiler;
	return jsTranspiler;
}

function packageOfNodeModulePath(path: string): string {
	const rest = path.slice(path.lastIndexOf("/node_modules/") + "/node_modules/".length).split("/");
	return rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : (rest[0] ?? "");
}

/**
 * Walk `entry`'s static imports. `import type` is erased by the transpiler, so a
 * type-only edge never enters the graph — which is the point: it costs nothing
 * at run time.
 */
export function buildStartupImportGraph(repoRoot: string, entry: string): StartupImportGraph {
	const packages = workspacePackages(repoRoot);
	const files = new Set<string>();
	const named = new Set<string>();
	const unscannable: string[] = [];

	const visit = (file: string): void => {
		if (files.has(file)) return;
		files.add(file);
		if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) return;
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			unscannable.push(file);
			return;
		}
		if (source.startsWith("#!")) source = source.slice(source.indexOf("\n") + 1);
		let imports: Bun.Import[];
		try {
			imports = transpilerFor(file).scanImports(source);
		} catch {
			unscannable.push(file);
			return;
		}
		for (const imported of imports) {
			if (imported.kind !== "import-statement") continue;
			const spec = imported.path;
			if (spec === "bun" || spec.startsWith("node:") || spec.startsWith("bun:")) continue;
			let resolved: string | undefined;
			if (spec.startsWith(".") || spec.startsWith("/")) {
				resolved =
					firstExisting(resolve(dirname(file), spec)) ?? firstExisting(resolve(dirname(file), spec, "index"));
				if (!resolved) {
					try {
						resolved = Bun.resolveSync(spec, dirname(file));
					} catch {
						unscannable.push(`${file} -> ${spec}`);
						continue;
					}
				}
			} else {
				resolved = resolveWorkspace(spec, packages);
				if (resolved) named.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
				else {
					try {
						resolved = Bun.resolveSync(spec, dirname(file));
					} catch {
						// A dependency this machine has not installed still names itself.
						named.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
						continue;
					}
				}
			}
			if (resolved.includes("/node_modules/")) {
				named.add(packageOfNodeModulePath(resolved));
				continue;
			}
			visit(resolved);
		}
	};

	visit(entry);
	return { files, packages: named, unscannable };
}

/** The dependencies `packages/coding-agent/package.json` declares. */
export function declaredDependencies(repoRoot: string): readonly string[] {
	const manifest = readManifest(join(repoRoot, "packages", "coding-agent"));
	return Object.keys(manifest?.dependencies ?? {}).sort();
}
