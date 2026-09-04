import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import { isRecord } from "@veyyon/utils/type-guards";
import { typeScriptMembersOf } from "../../../scripts/workspace-layout";

/** Build-time specifier resolved to bundled legacy Pi module namespaces. */
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
	readonly identifier: string;
	readonly rootShim: ShimSource | null;
}

const CODING_AGENT = "@veyyon/coding-agent";
const KERNEL = "@veyyon/kernel";

const BUNDLED_PACKAGES: readonly BundledPackage[] = [
	{ name: "@veyyon/agent-core", identifier: "PiAgentCore", rootShim: null },
	{
		name: "@veyyon/ai",
		identifier: "PiAi",
		rootShim: { package: KERNEL, module: "src/loader/legacy-pi-ai-shim.ts" },
	},
	{
		name: CODING_AGENT,
		identifier: "PiCodingAgent",
		rootShim: { package: CODING_AGENT, module: "src/extensibility/legacy-pi-coding-agent-shim.ts" },
	},
	{ name: "@veyyon/natives", identifier: "PiNatives", rootShim: null },
	{
		name: "@veyyon/tui",
		identifier: "PiTui",
		rootShim: { package: CODING_AGENT, module: "src/extensibility/legacy-pi-tui-shim.ts" },
	},
	{ name: "@veyyon/utils", identifier: "PiUtils", rootShim: null },
];

/** The bundled package names, so a sweep states the subject rather than restating this table. */
export const BUNDLED_PACKAGE_NAMES: readonly string[] = BUNDLED_PACKAGES.map(pkg => pkg.name);

const TYPEBOX_MODULE_KEY = "typebox";
const TYPEBOX_SHIM: ShimSource = { package: KERNEL, module: "src/registry/typebox.ts" };
const SKIPPED_WILDCARD_BASENAMES = new Set(["index"]);
const MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES = new Set(["worker-entry"]);

/** One namespace module the binary must retain for legacy extension imports. */
export interface BundledPiEntry {
	/** Canonical import key exposed to extensions. */
	readonly key: string;
	/** Unique identifier used by the virtual module's generated import. */
	readonly binding: string;
	/** Package or absolute source specifier compiled into the binary. */
	readonly importSpecifier: string;
}

interface WildcardPattern {
	readonly exportPrefix: string;
	readonly exportSuffix: string;
	readonly sourcePrefix: string;
	readonly sourceSuffix: string;
}

function bindingForSubpath(identifier: string, subpath: string): string {
	const segments = subpath
		.split("/")
		.filter(Boolean)
		.map(segment =>
			segment
				.split(/[-_]/)
				.filter(Boolean)
				.map(part => part.charAt(0).toUpperCase() + part.slice(1))
				.join(""),
		);
	return `bundled${identifier}${segments.join("")}`;
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
	const seenBindings = new Set<string>();
	function addEntry(key: string, binding: string, importSpecifier: string): void {
		if (seenKeys.has(key)) return;
		if (seenBindings.has(binding)) {
			throw new Error(`Duplicate bundled Pi binding ${binding} for ${key}`);
		}
		seenKeys.add(key);
		seenBindings.add(binding);
		entries.push({ key, binding, importSpecifier });
	}

	for (const pkg of BUNDLED_PACKAGES) {
		const packageRoot = await memberDirectory(pkg.name);
		const { name, exports: exportsField } = await readBundledManifest(packageRoot);
		const rootSpecifier = pkg.rootShim ? await shimSpecifier(pkg.rootShim) : name;
		addEntry(name, `bundled${pkg.identifier}`, rootSpecifier);

		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
			const subpath = exportKey.slice(2);
			const key = `${name}/${subpath}`;
			addEntry(key, bindingForSubpath(pkg.identifier, subpath), key);
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
					addEntry(key, bindingForSubpath(pkg.identifier, subpath), key);
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}

	addEntry(TYPEBOX_MODULE_KEY, "bundledTypeBoxShim", await shimSpecifier(TYPEBOX_SHIM));
	return entries;
}

function renderVirtualModule(entries: readonly BundledPiEntry[]): string {
	const imports = entries.map(entry => `import * as ${entry.binding} from ${JSON.stringify(entry.importSpecifier)};`);
	const modules = entries.map(entry => `\t${JSON.stringify(entry.key)}: ${entry.binding},`);
	return [...imports, "", "export const BUNDLED_PI_MODULES = {", ...modules, "};", ""].join("\n");
}

/**
 * Build plugin that materializes the legacy Pi module graph entirely in
 * memory. Bun still needs static import edges at compile time, but no generated
 * source or key-list file is written to the repository.
 */
export async function createLegacyPiVirtualModulePlugin(): Promise<Bun.BunPlugin> {
	const source = renderVirtualModule(await collectBundledPiEntries());
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
