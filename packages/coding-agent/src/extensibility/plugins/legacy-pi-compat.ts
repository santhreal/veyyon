/// <reference path="./legacy-pi-virtual-modules.d.ts" />
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import * as url from "node:url";
import {
	errorMessage,
	escapeRegExp,
	hasUriScheme,
	isCompiledBinary,
	isEnoent,
	isRecord,
	logger,
	pathExistsQuietly,
	stripWindowsExtendedLengthPathPrefix,
} from "@veyyon/utils";
import { registerPluginCacheInvalidator } from "../../discovery/helpers";

const IS_COMPILED_BINARY = isCompiledBinary();

const BUNDLED_VIRTUAL_SCHEME = "veyyon-legacy-pi-bundled:";
const BUNDLED_VIRTUAL_NAMESPACE = "veyyon-legacy-pi-bundled";
const BUNDLED_MODULES_GLOBAL = "__veyyonLegacyPiBundledModules";
const TYPEBOX_BUNDLED_MODULE_KEY = "typebox";

type BundledModules = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

let bundledModulesPromise: Promise<BundledModules> | null = null;

function ensureBundledModulesLoaded(): Promise<BundledModules> {
	if (!IS_COMPILED_BINARY) {
		return Promise.reject(new Error("veyyon:legacy-pi-shim: bundled modules are only available in compiled mode"));
	}
	if (!bundledModulesPromise) {
		bundledModulesPromise = import("veyyon-legacy-pi-modules").then(module => {
			Reflect.set(globalThis, BUNDLED_MODULES_GLOBAL, module.BUNDLED_PI_MODULES);
			return module.BUNDLED_PI_MODULES;
		});
	}
	return bundledModulesPromise;
}

function bundledModuleVirtualSpecifier(moduleKey: string): string {
	return `${BUNDLED_VIRTUAL_SCHEME}${moduleKey}`;
}

function isBundledVirtualSpecifier(value: string): boolean {
	return value.startsWith(BUNDLED_VIRTUAL_SCHEME);
}

function synthesizeBundledModuleSourceFromModules(moduleKey: string, modules: BundledModules): string {
	const mod = modules[moduleKey];
	if (!mod) {
		throw new Error(`veyyon:legacy-pi-shim: no bundled module registered for ${moduleKey}`);
	}
	const lines: string[] = [
		`const __veyyon_bundled = globalThis[${JSON.stringify(BUNDLED_MODULES_GLOBAL)}][${JSON.stringify(moduleKey)}];`,
	];
	let hasDefault = false;
	for (const exportName in mod) {
		if (exportName === "default") {
			hasDefault = true;
			continue;
		}
		lines.push(`export const ${exportName} = __veyyon_bundled[${JSON.stringify(exportName)}];`);
	}
	if (hasDefault) {
		lines.push("export default __veyyon_bundled.default;");
	}
	lines.push("");
	return lines.join("\n");
}

async function synthesizeBundledModuleSource(moduleKey: string): Promise<string> {
	const modules = await ensureBundledModulesLoaded();
	return synthesizeBundledModuleSourceFromModules(moduleKey, modules);
}

export function __synthesizeLegacyPiBundledSourceWithModules(
	moduleKey: string,
	modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
	return synthesizeBundledModuleSourceFromModules(moduleKey, modules);
}

export function __getLegacyPiBundledModulesGlobal(): string {
	return BUNDLED_MODULES_GLOBAL;
}

const CANONICAL_PI_SCOPE = "@veyyon";

const VEYYON_SCOPE_ALIASES = ["veyyon", "oh-my-pi", "mariozechner", "earendil-works"] as const;

const VEYYON_PACKAGE_NAMES = [
	"agent-core",
	"pi-agent-core",
	"ai",
	"pi-ai",
	"coding-agent",
	"pi-coding-agent",
	"natives",
	"pi-natives",
	"tui",
	"pi-tui",
	"utils",
	"pi-utils",
] as const;

const VEYYON_SCOPE_ALTERNATION = VEYYON_SCOPE_ALIASES.join("|");
const VEYYON_PACKAGE_ALTERNATION = VEYYON_PACKAGE_NAMES.join("|");

const VEYYON_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	["pi-ai/utils/oauth", "pi-ai/oauth"],
	["pi-ai/utils/oauth/", "pi-ai/oauth/"],
]);

function remapLegacyPiSubpath(rest: string): string {
	const exact = VEYYON_SUBPATH_REMAPS.get(rest);
	if (exact) {
		return exact;
	}

	for (const [from, to] of VEYYON_SUBPATH_REMAPS) {
		if (from.endsWith("/") && rest.startsWith(from)) {
			return `${to}${rest.slice(from.length)}`;
		}
	}

	return rest;
}

const LEGACY_PI_SPECIFIER_FILTER = new RegExp(
	`^@(?:${VEYYON_SCOPE_ALTERNATION})/(?:${VEYYON_PACKAGE_ALTERNATION})(?:/.*)?$`,
);
const LEGACY_PI_IMPORT_SPECIFIER_REGEX = new RegExp(
	`((?:from\\s+|import\\s+|import\\s*\\(\\s*)["'])(@(?:${VEYYON_SCOPE_ALTERNATION})/(?:${VEYYON_PACKAGE_ALTERNATION})(?:/[^"'()\\s]+)?)(["'])`,
	"g",
);
const resolvedSpecifierFallbacks = new Map<string, string>();
const SOURCE_MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SUPPORTED_PACKAGE_IMPORT_CONDITIONS = new Set(["bun", "node", "import", "default"]);
const packageRootCache = new Map<string, string | null>();
const packageImportsCache = new Map<string, Record<string, unknown> | null>();
const nodePackageRootCache = new Map<string, Promise<string | null>>();
const packageManifestCache = new Map<string, Promise<Record<string, unknown> | null>>();
const bareDependencyResolutionCache = new Map<string, Promise<string | null>>();
const realpathCache = new Map<string, Promise<string>>();
const nativeAddonResolutionCache = new Map<string, Promise<string | null>>();
const nativeAddonRequireScanCache = new Map<string, Promise<boolean>>();
const nativeAddonLoaderModulePaths = new Set<string>();

