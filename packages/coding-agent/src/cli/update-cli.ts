/**
 * Update CLI command handler.
 *
 * Handles `veyyon update` to check for and install updates.
 * Uses the installer that owns the active veyyon executable when it can be detected.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import {
	$which,
	APP_NAME,
	compareSemver,
	errorMessage,
	getAutoUpdateStatePath,
	getUpdateHistoryPath,
	isEnoent,
	isNewerVersion,
	isValidSemver,
	logger,
	tryWithFileLock,
	VERSION,
} from "@veyyon/utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import {
	AUTO_UPDATE_FAILURE_COOLDOWN_MS,
	AUTO_UPDATE_LOCK_STALE_MS,
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
	shouldAttemptAutoUpdate,
} from "./auto-update-state";

const REPO = "santhreal/veyyon";
const PACKAGE = "@veyyon/coding-agent";
const HOMEBREW_FORMULA = "santhreal/tap/veyyon";
const MISE_TOOL = "github:santhreal/veyyon";
/**
 * Official npm registry origin.
 *
 * Pinned across both the version check and the bun install step so the two
 * agree on which catalog they are talking to. A user's bun may be pointed at
 * an unofficial mirror (corporate proxy, Taobao, etc.) that lags the upstream
 * registry by minutes-to-hours, in which case `getLatestRelease` would resolve
 * a version the mirror has not yet replicated and the install would fail with
 * `No version matching "X" found for specifier "<pkg>" (but package exists)`.
 * See #1686.
 */
