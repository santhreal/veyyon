import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import { isRecord } from "@veyyon/utils/type-guards";
import { typeScriptMembersOf } from "../../../scripts/workspace-layout";

/** Build-time specifier resolved to the bundled legacy Pi module table. */
export const LEGACY_PI_MODULES_SPECIFIER = "veyyon-legacy-pi-modules";

const VIRTUAL_NAMESPACE = "veyyon-legacy-pi-modules-build";
const packageDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageDir, "..", "..");

/** One compat shim, named by the package that owns it rather than by a path this file spells. */
interface ShimSource {
	/** The published name of the workspace package the shim file lives in. */
	readonly package: string;
	/** The shim's path inside that package, forward-slashed. */
	readonly module: string;
}

interface BundledPackage {
	/** The published package name, which is what a member's manifest declares and a specifier says. */
	readonly name: string;
	readonly rootShim: ShimSource | null;
}

const CODING_AGENT = "@veyyon/coding-agent";
const KERNEL = "@veyyon/kernel";

const BUNDLED_PACKAGES: readonly BundledPackage[] = [
	{ name: "@veyyon/agent-core", rootShim: null },
	{ name: "@veyyon/ai", rootShim: { package: KERNEL, module: "src/loader/legacy-pi-ai-shim.ts" } },
	{
		name: CODING_AGENT,
		rootShim: { package: CODING_AGENT, module: "src/extensibility/legacy-pi-coding-agent-shim.ts" },
	},
	{ name: "@veyyon/natives", rootShim: null },
	{ name: "@veyyon/tui", rootShim: { package: CODING_AGENT, module: "src/extensibility/legacy-pi-tui-shim.ts" } },
	{ name: "@veyyon/utils", rootShim: null },
];

/** The bundled package names, so a sweep states the subject rather than restating this table. */
export const BUNDLED_PACKAGE_NAMES: readonly string[] = BUNDLED_PACKAGES.map(pkg => pkg.name);

const TYPEBOX_MODULE_KEY = "typebox";
const TYPEBOX_SHIM: ShimSource = { package: KERNEL, module: "src/registry/typebox.ts" };
const SKIPPED_WILDCARD_BASENAMES = new Set(["index"]);
const MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES = new Set(["worker-entry"]);

/** One module the binary must retain for legacy extension imports. */
export interface BundledPiEntry {
	/** Canonical import key exposed to extensions. */
	readonly key: string;
	/** Package or absolute source specifier compiled into the binary. */
	readonly importSpecifier: string;
}

/** A bundled entry with the export names the bundler links for its module. */
export interface BundledPiModule extends BundledPiEntry {
	/**
	 * Every export name of the entry's module, `default` included, or `null` for a module the
	 * bundler treats as CommonJS, whose names exist only once it runs.
	 */
	readonly exports: readonly string[] | null;
}

interface WildcardPattern {
	readonly exportPrefix: string;
	readonly exportSuffix: string;
	readonly sourcePrefix: string;
	readonly sourceSuffix: string;
}

function isSafeWildcardBasename(basename: string): boolean {
	if (!basename || basename.startsWith(".") || basename.startsWith("_")) return false;
	if (SKIPPED_WILDCARD_BASENAMES.has(basename)) return false;
	if (MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES.has(basename)) return false;
	return !/\.(test|spec|d|generated|bench)$/.test(basename);
}

function parseWildcardPattern(exportKey: string, sourcePattern: string): WildcardPattern | null {
	const exportStar = exportKey.indexOf("*");
	const sourceStar = sourcePattern.indexOf("*");
	if (exportStar === -1 || sourceStar === -1) return null;
	if (exportKey.indexOf("*", exportStar + 1) !== -1) return null;
	if (sourcePattern.indexOf("*", sourceStar + 1) !== -1) return null;
	if (!sourcePattern.startsWith("./")) return null;
	return {
		exportPrefix: exportKey.slice(2, exportStar),
		exportSuffix: exportKey.slice(exportStar + 1),
		sourcePrefix: sourcePattern.slice(2, sourceStar),
		sourceSuffix: sourcePattern.slice(sourceStar + 1),
	};
}

function exportImportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (isRecord(value) && typeof value.import === "string") return value.import;
	return null;
}

/**
 * The absolute path of a shim, resolved through the member directory of the package that owns it.
 *
 * The path used to be built from this package's own `src/extensibility`, which stopped resolving the
 * day the pi-ai and TypeBox shims moved into `@veyyon/kernel`: the bundler reported two unresolvable
 * entrypoints and the binary never built. A missing file fails here instead, naming the shim.
 */
async function shimSpecifier(shim: ShimSource): Promise<string> {
	const file = path.join(await memberDirectory(shim.package), shim.module);
	if (!(await fileExists(file))) {
		throw new Error(`Bundled Pi root shim ${shim.package}/${shim.module} is missing from this checkout: ${file}`);
	}
	return file;
}