function clearLegacyPiResolutionCaches(): void {
	resolvedSpecifierFallbacks.clear();
	packageRootCache.clear();
	packageImportsCache.clear();
	nodePackageRootCache.clear();
	packageManifestCache.clear();
	bareDependencyResolutionCache.clear();
	nativeAddonResolutionCache.clear();
	nativeAddonRequireScanCache.clear();
	nativeAddonLoaderModulePaths.clear();
	realpathCache.clear();
}

registerPluginCacheInvalidator(clearLegacyPiResolutionCaches);
const PACKAGE_IMPORT_EXCLUDED = Symbol("packageImportExcluded");

const TYPEBOX_SPECIFIER_FILTER = /^(?:@sinclair\/typebox|typebox)$/;

export function __computeBundledSelfPackageRoot(metaDir: string, pathImpl: typeof path = path): string {
	const normalizedMetaDir = pathImpl.normalize(metaDir);
	if (pathImpl.basename(normalizedMetaDir) === "dist") {
		return pathImpl.resolve(metaDir, "..");
	}

	const pluginsDirSuffix = pathImpl.join("src", "extensibility", "plugins");
	if (normalizedMetaDir.endsWith(pluginsDirSuffix)) {
		return pathImpl.resolve(metaDir, "..", "..", "..");
	}

	return pathImpl.resolve(metaDir);
}

function resolveBundledSelfPackageRoot(): string | undefined {
	if (!process.env.VEYYON_BUNDLED) return undefined;
	return __computeBundledSelfPackageRoot(import.meta.dir);
}

const BUNDLED_SELF_PACKAGE_ROOT = resolveBundledSelfPackageRoot();

function sourceShimPath(file: string): string {
	return BUNDLED_SELF_PACKAGE_ROOT
		? path.join(BUNDLED_SELF_PACKAGE_ROOT, "src", "extensibility", file)
		: path.resolve(import.meta.dir, "..", file);
}

export function __resolveTypeBoxShimPath(
	isCompiled: boolean,
	sourcePath: string,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): string | null {
	if (isCompiled) {
		return bundledModuleVirtualSpecifier(TYPEBOX_BUNDLED_MODULE_KEY);
	}
	return pathExistsSync(sourcePath) ? sourcePath : null;
}

const TYPEBOX_SHIM_PATH = __resolveTypeBoxShimPath(IS_COMPILED_BINARY, sourceShimPath("typebox.ts"));