const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * Resolve the npm registry origin, honoring a `VEYYON_NPM_REGISTRY` override.
 *
 * The override is a real operational knob: a corporate mirror, an air-gapped
 * proxy, or a local fixture (the rollback picker's version list is read from
 * here, so a test or a demo can serve a deterministic packument). When unset,
 * the official registry is used. The same resolved origin pins BOTH the version
 * lookups AND the `--registry=` on the install step, so the catalog the picker
 * lists and the catalog the install pulls from can never disagree (#1686). A
 * trailing slash is normalized so callers can append `${PACKAGE}` directly.
 */
export function resolveNpmRegistry(): string {
	const override = process.env.VEYYON_NPM_REGISTRY?.trim();
	const base = override && override.length > 0 ? override : NPM_REGISTRY;
	return base.endsWith("/") ? base : `${base}/`;
}
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildBunInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@veyyon/natives";

/**
 * Platform tags the release pipeline publishes as
 * `@veyyon/natives-<tag>` leaves. Mirrors `SUPPORTED_PLATFORMS` in
 * `packages/natives/native/loader-state.js` and `LEAF_TARGETS` in
 * `packages/natives/scripts/gen-npm-packages.ts`; kept here as the local
 * source of truth so the update path stays free of cross-package imports.
 */
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

export interface ReleaseInfo {
	tag: string;
	version: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getNpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("npm")) return undefined;
	try {
		const result = await $`npm prefix -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const prefix = result.text().trim();
		if (prefix.length === 0) return undefined;
		return process.platform === "win32" ? prefix : path.join(prefix, "bin");
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	for (const formula of [HOMEBREW_FORMULA, APP_NAME]) {
		try {
			const result = await $`brew --prefix ${formula}`.quiet().nothrow();
			if (result.exitCode !== 0) continue;
			const output = result.text().trim();
			if (output.length > 0) return output;
		} catch {}
	}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved veyyon path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like Homebrew's `bin/veyyon -> Cellar/.../bin/veyyon`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

type UpdateMethod = "brew" | "mise" | "bun" | "npm" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;
}

type UpdateTarget =
	| { method: "brew" }
	| { method: "mise" }
	| { method: "bun" }
	| { method: "npm" }
	| { method: "binary"; path: string };

function resolveUpdateMethod(
	veyyonPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const { homebrewPrefix, miseBinDirs = [], miseDataDir, npmBinDir } = options;
	const launcherExtension = path.extname(veyyonPath).toLowerCase();
	const isWindowsScriptLauncher =
		launcherExtension === ".cmd" || launcherExtension === ".ps1" || launcherExtension === ".bat";
	if (homebrewPrefix && isPathInDirectory(veyyonPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(veyyonPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(veyyonPath, path.join(miseDataDir, "shims"))) return "mise";
	if (bunBinDir && isPathInDirectory(veyyonPath, bunBinDir)) return "bun";
	if ((npmBinDir && isPathInDirectory(veyyonPath, npmBinDir)) || isWindowsScriptLauncher) return "npm";
	return "binary";
}

export function resolveUpdateMethodForTest(
	veyyonPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(veyyonPath, bunBinDir, options);
}
async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const npmBinDir = await getNpmGlobalBinDir();
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const veyyonPath = resolveVeyyonPath();

	if (veyyonPath) {
		const method = resolveUpdateMethod(veyyonPath, bunBinDir, {
			homebrewPrefix,
			miseBinDirs,
			miseDataDir,
			npmBinDir,
		});
		if (method === "binary") return { method, path: veyyonPath };
		return { method };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/**
 * Get the latest release info from the npm registry.
 * Uses npm instead of GitHub API to avoid unauthenticated rate limiting.
 */
/**
 * Look up the latest published release.
 *
 * The one place the registry is asked what the newest version is. Startup and
 * `veyyon update` both come through here, so they can never disagree about
 * which registry to ask or how to read the answer.
 *
 * `timeoutMs` exists because the two callers want different patience: a
 * startup check runs while you are waiting to type and gives up quickly, while
 * an explicit `veyyon update` is worth waiting on.
 */
export async function getLatestRelease(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	const registry = resolveNpmRegistry();
	let response: Response;
	try {
		response = await fetch(`${registry}${PACKAGE}/latest`, {
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching release info after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		const hint =
			response.status === 404
				? ` — ${PACKAGE} has no published release on the npm registry yet`
				: response.status === 429
					? " — the npm registry is rate-limiting this address; retry in a few minutes"
					: "";
		throw new Error(
			`Failed to fetch release info from ${registry}${PACKAGE}/latest: HTTP ${response.status} ${response.statusText}${hint}`,
		);
	}

	const data = (await response.json()) as { version: string };
	const version = data.version;
	const tag = `v${version}`;

	return {
		tag,
		version,
	};
}

/** One published release: its version, tag, and (when the registry reports it) publish time. */
export interface ReleaseListing {
	version: string;
	tag: string;
	/** ISO-8601 publish timestamp from the registry `time` map, or undefined if absent. */
	publishedAt?: string;
}

/**
 * List every published release, newest first.
 *
 * The rollback picker needs the whole catalog, not just `latest`, so this
 * fetches the full npm packument (`${NPM_REGISTRY}${PACKAGE}`) and reads its
 * `versions` map (the authoritative set of installable versions) and `time` map
 * (publish timestamps). The `created`/`modified` pseudo-keys in `time` are not
 * versions and are dropped; anything that is not valid semver is dropped too, so
 * a malformed key can never masquerade as an installable version. Sorting is by
 * semver via {@link isNewerVersion}, so `1.10.0` correctly sorts above `1.9.0`.
 *
 * Like {@link getLatestRelease} this hits the registry directly (never the
 * GitHub API) to avoid unauthenticated rate limiting, and it fails LOUDLY: a
 * non-200 or a network error throws with a hint. It never returns an empty list
 * on failure, because an empty picker would look like "no versions exist"
 * rather than "the lookup failed" (Law 10).
 */
export async function getAllReleases(timeoutMs: number = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseListing[]> {
	const registry = resolveNpmRegistry();
	let response: Response;
	try {
		response = await fetch(`${registry}${PACKAGE}`, {
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching the release list after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		const hint =
			response.status === 404
				? ` — ${PACKAGE} has no published releases on the npm registry yet`
				: response.status === 429
					? " — the npm registry is rate-limiting this address; retry in a few minutes"
					: "";
		throw new Error(
			`Failed to fetch the release list from ${registry}${PACKAGE}: HTTP ${response.status} ${response.statusText}${hint}`,
		);
	}

	return parseReleaseListings((await response.json()) as PackumentShape);
}

/** The subset of an npm packument the release list reads. */
export interface PackumentShape {
	versions?: Record<string, unknown>;
	time?: Record<string, string>;
}

/**
 * Turn an npm packument into the version list, newest first. Pure (no network)
 * so the parse/sort/filter rules are unit-testable against a fixture:
 *
 *  - only keys of `versions` are considered installable versions;
 *  - the `created`/`modified` pseudo-keys in `time` are never versions, and
 *    anything that is not valid semver is dropped, so a malformed key cannot
 *    masquerade as a version;
 *  - order is semver-descending (`1.10.0` above `1.9.0`), not lexicographic.
 */
export function parseReleaseListings(data: PackumentShape): ReleaseListing[] {
	const times = data.time ?? {};
	const listings: ReleaseListing[] = [];
	for (const version of Object.keys(data.versions ?? {})) {
		if (!isValidSemver(version)) continue;
		listings.push({ version, tag: `v${version}`, publishedAt: times[version] });
	}
	// Newest first. `isNewerVersion(a, b)` is true when a > b, so returning
	// negative when a is newer puts newer versions ahead in ascending sort.
	listings.sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : isNewerVersion(b.version, a.version) ? 1 : 0));
	return listings;
}

interface BunInstallCachePruneResult {
	scannedPackages: number;
	removedEntries: number;
}

interface BunCachePackageGroup {
	/**
	 * The package.json `name` resolved from a materialized dir in this group.
	 * `undefined` until an actual dir is read. Groups are keyed by cache-dir
	 * stem (shared by a package's marker dir `X` and its actual dirs
	 * `X@version`), which can differ from the manifest name when a package was
	 * installed under a former brand (e.g. cache stem `@veyyon/pi-utils` for
	 * manifest name `@veyyon/utils`); the filter matches on this resolved name.
	 */
	packageName?: string;
	actualDirs: Map<string, string[]>;
	markerDir?: string;
	markerEntries: Map<string, string[]>;
}

function stripBunCacheVersionSuffix(name: string): string {
	const metadataIndex = name.indexOf("@@");
	return metadataIndex === -1 ? name : name.slice(0, metadataIndex);
}

async function readdirIfExists(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

function getBunCacheGroup(groups: Map<string, BunCachePackageGroup>, stem: string): BunCachePackageGroup {
	let group = groups.get(stem);
	if (!group) {
		group = { actualDirs: new Map(), markerEntries: new Map() };
		groups.set(stem, group);
	}
	return group;
}

function addVersionPath(entries: Map<string, string[]>, version: string, entryPath: string): void {
	const paths = entries.get(version);
	if (paths) {
		paths.push(entryPath);
		return;
	}
	entries.set(version, [entryPath]);
}

async function addBunCacheActualDir(
	groups: Map<string, BunCachePackageGroup>,
	stem: string,
	dirPath: string,
): Promise<void> {
	try {
		const manifest = (await Bun.file(path.join(dirPath, "package.json")).json()) as Partial<
			Record<"name" | "version", unknown>
		>;
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
		const group = getBunCacheGroup(groups, stem);
		group.packageName = manifest.name;
		addVersionPath(group.actualDirs, manifest.version, dirPath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

async function addBunCacheMarkerDir(
	groups: Map<string, BunCachePackageGroup>,
	stem: string,
	markerDir: string,
): Promise<void> {
	const markerEntries = await readdirIfExists(markerDir);
	const group = getBunCacheGroup(groups, stem);
	group.markerDir = markerDir;
	for (const entry of markerEntries) {
		const cacheVersion = stripBunCacheVersionSuffix(entry.name);
		addVersionPath(group.markerEntries, cacheVersion, path.join(markerDir, entry.name));
	}
}

/**
 * Split a bun cache directory name into its package stem and the `@version…`
 * remainder. A package's marker dir (`react`) and its materialized dirs
 * (`react@19.2.6@@@1`) share the same stem, so grouping by stem keeps them
 * together even when the manifest name has since been rebranded away from the
 * on-disk name. `undefined` remainder marks a marker directory.
 */
function splitBunCacheStem(name: string): { stem: string; hasVersion: boolean } {
	const versionSeparator = name.indexOf("@");
	if (versionSeparator === -1) return { stem: name, hasVersion: false };
	return { stem: name.slice(0, versionSeparator), hasVersion: true };
}

async function collectBunCacheGroups(cacheDir: string): Promise<Map<string, BunCachePackageGroup>> {
	const groups = new Map<string, BunCachePackageGroup>();
	for (const entry of await readdirIfExists(cacheDir)) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(cacheDir, entry.name);
		if (entry.name.startsWith("@")) {
			for (const scopedEntry of await readdirIfExists(entryPath)) {
				if (!scopedEntry.isDirectory()) continue;
				const scopedEntryPath = path.join(entryPath, scopedEntry.name);
				const { stem, hasVersion } = splitBunCacheStem(scopedEntry.name);
				const scopedStem = `${entry.name}/${stem}`;
				if (hasVersion) {
					await addBunCacheActualDir(groups, scopedStem, scopedEntryPath);
				} else {
					await addBunCacheMarkerDir(groups, scopedStem, scopedEntryPath);
				}
			}
			continue;
		}
		const { stem, hasVersion } = splitBunCacheStem(entry.name);
		if (hasVersion) {
			await addBunCacheActualDir(groups, stem, entryPath);
		} else {
			await addBunCacheMarkerDir(groups, stem, entryPath);
		}
	}
	return groups;
}

async function removeCacheEntries(paths: string[]): Promise<number> {
	for (const entryPath of paths) {
		await fs.promises.rm(entryPath, { recursive: true, force: true });
	}
	return paths.length;
}

/**
 * Prune Bun's package cache so each package keeps only its newest cached version.
 *
 * Bun stores package cache entries as both a package marker directory
 * (`react/19.2.6@@@1`) and a materialized package directory
 * (`react@19.2.6@@@1`). Global `veyyon` updates can leave one full copy per
 * release. The marker and materialized entries are removed together so the
 * cache stays internally consistent.
 */
export async function pruneBunInstallCache(
	cacheDir: string,
	packageNames?: Set<string>,
): Promise<BunInstallCachePruneResult> {
	const groups = await collectBunCacheGroups(cacheDir);
	let scannedPackages = 0;
	let removedEntries = 0;
	for (const group of groups.values()) {
		if (group.actualDirs.size === 0) continue;
		// Filter by the manifest name resolved from a materialized dir, not the
		// on-disk stem, so rebranded caches (stem != name) still match.
		if (packageNames && (group.packageName === undefined || !packageNames.has(group.packageName))) continue;
		scannedPackages++;
		// Only entries whose directory name is an orderable version take part.
		// This loop decides what gets DELETED, and the previous comparator
		// returned 0 for anything it could not parse: a stray directory name seen
		// first therefore became "latest" and every genuine cached version was
		// removed instead of it. Unparseable names are now left untouched and
		// reported rather than ranked, because deleting on an ordering that could
		// not be computed is exactly the wrong move.
		const unorderable: string[] = [];
		let latestVersion: string | undefined;
		for (const version of group.actualDirs.keys()) {
			if (!isValidSemver(version)) {
				unorderable.push(version);
				continue;
			}
			if (!latestVersion || isNewerVersion(version, latestVersion)) latestVersion = version;
		}
		if (unorderable.length > 0) {
			logger.warn("Bun cache prune: skipping entries whose version could not be parsed", {
				package: group.packageName,
				entries: unorderable,
			});
		}
		if (!latestVersion) continue;
		const keep = latestVersion;
		const prunable = (version: string): boolean => version !== keep && isValidSemver(version);
		for (const [version, paths] of group.actualDirs) {
			if (prunable(version)) removedEntries += await removeCacheEntries(paths);
		}
		for (const [version, paths] of group.markerEntries) {
			if (prunable(version)) removedEntries += await removeCacheEntries(paths);
		}
	}
	return { scannedPackages, removedEntries };
}

async function resolveBunInstallCacheDir(): Promise<string | undefined> {
	try {
		const result = await $`bun pm cache`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

export function resolveBunGlobalNodeModulesDirFromLocations(
	globalBinDir: string | undefined,
	cacheDir: string | undefined,
): string | undefined {
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	if (cacheDir && cacheDir.length > 0) {
		return path.join(path.dirname(cacheDir), "global", "node_modules");
	}
	return undefined;
}

async function resolveBunGlobalNodeModulesDir(cacheDir: string): Promise<string | undefined> {
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		const globalBinDir = result.exitCode === 0 ? result.text().trim() : undefined;
		return resolveBunGlobalNodeModulesDirFromLocations(globalBinDir, cacheDir);
	} catch {
		return resolveBunGlobalNodeModulesDirFromLocations(undefined, cacheDir);
	}
}

async function collectInstalledPackageNames(nodeModulesDir: string): Promise<Set<string>> {
	const packageNames = new Set<string>();
	for (const entry of await readdirIfExists(nodeModulesDir)) {
		if (!entry.isDirectory() || entry.name === ".bin") continue;
		if (entry.name.startsWith("@")) {
			for (const scopedEntry of await readdirIfExists(path.join(nodeModulesDir, entry.name))) {
				if (scopedEntry.isDirectory()) packageNames.add(`${entry.name}/${scopedEntry.name}`);
			}
			continue;
		}
		packageNames.add(entry.name);
	}
	return packageNames;
}

async function pruneBunCacheAfterGlobalInstall(): Promise<BunInstallCachePruneResult | undefined> {
	const cacheDir = await resolveBunInstallCacheDir();
	if (!cacheDir) return undefined;
	const globalNodeModulesDir = await resolveBunGlobalNodeModulesDir(cacheDir);
	const packageNames = globalNodeModulesDir
		? await collectInstalledPackageNames(globalNodeModulesDir)
		: new Set<string>();
	// Old installs may still use an omp-named cache dir; recognize both brands.
	const cacheBase = path.basename(cacheDir).toLowerCase();
	if (packageNames.size === 0 && !cacheBase.includes("veyyon") && !cacheBase.includes("omp")) return undefined;
	return await pruneBunInstallCache(cacheDir, packageNames.size === 0 ? undefined : packageNames);
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `veyyon` maps to in the user's PATH.
 */
function resolveVeyyonPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved veyyon binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const veyyonPath = resolveVeyyonPath();
	if (!veyyonPath) return { ok: false };
	try {
		const result = await $`${veyyonPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: veyyonPath };
		const output = result.text().trim();
		// Output format: "veyyon/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: veyyonPath };
	} catch {
		return { ok: false, path: veyyonPath };
	}
}