async function fileExists(file: string): Promise<boolean> {
	try {
		return (await fs.stat(file)).isFile();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

interface BundledManifest {
	readonly name: string;
	readonly exports: Record<string, unknown>;
}

/**
 * Every workspace member directory, by the package name its manifest declares.
 *
 * A bundled package used to be named by its directory under `packages/`, which stopped being true
 * the day `@veyyon/tui` became `hosts/terminal/engine` and `@veyyon/natives` became
 * `natives/bridge/bindings`: the binary build died on a manifest path that no longer exists. The
 * member list is the package manager's own answer to "where does this package live", so a member
 * that moves again is followed rather than restated here.
 */
let memberDirectoriesByName: Map<string, string> | undefined;

async function memberDirectory(name: string): Promise<string> {
	if (!memberDirectoriesByName) {
		const resolved = new Map<string, string>();
		for (const member of typeScriptMembersOf(repoRoot)) {
			const manifest: unknown = JSON.parse(await fs.readFile(path.join(repoRoot, member, "package.json"), "utf8"));
			if (isRecord(manifest) && typeof manifest.name === "string") resolved.set(manifest.name, member);
		}
		memberDirectoriesByName = resolved;
	}
	const directory = memberDirectoriesByName.get(name);
	if (directory === undefined) {
		throw new Error(`Bundled Pi package ${name} is not a workspace member of this checkout`);
	}
	return path.join(repoRoot, directory);
}

/**
 * Where each bundled package sits in this checkout, by name.
 *
 * Exported so a suite can sweep it: a member that moves and a member whose manifest name changes
 * both break the binary build here, and nothing else in the test suite compiles a binary.
 */
export async function bundledPackageDirectories(): Promise<Map<string, string>> {
	const resolved = new Map<string, string>();
	for (const pkg of BUNDLED_PACKAGES) resolved.set(pkg.name, await memberDirectory(pkg.name));
	return resolved;
}

async function readBundledManifest(packageRoot: string): Promise<BundledManifest> {
	const manifestPath = path.join(packageRoot, "package.json");
	const manifest: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
	if (!isRecord(manifest) || typeof manifest.name !== "string") {
		throw new Error(`Bundled Pi package manifest has no name: ${manifestPath}`);
	}
	return { name: manifest.name, exports: isRecord(manifest.exports) ? manifest.exports : {} };
}

/**
 * Package root keys served by a legacy compat shim instead of the canonical
 * package entrypoint, because the shim re-attaches a surface the canonical
 * barrel dropped. Derived from `BUNDLED_PACKAGES`, so a package that gains or
 * loses a root shim never leaves a second list behind to go stale.
 */
export async function collectShimmedRootKeys(): Promise<string[]> {
	const keys: string[] = [];
	for (const pkg of BUNDLED_PACKAGES) {
		if (!pkg.rootShim) continue;
		keys.push((await readBundledManifest(await memberDirectory(pkg.name))).name);
	}
	return keys;
}

/**
 * Derive the bundled legacy Pi module surface from current package exports.
 * Named wildcard exports are expanded from source; root catch-alls stay out to
 * avoid importing CLI entrypoints and other non-extension surfaces.
 */
export async function collectBundledPiEntries(): Promise<BundledPiEntry[]> {
	const entries: BundledPiEntry[] = [];
	const seenKeys = new Set<string>();
	function addEntry(key: string, importSpecifier: string): void {
		if (seenKeys.has(key)) return;
		seenKeys.add(key);
		entries.push({ key, importSpecifier });
	}

	for (const pkg of BUNDLED_PACKAGES) {
		const packageRoot = await memberDirectory(pkg.name);
		const { name, exports: exportsField } = await readBundledManifest(packageRoot);
		const rootSpecifier = pkg.rootShim ? await shimSpecifier(pkg.rootShim) : name;
		addEntry(name, rootSpecifier);

		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
			const subpath = exportKey.slice(2);
			const key = `${name}/${subpath}`;
			addEntry(key, key);
		}

		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || !exportKey.includes("*")) continue;
			const sourcePattern = exportImportTarget(exportsField[exportKey]);
			if (!sourcePattern) continue;
			const pattern = parseWildcardPattern(exportKey, sourcePattern);
			if (!pattern || !/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(pattern.sourceSuffix)) continue;
			if (pattern.exportPrefix === "" || pattern.exportPrefix === "/") continue;

			const sourceDir = path.join(packageRoot, pattern.sourcePrefix);
			try {
				const glob = new Bun.Glob(`*${pattern.sourceSuffix}`);
				const matches: string[] = [];
				for await (const match of glob.scan({ cwd: sourceDir, onlyFiles: true })) {
					matches.push(match);
				}
				matches.sort();
				for (const match of matches) {
					if (!match.endsWith(pattern.sourceSuffix)) continue;
					const basename = match.slice(0, match.length - pattern.sourceSuffix.length);
					if (!isSafeWildcardBasename(basename) || basename.includes("/")) continue;
					const subpath = `${pattern.exportPrefix}${basename}${pattern.exportSuffix}`;
					const key = `${name}/${subpath}`;
					addEntry(key, key);
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}

	addEntry(TYPEBOX_MODULE_KEY, await shimSpecifier(TYPEBOX_SHIM));
	return entries;
}

/**
 * The export names of each entry's module, read from the metafile of one split in-memory build
 * whose entry points are the entries' modules. The bundler resolves `export *` chains here the same
 * way it does for the binary, so a named import of every reported name links there. `external`
 * lists the specifiers the binary build does not bundle.
 */
export async function resolveBundledPiExports(
	entries: readonly BundledPiEntry[],
	external: readonly string[],
): Promise<BundledPiModule[]> {
	const files = entries.map(entry =>
		path.isAbsolute(entry.importSpecifier)
			? entry.importSpecifier
			: Bun.resolveSync(entry.importSpecifier, packageDir),
	);
	const output = await Bun.build({
		entrypoints: [...new Set(files)],
		root: repoRoot,
		target: "bun",
		external: [...external, LEGACY_PI_MODULES_SPECIFIER],
		splitting: true,
		format: "esm",
		metafile: true,
		throw: false,
	});
	if (!output.success || !output.metafile) {
		throw new Error(`Bundled Pi export pass failed:\n${output.logs.map(log => log.message).join("\n")}`);
	}
	// Metafile paths are relative to the working directory, not to `root`.
	const exportsByFile = new Map<string, readonly string[]>();
	for (const chunk of Object.values(output.metafile.outputs)) {
		if (chunk.entryPoint) exportsByFile.set(path.resolve(chunk.entryPoint), chunk.exports);
	}
	const commonJs = new Set<string>();
	for (const [file, input] of Object.entries(output.metafile.inputs)) {
		if (input.format === "cjs") commonJs.add(path.resolve(file));
	}
	// A star re-export of an external module has names no build-time pass can list; the binary
	// would serve an extension a module missing them.
	for (const artifact of output.outputs) {
		if (artifact.kind === "entry-point" && /\bexport\s*\*/.test(await artifact.text())) {
			throw new Error(`Bundled Pi entry ${artifact.path} re-exports an external module with export *`);
		}
	}
	return entries.map((entry, index) => {
		const file = files[index]!;
		if (commonJs.has(file)) return { ...entry, exports: null };
		const exports = exportsByFile.get(file);
		if (!exports) throw new Error(`Bundled Pi export pass reported no exports for ${entry.key} (${file})`);
		return { ...entry, exports };
	});
}

/**
 * The table module: one named import per export and, per key, a function that builds that key's
 * export record. A namespace import (`import * as`) of an ES module makes the bundler emit an export
 * object with one getter closure per export in that module's own chunk, built when the chunk loads,
 * which is at startup for most of them. A named import adds no object to the exporting module, and
 * a record exists only for a key an extension imports. A CommonJS module is imported as a
 * namespace: the bundler builds that object in the importing module, here the table.
 */
export function renderBundledPiModules(modules: readonly BundledPiModule[]): string {
	const imports: string[] = [];
	const loaders: string[] = [];
	let binding = 0;
	for (const module of modules) {
		const source = JSON.stringify(module.importSpecifier);
		const key = JSON.stringify(module.key);
		if (module.exports === null) {
			const local = `$${binding++}`;
			imports.push(`import * as ${local} from ${source};`);
			loaders.push(`\t${key}: () => ${local},`);
			continue;
		}
		const specifiers: string[] = [];
		const fields: string[] = [];
		for (const name of module.exports) {
			const local = `$${binding++}`;
			const quoted = JSON.stringify(name);
			specifiers.push(`${quoted} as ${local}`);
			fields.push(`${quoted}: ${local}`);
		}
		imports.push(specifiers.length > 0 ? `import { ${specifiers.join(", ")} } from ${source};` : `import ${source};`);
		loaders.push(`\t${key}: () => ({ ${fields.join(", ")} }),`);
	}
	return [...imports, "", "export const BUNDLED_PI_MODULES = {", ...loaders, "};", ""].join("\n");
}

/**
 * Build plugin that materializes the legacy Pi module table entirely in memory. Bun still needs
 * static import edges at compile time, but no generated source or key-list file is written to the
 * repository. `external` is the binary build's own external list.
 */
export async function createLegacyPiVirtualModulePlugin(external: readonly string[]): Promise<Bun.BunPlugin> {
	const source = renderBundledPiModules(await resolveBundledPiExports(await collectBundledPiEntries(), external));
	return {
		name: "veyyon:legacy-pi-modules",
		setup(build) {
			build.onResolve({ filter: /^veyyon-legacy-pi-modules$/ }, () => ({
				path: LEGACY_PI_MODULES_SPECIFIER,
				namespace: VIRTUAL_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, () => ({ contents: source, loader: "ts" }));
		},
	};
}