const LEGACY_PI_AI_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-ai`)
	: sourceShimPath("legacy-pi-ai-shim.ts");

const LEGACY_PI_CODING_AGENT_SHIM_PATH = IS_COMPILED_BINARY
	? bundledModuleVirtualSpecifier(`${CANONICAL_PI_SCOPE}/pi-coding-agent`)
	: sourceShimPath("legacy-pi-coding-agent-shim.ts");

export function __validateLegacyPiPackageRootOverrides(
	candidates: Record<string, string>,
	pathExistsSync: (p: string) => boolean = fs.existsSync,
): Record<string, string> {
	const valid: Record<string, string> = {};
	for (const key in candidates) {
		const candidate = candidates[key];
		if (candidate && (isBundledVirtualSpecifier(candidate) || pathExistsSync(candidate))) {
			valid[key] = candidate;
		}
	}
	return valid;
}

export function __buildLegacyPiPackageRootOverrides(
	isCompiled: boolean,
	bundledModuleKeys: Iterable<string> = [],
): Record<string, string> {
	const candidates: Record<string, string> = {
		[`${CANONICAL_PI_SCOPE}/pi-ai`]: LEGACY_PI_AI_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/ai`]: LEGACY_PI_AI_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/pi-coding-agent`]: LEGACY_PI_CODING_AGENT_SHIM_PATH,
		[`${CANONICAL_PI_SCOPE}/coding-agent`]: LEGACY_PI_CODING_AGENT_SHIM_PATH,
	};
	if (isCompiled) {
		for (const key of bundledModuleKeys) {
			if (key in candidates || key === TYPEBOX_BUNDLED_MODULE_KEY) continue;
			candidates[key] = bundledModuleVirtualSpecifier(key);
		}
	}
	return __validateLegacyPiPackageRootOverrides(candidates);
}

let legacyPiPackageRootOverrides = __buildLegacyPiPackageRootOverrides(IS_COMPILED_BINARY);
let legacyPiOverridesReadyPromise: Promise<void> | null = null;

function ensureLegacyPiOverridesReady(): Promise<void> {
	if (!IS_COMPILED_BINARY) {
		return Promise.resolve();
	}
	if (!legacyPiOverridesReadyPromise) {
		legacyPiOverridesReadyPromise = ensureBundledModulesLoaded().then(modules => {
			legacyPiPackageRootOverrides = __buildLegacyPiPackageRootOverrides(true, Object.keys(modules));
		});
	}
	return legacyPiOverridesReadyPromise;
}

let isLegacyPiSpecifierShimInstalled = false;

function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) {
		return null;
	}
	const slashIdx = specifier.indexOf("/", 1);
	if (slashIdx === -1) {
		return null;
	}
	const rest = specifier.slice(slashIdx + 1);
	const remappedSubpath = remapLegacyPiSubpath(rest);
	return `${CANONICAL_PI_SCOPE}/${remappedSubpath}`;
}

export function __remapLegacyPiSpecifier(specifier: string): string | null {
	return remapLegacyPiSpecifier(specifier);
}

function getResolvedSpecifier(specifier: string): string {
	const cached = resolvedSpecifierFallbacks.get(specifier);
	if (cached) {
		return cached;
	}

	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	resolvedSpecifierFallbacks.set(specifier, resolved);
	return resolved;
}

const CANONICAL_PI_BASENAMES: ReadonlySet<string> = new Set(
	VEYYON_PACKAGE_NAMES.filter(name => !name.startsWith("pi-") && VEYYON_PACKAGE_NAMES.includes(`pi-${name}` as never)),
);

const CANONICAL_PI_ALIAS_REGEX = new RegExp(`^(${CANONICAL_PI_SCOPE.replace("/", "\\/")}\\/)pi-([^/]+)(\\/.*)?$`);

function canonicalizePiPackageSpecifier(specifier: string): string {
	const match = CANONICAL_PI_ALIAS_REGEX.exec(specifier);
	if (!match) {
		return specifier;
	}
	const [, scopePrefix, basename, subpath] = match;
	if (!CANONICAL_PI_BASENAMES.has(basename)) {
		return specifier;
	}
	return `${scopePrefix}${basename}${subpath ?? ""}`;
}

function resolveCanonicalPiSpecifier(remappedSpecifier: string): string {
	const override = legacyPiPackageRootOverrides[remappedSpecifier];
	if (override) {
		return override;
	}
	return getResolvedSpecifier(canonicalizePiPackageSpecifier(remappedSpecifier));
}

function toImportSpecifier(resolvedPath: string): string {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	return url.pathToFileURL(stripWindowsExtendedLengthPathPrefix(resolvedPath)).href;
}

function rewriteLegacyPiImports(source: string): string {
	return source.replace(
		LEGACY_PI_IMPORT_SPECIFIER_REGEX,
		(match, prefix: string, specifier: string, suffix: string) => {
			const remappedSpecifier = remapLegacyPiSpecifier(specifier);
			if (!remappedSpecifier) {
				return match;
			}

			try {
				return `${prefix}${toImportSpecifier(resolveCanonicalPiSpecifier(remappedSpecifier))}${suffix}`;
			} catch {
				return match;
			}
		},
	);
}

const TYPEBOX_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])(@sinclair\/typebox|typebox)(["'])/g;

async function rewriteLegacyExtensionSource(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
	await ensureLegacyPiOverridesReady();
	const withPi = rewriteLegacyPiImports(source);
	const withTypeBox = TYPEBOX_SHIM_PATH
		? withPi.replace(
				TYPEBOX_IMPORT_SPECIFIER_REGEX,
				(_match, prefix: string, _specifier: string, suffix: string) =>
					`${prefix}${toImportSpecifier(TYPEBOX_SHIM_PATH)}${suffix}`,
			)
		: withPi;
	const withPkg = await rewriteExtensionPackageImports(withTypeBox, importerPath, mtimeTag);
	const withBare = await rewriteExtensionBareImports(withPkg, importerPath, mtimeTag);
	const withNativeAddons = await rewriteExtensionNativeAddonRequires(withBare, importerPath);
	if (!mtimeTag) {
		return withNativeAddons;
	}
	return withNativeAddons.replace(
		RELATIVE_GRAPH_IMPORT_SPECIFIER_REGEX,
		(_match, prefix: string, specifier: string, suffix: string) => `${prefix}${specifier}?mtime=${mtimeTag}${suffix}`,
	);
}

export async function __rewriteLegacyExtensionSourceForTests(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
	return rewriteLegacyExtensionSource(source, importerPath, mtimeTag);
}

const RELATIVE_GRAPH_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])(\.\.?\/[^"'?\s]*)(["'])/g;

function toGraphImportSpecifier(resolvedPath: string, mtimeTag: string | null): string {
	if (isBundledVirtualSpecifier(resolvedPath)) {
		return resolvedPath;
	}
	if (process.platform === "win32" || !mtimeTag) {
		return url.pathToFileURL(stripWindowsExtendedLengthPathPrefix(resolvedPath)).href;
	}
	return `${stripWindowsExtendedLengthPathPrefix(resolvedPath)}?mtime=${mtimeTag}`;
}

const PROBE_IS_A_WALK = "a package-root walk climbs to the filesystem root, so most probes are misses by design";

function hasSourceModuleExtension(p: string): boolean {
	const ext = path.extname(p).toLowerCase();
	return (SOURCE_MODULE_EXTENSIONS as readonly string[]).includes(ext);
}

async function resolveSourceModuleFile(basePath: string): Promise<string | null> {
	try {
		const stats = await fs.promises.stat(basePath);
		if (stats.isFile()) {
			return hasSourceModuleExtension(basePath) ? realpathOrSelf(basePath) : null;
		}
		if (stats.isDirectory()) {
			for (const extension of SOURCE_MODULE_EXTENSIONS) {
				const resolved = await resolveSourceModuleFile(path.join(basePath, `index${extension}`));
				if (resolved) return resolved;
			}
		}
	} catch {}

	if (path.extname(basePath)) {
		return null;
	}

	for (const extension of SOURCE_MODULE_EXTENSIONS) {
		const resolved = await resolveSourceModuleFile(`${basePath}${extension}`);
		if (resolved) return resolved;
	}
	return null;
}

async function findPackageRoot(importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const cached = packageRootCache.get(dir);
		if (cached !== undefined) {
			return cached;
		}

		if (await pathExistsQuietly(path.join(dir, "package.json"), PROBE_IS_A_WALK)) {
			packageRootCache.set(path.dirname(importerPath), dir);
			return dir;
		}

		const parent = path.dirname(dir);
		if (parent === dir) {
			packageRootCache.set(path.dirname(importerPath), null);
			return null;
		}
		dir = parent;
	}
}

async function readPackageImports(packageRoot: string): Promise<Record<string, unknown> | null> {
	const cached = packageImportsCache.get(packageRoot);
	if (cached !== undefined) {
		return cached;
	}

	let imports: Record<string, unknown> | null = null;
	try {
		const pkg = await Bun.file(path.join(packageRoot, "package.json")).json();
		if (isRecord(pkg) && isRecord(pkg.imports)) {
			imports = pkg.imports;
		}
	} catch {
		imports = null;
	}
	packageImportsCache.set(packageRoot, imports);
	return imports;
}

type PackageImportTargetSelection = string | typeof PACKAGE_IMPORT_EXCLUDED | null;
type ResolvedPackageImportTargetSelection = string | typeof PACKAGE_IMPORT_EXCLUDED;

function selectPackageImportTarget(entry: unknown): PackageImportTargetSelection {
	if (entry === null) {
		return PACKAGE_IMPORT_EXCLUDED;
	}
	if (typeof entry === "string") {
		return entry;
	}
	if (Array.isArray(entry)) {
		for (const item of entry) {
			const target = selectPackageImportTarget(item);
			if (target !== null) return target;
		}
		return null;
	}
	if (!isRecord(entry)) {
		return null;
	}
	for (const [condition, value] of Object.entries(entry)) {
		if (!SUPPORTED_PACKAGE_IMPORT_CONDITIONS.has(condition)) {
			continue;
		}
		const target = selectPackageImportTarget(value);
		if (target !== null) return target;
	}
	return null;
}

async function resolvePackageImportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolveSourceModuleFile(path.resolve(packageRoot, substituted));
}

async function resolvePackageImportSpecifier(specifier: string, importerPath: string): Promise<string | null> {
	if (!specifier.startsWith("#")) {
		return null;
	}

	const packageRoot = await findPackageRoot(importerPath);
	if (!packageRoot) {
		return null;
	}

	const imports = await readPackageImports(packageRoot);
	if (!imports) {
		return null;
	}

	const exactTarget = selectPackageImportTarget(imports[specifier]);
	if (exactTarget === PACKAGE_IMPORT_EXCLUDED) {
		return null;
	}
	if (exactTarget !== null) {
		return resolvePackageImportTarget(packageRoot, exactTarget, null);
	}

	let bestMatch: { keyLength: number; target: ResolvedPackageImportTargetSelection; wildcard: string } | null = null;
	for (const [key, entry] of Object.entries(imports)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1) continue;

		const prefix = key.slice(0, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
			continue;
		}

		const target = selectPackageImportTarget(entry);
		if (target === null) {
			continue;
		}

		if (!bestMatch || key.length > bestMatch.keyLength) {
			bestMatch = {
				keyLength: key.length,
				target,
				wildcard: specifier.slice(prefix.length, specifier.length - suffix.length),
			};
		}
	}

	if (!bestMatch || bestMatch.target === PACKAGE_IMPORT_EXCLUDED) {
		return null;
	}
	return resolvePackageImportTarget(packageRoot, bestMatch.target, bestMatch.wildcard);
}

const PACKAGE_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])(#[^"'()\s]+)(["'])/g;

async function rewriteExtensionPackageImports(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
	let rewritten = "";
	let lastIndex = 0;
	for (const match of source.matchAll(PACKAGE_IMPORT_SPECIFIER_REGEX)) {
		const matchIndex = match.index;
		if (matchIndex === undefined) continue;

		const [fullMatch, prefix, specifier, suffix] = match;
		if (!prefix || !specifier || !suffix) continue;

		const resolved = await resolvePackageImportSpecifier(specifier, importerPath);
		if (!resolved) continue;

		rewritten += source.slice(lastIndex, matchIndex);
		rewritten += `${prefix}${toGraphImportSpecifier(resolved, mtimeTag)}${suffix}`;
		lastIndex = matchIndex + fullMatch.length;
	}

	if (lastIndex === 0) {
		return source;
	}
	return `${rewritten}${source.slice(lastIndex)}`;
}

const BARE_EXTENSION_IMPORT_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])([^"'()\s]+)(["'])/g;

function isBareExtensionDependencySpecifier(specifier: string): boolean {
	if (
		specifier.startsWith(".") ||
		specifier.startsWith("/") ||
		specifier.startsWith("#") ||
		specifier.startsWith("node:") ||
		specifier.startsWith("bun:") ||
		hasUriScheme(specifier)
	) {
		return false;
	}
	const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
	return Boolean(packageName && !isBuiltin(packageName));
}

interface BarePackageSpecifier {
	readonly name: string;
	readonly subpath: string | null;
}

function splitBarePackageSpecifier(specifier: string): BarePackageSpecifier | null {
	const parts = specifier.split("/");
	if (specifier.startsWith("@")) {
		const [scope, name, ...rest] = parts;
		if (!scope || !name) return null;
		return { name: `${scope}/${name}`, subpath: rest.length > 0 ? rest.join("/") : null };
	}
	const [name, ...rest] = parts;
	if (!name) return null;
	return { name, subpath: rest.length > 0 ? rest.join("/") : null };
}

async function findNodePackageRoot(packageName: string, importerPath: string): Promise<string | null> {
	const cacheKey = `${packageName}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = nodePackageRootCache.get(cacheKey);
	if (cached) return cached;

	const promise = findNodePackageRootUncached(packageName, importerPath);
	nodePackageRootCache.set(cacheKey, promise);
	return promise;
}