/**
 * Where an in-progress update reports what it is doing.
 *
 * `veyyon update` is a plain CLI run and prints to the console. An automatic
 * update runs underneath a live TUI, where any stray write lands in the middle
 * of the rendered frame and corrupts it, so that caller passes
 * {@link SILENT_UPDATE_REPORTER} and reports the outcome through its own UI.
 */
export type UpdateReporter = (line: string) => void;

export const CONSOLE_UPDATE_REPORTER: UpdateReporter = line => {
	console.log(line);
};

export const SILENT_UPDATE_REPORTER: UpdateReporter = () => {};

/** What kind of install just completed, so the completion line uses the verb the
 *  user asked for: an update moves forward, a rollback moves back. */
export type InstallAction = "update" | "rollback";

/**
 * The two lines a finished install prints: a success line whose verb matches the
 * action (`Updated to`/`Rolled back to`, never "Updated to" on a rollback), and
 * the reminder that the running process still holds the old version until a
 * restart. Pure and exported so the wording is unit-testable without running an
 * install, and so both flows and every method share one wording owner.
 */
export function formatInstallCompletion(version: string, action: InstallAction): { success: string; restart: string } {
	const verb = action === "rollback" ? "Rolled back to" : "Updated to";
	return {
		success: `${verb} ${APP_NAME} ${version}`,
		restart: `Restart ${APP_NAME} to use it`,
	};
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify installed version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Verify the on-disk version and print the single post-install completion
 * message. ONE owner of that ending so every method (bun/npm/brew/mise/binary)
 * and both flows finish identically: a version check, then either a loud
 * mismatch warning or a green line whose verb matches the action
 * (`Updated to`/`Rolled back to`), then the reminder that the running process
 * still holds the old version until a restart — a reminder every method now
 * gives, not only the binary path.
 */
async function reportInstallComplete(
	expectedVersion: string,
	action: InstallAction,
	report: UpdateReporter,
): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (!result.ok) {
		report(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
		report(chalk.yellow(`You may need to reinstall: bun install -g ${PACKAGE}`));
		return;
	}
	const { success, restart } = formatInstallCompletion(expectedVersion, action);
	report(chalk.green(`\n${theme.status.success} ${success}`));
	report(chalk.dim(restart));
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleBackups} on the next update once it is no
 * longer in use. Returns whether the file is gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update backups left by earlier runs.
 *
 * Each self-update moves the previous executable to `<binary>.<timestamp>.<pid>.bak`
 * before swapping the new one in. On Windows that backup cannot be deleted
 * while the updating process is alive, so it is left for a later run to reclaim
 * once its owning process has exited. Also matches the legacy fixed
 * `<binary>.bak` name produced before backups were timestamped, so users
 * upgrading from a buggy release get the orphaned file cleaned up.
 */
export async function sweepStaleBackups(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`) || !entry.endsWith(".bak")) continue;
		// Legacy "<base>.bak" → empty middle; new "<base>.<timestamp>.<pid>.bak"
		// → dot-separated numeric run. Anything else is an unrelated *.bak file.
		const middle = entry.slice(base.length + 1, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		await removeBackupBestEffort(path.join(dir, entry));
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// Refuse an empty or missing download BEFORE disturbing the live binary.
		// A truncated-but-HTTP-200 body would otherwise be renamed over the running
		// binary and only caught afterwards by the `--version` check, leaving the
		// user with a broken binary for the duration of the rollback. This mirrors
		// install.sh's `finalize_binary` guard (`[ -s "$tmp" ]`), which fails
		// before ever touching the destination. `backupReady` is still false, so
		// the catch cleans the junk temp and never runs a needless restore.
		let tempSize: number;
		try {
			tempSize = (await fs.promises.stat(options.tempPath)).size;
		} catch (err) {
			if (isEnoent(err)) throw new Error("Downloaded update is missing; not replacing the installed binary");
			throw err;
		}
		if (tempSize === 0) {
			throw new Error("Downloaded update is empty; not replacing the installed binary");
		}
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

function buildVersionedPackageInstallArgs(expectedVersion: string, nativeTag: string): string[] {
	const args = [`${PACKAGE}@${expectedVersion}`, `${NATIVES_PACKAGE}@${expectedVersion}`];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${NATIVES_PACKAGE}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

/**
 * Build the bun argv used to globally install a specific veyyon version.
 *
 * The version is selected by hitting {@link NPM_REGISTRY} directly in
 * {@link getLatestRelease}, so the install MUST observe the same catalog:
 *
 * - `--registry=${NPM_REGISTRY}` pins the install to the official registry
 *   regardless of the user's bunfig/`.npmrc`. A mirror (corporate proxy,
 *   Taobao, …) that hasn't yet replicated the release would otherwise reject
 *   a version the upstream registry already advertises.
 * - `--no-cache` tells bun to ignore its on-disk manifest snapshot so it
 *   re-fetches metadata from that registry on every invocation.
 *
 * Together these two flags make `veyyon update` produce exactly the registry
 * lookup the version check just performed. See #1686.
 *
 * Also pins {@link NATIVES_PACKAGE} and the platform-specific
 * `@veyyon/natives-<tag>` leaf to `expectedVersion`. `bun install -g`
 * does not reliably refresh transitive `optionalDependencies` when the
 * top-level package is the only one bumped, so the native addon and its
 * version sentinel can drift out of sync with the freshly installed
 * `@veyyon/coding-agent` and the loader aborts at
 * `validateLoadedBindings` on the next launch
 * (`The .node file on disk is from a different release than this loader`).
 * Listing the natives explicitly forces bun to replace them in lock-step.
 * The leaf is added only on tags the release pipeline actually publishes
 * ({@link SUPPORTED_NATIVE_TAGS}) so unsupported platforms still fail with
 * the original "no matching version" message instead of `EBADPLATFORM`.
 * See #1824.
 */
export function buildBunInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	return [
		"install",
		"-g",
		"--no-cache",
		`--registry=${resolveNpmRegistry()}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag),
	];
}

/** Build the npm argv used to update npm-managed global installs. */
export function buildNpmInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	const args = [
		"install",
		"-g",
		`--registry=${resolveNpmRegistry()}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag),
	];
	return args;
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Update via package manager.
 */
async function updateViaBun(expectedVersion: string, report: UpdateReporter): Promise<void> {
	report(chalk.dim("Updating via bun..."));
	const args = buildBunInstallArgs(expectedVersion);
	const result = await $`bun ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`bun install failed with exit code ${result.exitCode}`);
	}

	try {
		const pruneResult = await pruneBunCacheAfterGlobalInstall();
		if (pruneResult && pruneResult.removedEntries > 0) {
			report(chalk.dim(`Pruned ${pruneResult.removedEntries} stale Bun cache entries`));
		}
	} catch (err) {
		report(chalk.yellow(`Warning: could not prune stale Bun cache entries: ${err}`));
	}
}

async function updateViaNpm(expectedVersion: string, report: UpdateReporter): Promise<void> {
	report(chalk.dim("Updating via npm..."));
	const args = buildNpmInstallArgs(expectedVersion);
	const result = await $`npm ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`npm install failed with exit code ${result.exitCode}`);
	}
}

async function updateViaHomebrew(force: boolean, report: UpdateReporter): Promise<void> {
	report(chalk.dim("Updating Homebrew formulae..."));
	const update = await $`brew update`.nothrow();
	if (update.exitCode !== 0) {
		throw new Error(`brew update failed with exit code ${update.exitCode}`);
	}

	report(chalk.dim("Updating via Homebrew..."));
	const args = buildHomebrewUpdateArgs(force);
	const result = await $`brew ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`brew ${args[0]} failed with exit code ${result.exitCode}`);
	}
}