async function findNodePackageRootUncached(packageName: string, importerPath: string): Promise<string | null> {
	let dir = path.dirname(importerPath);
	while (true) {
		const candidate = path.join(dir, "node_modules", packageName);
		if (await pathExistsQuietly(path.join(candidate, "package.json"), PROBE_IS_A_WALK)) {
			return candidate;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

async function readPackageManifest(packageRoot: string): Promise<Record<string, unknown> | null> {
	const cached = packageManifestCache.get(packageRoot);
	if (cached) return cached;

	const promise = readPackageManifestUncached(packageRoot);
	packageManifestCache.set(packageRoot, promise);
	return promise;
}

async function readPackageManifestUncached(packageRoot: string): Promise<Record<string, unknown> | null> {
	const manifestPath = path.join(packageRoot, "package.json");
	try {
		const manifest = await Bun.file(manifestPath).json();
		if (isRecord(manifest)) return manifest;
		logger.warn("A plugin package.json is not an object; its dependencies cannot be resolved", {
			path: manifestPath,
		});
		return null;
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("A plugin package.json could not be parsed; its dependencies cannot be resolved", {
				path: manifestPath,
				error: errorMessage(err),
			});
		}
		return null;
	}
}

async function resolvePackageExportTarget(
	packageRoot: string,
	target: string,
	wildcard: string | null,
): Promise<string | null> {
	if (!target.startsWith("./")) {
		return null;
	}
	const substituted = wildcard === null ? target : target.replaceAll("*", wildcard);
	return resolveSourceModuleFile(path.resolve(packageRoot, substituted));
}

async function resolveNodePackageExport(
	packageRoot: string,
	subpath: string | null,
	manifest: Record<string, unknown>,
): Promise<string | null> {
	const exportsField = manifest.exports;
	const rootTarget = subpath === null ? selectPackageImportTarget(exportsField) : null;
	if (rootTarget !== null && rootTarget !== PACKAGE_IMPORT_EXCLUDED) {
		return resolvePackageExportTarget(packageRoot, rootTarget, null);
	}
	if (!isRecord(exportsField)) {
		return null;
	}

	const exactKey = subpath === null ? "." : `./${subpath}`;
	const exactTarget = selectPackageImportTarget(exportsField[exactKey]);
	if (exactTarget !== null && exactTarget !== PACKAGE_IMPORT_EXCLUDED) {
		return resolvePackageExportTarget(packageRoot, exactTarget, null);
	}

	for (const [key, entry] of Object.entries(exportsField)) {
		const starIndex = key.indexOf("*");
		if (starIndex === -1 || subpath === null) continue;
		const prefix = key.slice(2, starIndex);
		const suffix = key.slice(starIndex + 1);
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
			continue;
		}
		const target = selectPackageImportTarget(entry);
		if (target === null || target === PACKAGE_IMPORT_EXCLUDED) {
			continue;
		}
		return resolvePackageExportTarget(
			packageRoot,
			target,
			subpath.slice(prefix.length, subpath.length - suffix.length),
		);
	}
	return null;
}

async function resolveNodePackageFallback(
	packageRoot: string,
	subpath: string | null,
	manifest: Record<string, unknown>,
): Promise<string | null> {
	if (subpath !== null) {
		return resolveSourceModuleFile(path.join(packageRoot, subpath));
	}
	for (const field of ["module", "main"]) {
		const target = manifest[field];
		if (typeof target === "string") {
			const resolved = await resolveSourceModuleFile(path.resolve(packageRoot, target));
			if (resolved) return resolved;
		}
	}
	return resolveSourceModuleFile(path.join(packageRoot, "index"));
}

async function resolveNodePackageDependency(specifier: string, importerPath: string): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	if (!parsed) return null;
	const packageRoot = await findNodePackageRoot(parsed.name, importerPath);
	if (!packageRoot) return null;
	const manifest = await readPackageManifest(packageRoot);
	if (!manifest) return null;
	return (
		(await resolveNodePackageExport(packageRoot, parsed.subpath, manifest)) ??
		(await resolveNodePackageFallback(packageRoot, parsed.subpath, manifest))
	);
}