async function updateViaMise(expectedVersion: string, force: boolean, report: UpdateReporter): Promise<void> {
	report(chalk.dim("Updating via mise..."));
	const args = buildMiseUpgradeArgs();
	const result = await $`mise ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string, report: UpdateReporter): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	// Unique per attempt: a stale backup from an earlier update may still be
	// locked (it is the previous process image on Windows), and a fixed name
	// would force the move-aside rename to overwrite it. pid + timestamp keeps
	// two forced updates in the same millisecond from colliding.
	const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
	report(chalk.dim(`Downloading ${binaryName}…`));

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	try {
		await pipeline(response.body, fileStream);
	} catch (err) {
		// A mid-download failure (network drop) leaves a partial `<binary>.new`
		// behind: we throw here before reaching replaceBinaryForUpdate, whose catch
		// would otherwise clean it up. Remove it so a failed update never litters
		// the install dir, matching install.sh's EXIT/INT/TERM trap on its tmpbin.
		await unlinkIfExists(tempPath);
		throw err;
	}

	report(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion,
	});
	// Reclaim backups from earlier updates whose owning process has since exited.
	await sweepStaleBackups(targetPath);
}

/**
 * Install a specific release through whichever mechanism owns the veyyon binary
 * currently first in PATH (Homebrew, mise, bun, npm, or a bare binary swap).
 *
 * This is the single owner of that dispatch: both `veyyon update` and the
 * automatic startup update go through it, so they can never drift into
 * updating by different rules.
 */
export async function installRelease(
	version: string,
	force: boolean,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
): Promise<void> {
	const target = await resolveUpdateTarget();
	await installReleaseVia(target, version, force, report);
}

/**
 * Dispatch a versioned install to the method that owns the resolved target.
 *
 * Single owner of the method switch so `installRelease` (which resolves the
 * target itself) and `rollbackToVersion` (which resolves it once to guard brew
 * before installing) can never dispatch by different rules. On success it
 * records the version transition for the rollback picker's markers; a failed
 * install throws before reaching the record, so history never claims a
 * transition that did not happen.
 */
async function installReleaseVia(
	target: UpdateTarget,
	version: string,
	force: boolean,
	report: UpdateReporter,
	action: InstallAction = "update",
): Promise<void> {
	if (target.method === "brew") {
		await updateViaHomebrew(force, report);
	} else if (target.method === "mise") {
		await updateViaMise(version, force, report);
	} else if (target.method === "bun") {
		await updateViaBun(version, report);
	} else if (target.method === "npm") {
		await updateViaNpm(version, report);
	} else {
		await updateViaBinaryAt(target.path, version, report);
	}
	if (version !== VERSION) {
		await recordUpdateHistory(VERSION, version);
	}
	// Single owner of the completion message: verify the on-disk version and
	// print the action-correct success line plus the restart reminder, so every
	// method and both flows end the same way.
	await reportInstallComplete(version, action, report);
}

/**
 * Whether the install method can be pinned to an arbitrary earlier version.
 *
 * Every method except Homebrew can install a specific version: bun/npm pin
 * `pkg@version`, mise force-installs `tool@version`, and the bare-binary swap
 * downloads the exact `v<version>` release asset. Homebrew only ever installs
 * the current formula version (`brew upgrade`/`reinstall`), so a rollback under
 * a brew-managed install cannot honor the requested version and must refuse
 * loudly rather than silently reinstall latest (Law 10).
 */
export function canRollbackVia(method: UpdateMethod): boolean {
	return method !== "brew";
}

/** One recorded version transition performed by an update or a rollback. */
export interface UpdateHistoryEntry {
	from: string;
	to: string;
	/** ISO-8601 timestamp of the transition. */
	at: string;
}

/**
 * Read the recorded version-transition history, newest last. Missing history is
 * an empty list (a fresh install has none); a corrupt file is logged and
 * treated as empty rather than crashing a rollback, because history is only
 * annotation for the picker's markers and never gates an install.
 */
export async function readUpdateHistory(statePath: string = getUpdateHistoryPath()): Promise<UpdateHistoryEntry[]> {
	try {
		const raw = await Bun.file(statePath).text();
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is UpdateHistoryEntry =>
				typeof e === "object" &&
				e !== null &&
				typeof (e as UpdateHistoryEntry).from === "string" &&
				typeof (e as UpdateHistoryEntry).to === "string" &&
				typeof (e as UpdateHistoryEntry).at === "string",
		);
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Could not read update history; treating as empty", { statePath, error: errorMessage(err) });
		return [];
	}
}

/**
 * The version the install was on immediately before it reached `current`, from
 * the recorded history — the natural "roll back one step" target the picker
 * marks as `previous`. It is the `from` of the newest transition that landed on
 * `current`; if history has no such transition (fresh install, or `current` was
 * never recorded), there is no previous version and this returns undefined.
 * Pure so the marker is unit-testable without a history file. Single owner: the
 * picker host and any settings surface read the "previous" version from here.
 */
export function previousVersionFromHistory(
	history: readonly UpdateHistoryEntry[],
	current: string,
): string | undefined {
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (entry && entry.to === current && entry.from !== current) return entry.from;
	}
	return undefined;
}

/**
 * Append a version transition to the history file (kept to the most recent 50).
 * Best-effort and LOUD on failure: a write error is logged, not swallowed, but
 * it does not fail the install/rollback the caller just performed, since the
 * binary swap already succeeded and losing an annotation must not undo it.
 */
async function recordUpdateHistory(
	from: string,
	to: string,
	statePath: string = getUpdateHistoryPath(),
): Promise<void> {
	try {
		const entries = await readUpdateHistory(statePath);
		entries.push({ from, to, at: new Date().toISOString() });
		await Bun.write(statePath, `${JSON.stringify(entries.slice(-50), null, 2)}\n`);
	} catch (err) {
		logger.warn("Could not record update history", { statePath, from, to, error: errorMessage(err) });
	}
}

/**
 * Roll the install back (or forward) to a specific published version.
 *
 * Reuses the same {@link installReleaseVia} dispatch as an update, with
 * `force = true` so installing an OLDER version than the current one still
 * proceeds. Guards before touching anything: an invalid version, rolling back
 * to the version already running, or a Homebrew-managed install (which cannot
 * pin an arbitrary version) each throw with an explanation instead of doing
 * something surprising.
 */
export async function rollbackToVersion(
	version: string,
	report: UpdateReporter = CONSOLE_UPDATE_REPORTER,
): Promise<void> {
	if (!isValidSemver(version)) {
		throw new Error(`Not a valid version to roll back to: ${version}`);
	}
	if (compareSemver(version, VERSION) === 0) {
		throw new Error(`Already on ${APP_NAME} ${version}; nothing to roll back to.`);
	}
	const target = await resolveUpdateTarget();
	if (!canRollbackVia(target.method)) {
		throw new Error(
			`Rollback is not supported for Homebrew-managed installs: brew installs the latest formula version, not ${version}. ` +
				`Install the version another way (for example \`bun install -g ${PACKAGE}@${version}\`) or pin it with Homebrew directly.`,
		);
	}
	report(chalk.dim(`Rolling ${APP_NAME} back to ${version}…`));
	await installReleaseVia(target, version, true, report, "rollback");
}

/**
 * Outcome of an automatic update attempt.
 *
 * `updated` means the new version is on disk and takes effect on the next
 * launch, not in the running process. `failed` carries the reason so the caller
 * can show it: an update that quietly does nothing would leave you pinned to an
 * old version with no way to notice (Law 10).
 */
export type AutoUpdateOutcome =
	| { status: "up-to-date" }
	| { status: "updated"; version: string }
	| { status: "failed"; version?: string; error: string }
	| { status: "skipped"; version: string; reason: AutoUpdateSkipReason };

/**
 * Why a background update did not attempt an install.
 *
 * `another-process` means a concurrently launched session is already installing
 * that version. `recent-failure` means installing this same version failed
 * recently enough that retrying now would only reproduce it; see
 * {@link AUTO_UPDATE_FAILURE_COOLDOWN_MS}.
 */
export type AutoUpdateSkipReason = "another-process" | "recent-failure";

/**
 * Update to the latest release without printing anything or exiting.
 *
 * {@link runUpdateCommand} is the interactive front end for the same work; this
 * is the form a running session can call, where `console.log` would corrupt the
 * TUI and `process.exit` would kill the user's session.
 *
 * Two things make this safe to run on every launch rather than only on demand.
 * The install runs under a cross-process lock, so opening several terminals at
 * once installs once instead of racing several package-manager writes at the
 * same binary. And a failure is recorded, so a machine that cannot install at
 * all reports the reason and then backs off instead of failing loudly on every
 * launch forever.
 *
 * `statePath` names the file holding that failure record and acting as the lock
 * target. It defaults to the per-user state file and exists as a parameter so a
 * test can point the whole mechanism at a temporary directory instead of the
 * real one.
 */