async function resolveExtensionBareDependency(specifier: string, importerPath: string): Promise<string | null> {
	if (!isBareExtensionDependencySpecifier(specifier)) {
		return null;
	}

	const cacheKey = `${specifier}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = bareDependencyResolutionCache.get(cacheKey);
	if (cached) return cached;

	const promise = resolveExtensionBareDependencyUncached(specifier, importerPath);
	bareDependencyResolutionCache.set(cacheKey, promise);
	return promise;
}

async function resolveExtensionBareDependencyUncached(specifier: string, importerPath: string): Promise<string | null> {
	try {
		const resolved = Bun.resolveSync(specifier, path.dirname(importerPath));
		if (resolved && resolved !== specifier && !resolved.startsWith("node:") && !resolved.startsWith("bun:")) {
			return resolved;
		}
	} catch {}
	return resolveNodePackageDependency(specifier, importerPath);
}

const NATIVE_ADDON_EXTENSION = ".node";

const NATIVE_ADDON_REQUIRE_SPECIFIER_REGEX = /(\brequire\s*\(\s*["'])([^"'()\s]+)(["']\s*\))/g;

async function resolveExtensionNativeAddon(specifier: string, importerPath: string): Promise<string | null> {
	if (!isBareExtensionDependencySpecifier(specifier)) {
		return null;
	}

	const cacheKey = `${specifier}\0${path.resolve(path.dirname(importerPath))}`;
	const cached = nativeAddonResolutionCache.get(cacheKey);
	if (cached) return cached;

	const promise = resolveExtensionNativeAddonUncached(specifier, importerPath);
	nativeAddonResolutionCache.set(cacheKey, promise);
	return promise;
}

async function resolveExtensionNativeAddonUncached(specifier: string, importerPath: string): Promise<string | null> {
	const parsed = splitBarePackageSpecifier(specifier);
	if (!parsed) return null;
	const packageRoot = await findNodePackageRoot(parsed.name, importerPath);
	if (!packageRoot) return null;

	let target: string | null = null;
	if (parsed.subpath !== null) {
		target = parsed.subpath.endsWith(NATIVE_ADDON_EXTENSION) ? path.join(packageRoot, parsed.subpath) : null;
	} else {
		const manifest = await readPackageManifest(packageRoot);
		const main = manifest?.main;
		target =
			typeof main === "string" && main.endsWith(NATIVE_ADDON_EXTENSION) ? path.resolve(packageRoot, main) : null;
	}
	if (!target || !(await pathExistsQuietly(target, PROBE_IS_A_WALK))) {
		return null;
	}
	return realpathOrSelf(target);
}

async function rewriteExtensionNativeAddonRequires(source: string, importerPath: string): Promise<string> {
	let rewritten = "";
	let lastIndex = 0;
	for (const match of source.matchAll(NATIVE_ADDON_REQUIRE_SPECIFIER_REGEX)) {
		const matchIndex = match.index;
		if (matchIndex === undefined) continue;

		const [fullMatch, prefix, specifier, suffix] = match;
		if (!prefix || !specifier || !suffix) continue;

		const resolved = await resolveExtensionNativeAddon(specifier, importerPath);
		if (!resolved) continue;

		rewritten += source.slice(lastIndex, matchIndex);
		rewritten += `${prefix}${stripWindowsExtendedLengthPathPrefix(resolved).replaceAll("\\", "/")}${suffix}`;
		lastIndex = matchIndex + fullMatch.length;
	}

	if (lastIndex === 0) {
		return source;
	}
	return `${rewritten}${source.slice(lastIndex)}`;
}

async function moduleRequiresNativeAddon(modulePath: string): Promise<boolean> {
	const cached = nativeAddonRequireScanCache.get(modulePath);
	if (cached) return cached;

	const promise = moduleRequiresNativeAddonUncached(modulePath);
	nativeAddonRequireScanCache.set(modulePath, promise);
	return promise;
}

async function moduleRequiresNativeAddonUncached(modulePath: string): Promise<boolean> {
	let source: string;
	try {
		source = await Bun.file(modulePath).text();
	} catch {
		return false;
	}
	for (const match of source.matchAll(NATIVE_ADDON_REQUIRE_SPECIFIER_REGEX)) {
		const specifier = match[2];
		if (specifier && (await resolveExtensionNativeAddon(specifier, modulePath))) {
			return true;
		}
	}
	return false;
}

async function rewriteExtensionBareImports(
	source: string,
	importerPath: string,
	mtimeTag: string | null = null,
): Promise<string> {
	let rewritten = "";
	let lastIndex = 0;
	for (const match of source.matchAll(BARE_EXTENSION_IMPORT_SPECIFIER_REGEX)) {
		const matchIndex = match.index;
		if (matchIndex === undefined) continue;

		const [fullMatch, prefix, specifier, suffix] = match;
		if (!prefix || !specifier || !suffix) continue;

		const resolved = await resolveExtensionBareDependency(specifier, importerPath);
		if (!resolved) continue;

		rewritten += source.slice(lastIndex, matchIndex);
		rewritten += `${prefix}${toGraphImportSpecifier(resolved, mtimeTag)}${suffix}`;
		lastIndex = matchIndex + fullMatch.length;
	}

	if (lastIndex === 0) {
		return source;
	}
	return `${rewritten}${source.slice(lastIndex)}`;
}

const EXTENSION_GRAPH_SPECIFIER_REGEX = /((?:from\s+|import\s+|import\s*\(\s*)["'])([^"'()\s]+)(["'])/g;

const extensionGraphHookModules = new Map<string, Set<string>>();

let legacyPiLoadTag = 0;

function nextLegacyPiLoadTag(): string {
	legacyPiLoadTag = Math.max(legacyPiLoadTag + 1, Date.now());
	return String(legacyPiLoadTag);
}

async function realpathOrSelf(p: string): Promise<string> {
	const cached = realpathCache.get(p);
	if (cached) return cached;

	const promise = realpathOrSelfUncached(p);
	realpathCache.set(p, promise);
	return promise;
}

async function realpathOrSelfUncached(p: string): Promise<string> {
	try {
		return await fs.promises.realpath(p);
	} catch {
		return p;
	}
}

async function collectExtensionModules(entryRealPath: string): Promise<Map<string, string>> {
	const modules = new Map<string, string>();
	const queuedFollowBareDependencies = new Map<string, boolean>([[entryRealPath, true]]);
	const queue: Array<{ file: string; followBareDependencies: boolean }> = [
		{ file: entryRealPath, followBareDependencies: true },
	];
	while (queue.length > 0) {
		const item = queue.pop();
		if (!item) {
			continue;
		}
		const file = item.file;
		const followBareDependencies = queuedFollowBareDependencies.get(file) ?? item.followBareDependencies;
		if (modules.has(file)) {
			continue;
		}
		let source: string;
		try {
			source = await Bun.file(file).text();
		} catch {
			continue;
		}
		modules.set(file, source);
		const dir = path.dirname(file);
		const specifiers = new Set<string>();
		const requiredSpecifiers = new Set<string>();
		for (const match of source.matchAll(EXTENSION_GRAPH_SPECIFIER_REGEX)) {
			if (match[2]) specifiers.add(match[2]);
		}
		for (const match of source.matchAll(NATIVE_ADDON_REQUIRE_SPECIFIER_REGEX)) {
			if (match[2]) {
				specifiers.add(match[2]);
				requiredSpecifiers.add(match[2]);
			}
		}
		for (const specifier of specifiers) {
			try {
				let resolved: string | null = null;
				let nextFollowsBareDependencies = followBareDependencies;
				const isRequired = requiredSpecifiers.has(specifier);
				if (specifier.startsWith(".")) {
					const candidate = Bun.resolveSync(specifier, dir);
					if (
						hasSourceModuleExtension(candidate) &&
						(!isRequired || (await moduleRequiresNativeAddon(candidate)))
					) {
						resolved = await realpathOrSelf(candidate);
					}
				} else if (specifier.startsWith("#")) {
					const candidate = await resolvePackageImportSpecifier(specifier, file);
					if (candidate && (!isRequired || (await moduleRequiresNativeAddon(candidate)))) {
						resolved = candidate;
					}
				} else if (
					followBareDependencies &&
					isBareExtensionDependencySpecifier(specifier) &&
					!remapLegacyPiSpecifier(specifier) &&
					specifier !== "typebox" &&
					specifier !== "@sinclair/typebox"
				) {
					const parsed = splitBarePackageSpecifier(specifier);
					const packageRoot = parsed ? await findNodePackageRoot(parsed.name, file) : null;
					const manifest = packageRoot ? await readPackageManifest(packageRoot) : null;
					const dependencyEntry = manifest ? await resolveExtensionBareDependency(specifier, file) : null;
					const dependencyExtension = dependencyEntry ? path.extname(dependencyEntry) : null;
					const isCommonJsEntry =
						dependencyExtension === ".cjs" ||
						dependencyExtension === ".cts" ||
						((dependencyExtension === ".js" || dependencyExtension === ".jsx") && manifest?.type !== "module");
					const isHookableEntry = Boolean(dependencyEntry && hasSourceModuleExtension(dependencyEntry));
					const hookCommonJsEntry =
						isHookableEntry && isCommonJsEntry && dependencyEntry
							? await moduleRequiresNativeAddon(dependencyEntry)
							: false;
					if (isHookableEntry && dependencyEntry && ((!isRequired && !isCommonJsEntry) || hookCommonJsEntry)) {
						resolved = await realpathOrSelf(dependencyEntry);
					}
					if (resolved && hookCommonJsEntry) {
						nativeAddonLoaderModulePaths.add(resolved);
					}
					nextFollowsBareDependencies = false;
				}
				if (resolved && isRequired) {
					nativeAddonLoaderModulePaths.add(resolved);
				}
				if (resolved && !modules.has(resolved)) {
					const queuedFollowsBareDependencies = queuedFollowBareDependencies.get(resolved) ?? false;
					const mergedFollowsBareDependencies = queuedFollowsBareDependencies || nextFollowsBareDependencies;
					queuedFollowBareDependencies.set(resolved, mergedFollowsBareDependencies);
					queue.push({ file: resolved, followBareDependencies: mergedFollowsBareDependencies });
				}
			} catch {}
		}
	}
	for (const modulePath of nativeAddonLoaderModulePaths) {
		const source = modules.get(modulePath);
		if (source !== undefined) {
			modules.set(modulePath, await rewriteExtensionNativeAddonRequires(source, modulePath));
		}
	}
	return modules;
}

function installExtensionGraphHook(
	entryRealPath: string,
	modules: Map<string, string>,
): { asyncModules: Map<string, string>; syncCommonJsModules: Map<string, string> } {
	const asyncModules = new Map<string, string>();
	const syncCommonJsModules = new Map<string, string>();
	for (const [modulePath, source] of modules) {
		const destination = nativeAddonLoaderModulePaths.has(modulePath) ? syncCommonJsModules : asyncModules;
		destination.set(modulePath, source);
	}

	if (asyncModules.size > 0) {
		const alternation = Array.from(asyncModules.keys()).map(escapeRegExp).join("|");
		const filter = new RegExp(`^(?:${alternation})(?:\\?mtime=\\d+)?$`);
		const hookId = Bun.hash(`${entryRealPath}\0async\0${Array.from(asyncModules.keys()).join("\0")}`).toString(36);
		Bun.plugin({
			name: `veyyon:legacy-pi-ext:${hookId}`,
			setup(build) {
				build.onLoad({ filter, namespace: "file" }, async args => {
					const queryIndex = args.path.indexOf("?mtime=");
					const sourcePath = queryIndex >= 0 ? args.path.slice(0, queryIndex) : args.path;
					const mtimeTag = queryIndex >= 0 ? args.path.slice(queryIndex + "?mtime=".length) : null;
					const cached = asyncModules.get(sourcePath);
					let raw: string;
					if (cached !== undefined) {
						asyncModules.delete(sourcePath);
						raw = cached;
					} else {
						raw = await Bun.file(sourcePath).text();
					}
					return {
						contents: await rewriteLegacyExtensionSource(raw, sourcePath, mtimeTag),
						loader: getLoader(sourcePath),
					};
				});
			},
		});
	}

	if (syncCommonJsModules.size > 0) {
		const alternation = Array.from(syncCommonJsModules.keys()).map(escapeRegExp).join("|");
		const filter = new RegExp(`^(?:${alternation})(?:\\?mtime=\\d+)?$`);
		const hookId = Bun.hash(
			`${entryRealPath}\0sync-cjs\0${Array.from(syncCommonJsModules.keys()).join("\0")}`,
		).toString(36);
		Bun.plugin({
			name: `veyyon:legacy-pi-ext:${hookId}`,
			setup(build) {
				build.onLoad({ filter, namespace: "file" }, args => {
					const queryIndex = args.path.indexOf("?mtime=");
					const sourcePath = queryIndex >= 0 ? args.path.slice(0, queryIndex) : args.path;
					const source = syncCommonJsModules.get(sourcePath);
					if (source === undefined) {
						throw new Error(`Missing pre-rewritten CommonJS extension source: ${sourcePath}`);
					}
					return { contents: source, loader: getLoader(sourcePath) };
				});
			},
		});
	}
	return { asyncModules, syncCommonJsModules };
}

async function ensureExtensionGraphHook(entryRealPath: string): Promise<{ clear(): void } | undefined> {
	const currentModules = await collectExtensionModules(entryRealPath);
	let hookedModules = extensionGraphHookModules.get(entryRealPath);
	if (!hookedModules) {
		hookedModules = new Set<string>();
		extensionGraphHookModules.set(entryRealPath, hookedModules);
	}

	const pendingModules = new Map<string, string>();
	for (const [modulePath, source] of currentModules) {
		if (!hookedModules.has(modulePath)) {
			pendingModules.set(modulePath, source);
		}
	}
	if (pendingModules.size === 0) {
		return undefined;
	}

	const { asyncModules, syncCommonJsModules } = installExtensionGraphHook(entryRealPath, pendingModules);
	for (const modulePath of pendingModules.keys()) {
		hookedModules.add(modulePath);
	}
	return {
		clear() {
			asyncModules.clear();
			syncCommonJsModules.clear();
		},
	};
}

export async function loadLegacyPiModule(resolvedPath: string): Promise<unknown> {
	const entryRealPath = await realpathOrSelf(path.resolve(resolvedPath));
	await ensureLegacyPiOverridesReady();
	const pendingSources = await ensureExtensionGraphHook(entryRealPath);
	try {
		const entrySpecifier =
			process.platform === "win32" || isBundledVirtualSpecifier(entryRealPath)
				? toImportSpecifier(entryRealPath)
				: entryRealPath;
		return await import(`${entrySpecifier}?mtime=${nextLegacyPiLoadTag()}`);
	} finally {
		pendingSources?.clear();
	}
}

function getLoader(path: string): "js" | "jsx" | "ts" | "tsx" {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	return "js";
}

function resolveLegacyPiSpecifier(args: { path: string; importer: string }): { path: string } | undefined {
	const remappedSpecifier = remapLegacyPiSpecifier(args.path);
	if (!remappedSpecifier) {
		return undefined;
	}

	try {
		return { path: resolveCanonicalPiSpecifier(remappedSpecifier) };
	} catch {
		const importerDir = path.dirname(args.importer);
		try {
			return { path: Bun.resolveSync(remappedSpecifier, importerDir) };
		} catch {
			try {
				return { path: Bun.resolveSync(args.path, importerDir) };
			} catch {
				return undefined;
			}
		}
	}
}

function resolveTypeBoxSpecifier(): { path: string } | undefined {
	return TYPEBOX_SHIM_PATH ? { path: TYPEBOX_SHIM_PATH } : undefined;
}

export function installLegacyPiSpecifierShim(): void {
	if (isLegacyPiSpecifierShimInstalled) {
		return;
	}
	isLegacyPiSpecifierShimInstalled = true;

	Bun.plugin({
		name: "veyyon:legacy-pi-shim",
		setup(build) {
			build.onResolve({ filter: LEGACY_PI_SPECIFIER_FILTER, namespace: "file" }, resolveLegacyPiSpecifier);
			build.onResolve({ filter: TYPEBOX_SPECIFIER_FILTER, namespace: "file" }, resolveTypeBoxSpecifier);
			build.onLoad({ filter: /.*/, namespace: BUNDLED_VIRTUAL_NAMESPACE }, async args => {
				return { contents: await synthesizeBundledModuleSource(args.path), loader: "js" };
			});
		},
	});
}

export function __resetLegacyPiResolutionCache(): void {
	clearLegacyPiResolutionCaches();
}