export async function runAutoUpdate(
	currentVersion: string = VERSION,
	knownRelease?: ReleaseInfo,
	statePath: string = getAutoUpdateStatePath(),
): Promise<AutoUpdateOutcome> {
	let release: ReleaseInfo;
	if (knownRelease) {
		// The startup check already asked the registry. Reusing its answer keeps a
		// launch to one round trip instead of two.
		release = knownRelease;
	} else {
		try {
			release = await getLatestRelease();
		} catch (err) {
			return { status: "failed", error: errorMessage(err) };
		}
	}
	if (!isNewerVersion(release.version, currentVersion)) {
		return { status: "up-to-date" };
	}

	const state = await readAutoUpdateState(statePath);
	if (!shouldAttemptAutoUpdate(state, release.version, Date.now())) {
		logger.warn("Skipping automatic update: installing this version failed recently", {
			version: release.version,
			error: state.failedError,
			retryAfterMs: AUTO_UPDATE_FAILURE_COOLDOWN_MS,
		});
		return { status: "skipped", version: release.version, reason: "recent-failure" };
	}

	const attempt = await tryWithFileLock(
		statePath,
		async (): Promise<AutoUpdateOutcome> => {
			try {
				// Silent: this runs under a live TUI, where any console write corrupts the frame.
				await installRelease(release.version, false, SILENT_UPDATE_REPORTER);
			} catch (err) {
				const error = errorMessage(err);
				await recordAutoUpdateFailure(release.version, error, statePath);
				return { status: "failed", version: release.version, error };
			}
			await clearAutoUpdateFailure(statePath);
			return { status: "updated", version: release.version };
		},
		{ staleMs: AUTO_UPDATE_LOCK_STALE_MS },
	);
	if (!attempt.acquired) {
		logger.info("Skipping automatic update: another session is already installing it", {
			version: release.version,
		});
		return { status: "skipped", version: release.version, reason: "another-process" };
	}
	return attempt.value;
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		// err.message, not `${err}`: the latter stringifies as "Error: …" and
		// produces a doubled "Failed to check for updates: Error: Failed to …".
		console.error(chalk.red(`Failed to check for updates: ${errorMessage(err)}`));
		process.exit(1);
	}

	const comparison = compareSemver(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// Choose update method based on the prioritized veyyon binary in PATH
	try {
		await installRelease(release.version, opts.force);
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
`);
}
