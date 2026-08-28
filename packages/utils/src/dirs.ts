import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { engines, version } from "../package.json" with { type: "json" };
import { APP_DIRECTORY_SLUG } from "./app-identity";
// Side effect: environment scrub and $HOME/.env before first DirResolver is built.
import "./dotenv-home";
import { atomicWriteFileSync } from "./atomic-write";
import { AGENT_DIR_ENV_KEYS, CONFIG_DIR_ENV_KEYS, PROFILE_ENV_KEYS, SANDBOX_MARKER_ENV_KEY } from "./dir-env-keys";
import { withFileLockSync } from "./file-lock";
import { isMissingPath } from "./fs-error";
import { isUuid } from "./regex";
import { bareVersion } from "./semver";
import { sleepSync } from "./sleep";
import { errorMessage, isRecord } from "./type-guards";
import { syncYamlTextToSettings } from "./yaml-sync";

/** App name slug used in filesystem paths. */
export const APP_NAME: string = APP_DIRECTORY_SLUG;

/** Short launch alias installed next to the binary. */
export const APP_ALIAS: string = "vey";

/** Canonical marketing/docs site. */
export const SITE_URL: string = "https://veyyon.dev";

/** Public changelog/releases page. */
export const CHANGELOG_URL: string = "https://veyyon.dev/changelog";

/** Returns the changelog URL scrolled to a specific version. */
export function changelogUrlForVersion(version: string): string {
	const bare = bareVersion(version);
	return `${CHANGELOG_URL}#v${bare.replace(/\./g, "-")}`;
}

/** Config directory name. */
export const CONFIG_DIR_NAME: string = ".veyyon";

/** Ordered main settings filenames (canonical first, legacy YAML fallback second). */
export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

const GLOBAL_CONFIG_READ_RETRY_ATTEMPTS = 3;
const GLOBAL_CONFIG_READ_RETRY_DELAY_MS = 5;
const INSTALL_ID_FILE = "install-id";

/** App version. */
export const VERSION: string = version;

/** Minimum Bun version. */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** Validate and normalize a profile name. Returns undefined for default. */
export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	)
		throw new Error(
			`Invalid profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	return normalized;
}

/** Resolve the active profile from the VEYYON_PROFILE env var. */
export function resolveProfileEnv(value: string | undefined): string | undefined {
	return normalizeProfileName(value);
}

function pickProcessEnv(...keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = process.env[key];
		if (value !== undefined) return value;
	}
	return undefined;
}

export { DIR_OVERRIDE_ENV_KEYS } from "./dir-env-keys";

function readAgentDirEnv(): string | undefined {
	return pickProcessEnv(...AGENT_DIR_ENV_KEYS);
}

function writeAgentDirEnv(dir: string | undefined): void {
	for (const key of AGENT_DIR_ENV_KEYS) {
		if (dir === undefined) delete process.env[key];
		else process.env[key] = dir;
	}
}

/** Resolve the active profile from environment variables. */
export function resolveProfileFromEnv(): string | undefined {
	for (const key of PROFILE_ENV_KEYS) {
		const value = process.env[key];
		if (value === undefined) continue;
		try {
			return normalizeProfileName(value);
		} catch (error) {
			throw new Error(`Invalid ${key}: ${errorMessage(error)}`);
		}
	}
	return undefined;
}

function getProfileFromEnv(): string | undefined {
	return resolveProfileFromEnv();
}

function readProfileFromEnvSafe(): string | undefined {
	try {
		return getProfileFromEnv();
	} catch {
		return undefined;
	}
}

function resolveStartupProfileSafe(): string | undefined {
	if (profileEnvIsSet()) return readProfileFromEnvSafe();
	return readGlobalDefaultProfileSafe();
}

function isUsableXdgBase(envVar: string, value: string): boolean {
	if (path.isAbsolute(value)) return true;
	process.emitWarning(
		`${envVar} is set to the relative path "${value}"; the XDG base-directory spec requires an absolute path, ` +
			`so it is being ignored and veyyon is using its default location instead. ` +
			`Set ${envVar} to an absolute path (for example "${path.join(os.homedir(), value)}") to use it.`,
		{ code: "VEYYON_XDG_RELATIVE_PATH" },
	);
	return false;
}

/** Resolve the user's home directory, throwing if empty or filesystem root. */
export function resolveHomeDirOrThrow(): string {
	const home = os.homedir();
	if (!home || !path.isAbsolute(home)) {
		throw new Error(
			`Cannot determine your home directory: HOME is unset or empty (os.homedir() returned ${JSON.stringify(home)}). ` +
				`Every veyyon path is resolved from it, and without it settings and credentials would be written to a ` +
				`relative path that changes with the working directory. Set HOME to an absolute path, or set ` +
				`VEYYON_CONFIG_DIR to place the config root explicitly.`,
		);
	}
	if (path.parse(home).root === home) {
		throw new Error(
			`HOME is set to the filesystem root (${home}), so veyyon would create ${path.join(home, CONFIG_DIR_NAME)} ` +
				`at the top of the filesystem. Set HOME to a real home directory, or set VEYYON_CONFIG_DIR to an ` +
				`absolute path that places the config root explicitly.`,
		);
	}
	return home;
}

function getBaseConfigRoot(): string {
	return getConfigRootOverride() ?? path.join(resolveHomeDirOrThrow(), CONFIG_DIR_NAME);
}

/** Default profile directory name. */
export const DEFAULT_PROFILE_DIR_NAME = "default";

/** Profiles directory name under the config root. */
export const PROFILES_DIR_NAME = "profiles";

function getProfileConfigRoot(profile: string | undefined): string {
	return path.join(getBaseConfigRoot(), PROFILES_DIR_NAME, profile ?? DEFAULT_PROFILE_DIR_NAME);
}

/** Read defaultProfile from the global config file. */
export function resolveGlobalDefaultProfile(): string | undefined {
	const { record, filePath } = readGlobalConfigRecord();
	const value = record.defaultProfile;
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`Global config ${filePath}: defaultProfile must be a string profile name.`);
	}
	try {
		return normalizeProfileName(value);
	} catch (error) {
		throw new Error(`Global config ${filePath}: ${errorMessage(error)}`);
	}
}

/** Set or clear defaultProfile in the global config file. */
export function writeGlobalDefaultProfile(profile: string | undefined): string {
	const normalized = normalizeProfileName(profile);
	return mutateGlobalConfigKey("defaultProfile", () => normalized);
}

type MainConfigCandidate =
	| { kind: "absent" }
	| { kind: "map"; record: Record<string, unknown>; text: string }
	| { kind: "not-a-map" };

interface ConfigFileKind {
	subject: string;
	repairHint: string;
}

const GLOBAL_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Global config",
	repairHint: "Fix or remove the file (it holds only cross-profile keys like defaultProfile).",
};

const PROFILE_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Profile config",
	repairHint: "Fix or remove the file.",
};

function readConfigFileText(filePath: string, fileKind: ConfigFileKind): string | undefined {
	for (let attempt = 0; ; attempt++) {
		try {
			return fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if (isMissingPath(error)) return undefined;
			if (attempt < GLOBAL_CONFIG_READ_RETRY_ATTEMPTS) {
				sleepSync(GLOBAL_CONFIG_READ_RETRY_DELAY_MS);
				continue;
			}
			throw new Error(
				`${fileKind.subject} ${filePath} could not be read: ${errorMessage(error)}. ` +
					`Nothing was changed; restore the file's readability and retry.`,
			);
		}
	}
}

function classifyConfigCandidate(filePath: string, fileKind: ConfigFileKind): MainConfigCandidate {
	const text = readConfigFileText(filePath, fileKind);
	if (text === undefined) return { kind: "absent" };
	let parsed: unknown;
	try {
		parsed = YAML.parse(text);
	} catch (error) {
		throw new Error(
			`${fileKind.subject} ${filePath} is not valid YAML: ${errorMessage(error)}. ${fileKind.repairHint}`,
		);
	}
	if (isRecord(parsed)) return { kind: "map", record: parsed as Record<string, unknown>, text };
	return { kind: "not-a-map" };
}

interface MainConfigSelection {
	filePath: string;
	candidate: MainConfigCandidate;
}

function selectMainConfigFile(root: string, fileKind: ConfigFileKind): MainConfigSelection {
	let firstPresent: MainConfigSelection | undefined;
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const filePath = path.join(root, filename);
		const candidate = classifyConfigCandidate(filePath, fileKind);
		if (candidate.kind === "map") return { filePath, candidate };
		if (candidate.kind === "not-a-map") firstPresent ??= { filePath, candidate };
	}
	return firstPresent ?? { filePath: path.join(root, MAIN_CONFIG_FILENAMES[0]), candidate: { kind: "absent" } };
}

interface GlobalConfigRead {
	record: Record<string, unknown>;
	filePath: string;
	presentButUnusable: boolean;
}

function readGlobalConfigRecord(): GlobalConfigRead {
	const { filePath, candidate } = selectMainConfigFile(getBaseConfigRoot(), GLOBAL_CONFIG_FILE_KIND);
	return {
		record: candidate.kind === "map" ? candidate.record : {},
		filePath,
		presentButUnusable: candidate.kind === "not-a-map",
	};
}

/** Returns the global config file path used for reads and writes. */
export function getGlobalConfigFilePath(): string {
	const root = getBaseConfigRoot();
	try {
		return selectMainConfigFile(root, GLOBAL_CONFIG_FILE_KIND).filePath;
	} catch {
		return path.join(root, MAIN_CONFIG_FILENAMES[0]);
	}
}

export interface ShadowedConfigFile {
	ignored: string;
	using: string;
}

/** Find config files that exist but are shadowed by higher-precedence files. */
export function findShadowedGlobalConfigFiles(root: string = getBaseConfigRoot()): ShadowedConfigFile[] {
	const present = MAIN_CONFIG_FILENAMES.filter(filename => fs.existsSync(path.join(root, filename)));
	const usable = present.find(filename => {
		try {
			return classifyConfigCandidate(path.join(root, filename), GLOBAL_CONFIG_FILE_KIND).kind === "map";
		} catch {
			return false;
		}
	});
	const winner = usable ?? present[0];
	if (winner === undefined) return [];
	return present
		.filter(filename => filename !== winner)
		.map(filename => ({
			ignored: path.join(root, filename),
			using: path.join(root, winner),
		}));
}

function mutateGlobalConfigKey(key: string, mutate: (current: Record<string, unknown>) => unknown): string {
	const root = getBaseConfigRoot();
	fs.mkdirSync(root, { recursive: true });
	const canonicalPath = path.join(root, MAIN_CONFIG_FILENAMES[0]);
	return withFileLockSync(canonicalPath, () => {
		const { filePath, candidate } = selectMainConfigFile(root, {
			subject: GLOBAL_CONFIG_FILE_KIND.subject,
			repairHint: `Fix or remove the file before changing ${key}.`,
		});
		const existing = candidate.kind === "map" ? candidate.record : {};
		const existingText = candidate.kind === "map" ? candidate.text : "";
		const next = mutate(existing);
		if (next === undefined) delete existing[key];
		else existing[key] = next;
		if (Object.keys(existing).length === 0) {
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					process.emitWarning(
						`Could not remove the now-empty global config ${filePath} (${errorMessage(error)}); ` +
							`writing it empty instead so the removal of "${key}" persists.`,
						{ code: "VEYYON_CONFIG_UNLINK_FAILED" },
					);
					atomicWriteFileSync(filePath, "");
				}
			}
			return filePath;
		}
		atomicWriteFileSync(filePath, syncYamlTextToSettings(existingText, existing));
		return filePath;
	});
}

const AUTH_BROKER_SEGMENTS = ["auth", "broker"] as const;

export interface GlobalAuthBroker {
	url: string | undefined;
	tokenSet: boolean;
}

function readAuthBrokerValue(record: Record<string, unknown>, leaf: "url" | "token"): string | undefined {
	const auth = record[AUTH_BROKER_SEGMENTS[0]];
	if (isRecord(auth)) {
		const broker = auth[AUTH_BROKER_SEGMENTS[1]];
		if (isRecord(broker) && typeof broker[leaf] === "string" && (broker[leaf] as string).length > 0) {
			return broker[leaf] as string;
		}
	}
	const flat = record[`${AUTH_BROKER_SEGMENTS.join(".")}.${leaf}`];
	return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

/** Read the auth-broker url and token presence from the global config. */
export function readGlobalAuthBrokerSafe(): GlobalAuthBroker {
	try {
		const { record } = readGlobalConfigRecord();
		return {
			url: readAuthBrokerValue(record, "url"),
			tokenSet: readAuthBrokerValue(record, "token") !== undefined,
		};
	} catch {
		return { url: undefined, tokenSet: false };
	}
}

function writeGlobalAuthBrokerLeaf(leaf: "url" | "token", value: string | undefined): string {
	const [authKey, brokerKey] = AUTH_BROKER_SEGMENTS;
	return mutateGlobalConfigKey(authKey, existing => {
		delete existing[`${authKey}.${brokerKey}.${leaf}`];
		const auth = isRecord(existing[authKey]) ? (existing[authKey] as Record<string, unknown>) : {};
		const broker = isRecord(auth[brokerKey]) ? (auth[brokerKey] as Record<string, unknown>) : {};
		const trimmed = value?.trim();
		if (trimmed) broker[leaf] = trimmed;
		else delete broker[leaf];
		if (Object.keys(broker).length > 0) auth[brokerKey] = broker;
		else delete auth[brokerKey];
		return Object.keys(auth).length > 0 ? auth : undefined;
	});
}

/** Set or clear the global auth-broker URL. */
export function writeGlobalAuthBrokerUrl(url: string | undefined): string {
	return writeGlobalAuthBrokerLeaf("url", url);
}

/** Set or clear the global auth-broker bearer token. */
export function writeGlobalAuthBrokerToken(token: string | undefined): string {
	return writeGlobalAuthBrokerLeaf("token", token);
}

export const PROFILE_SHARING_CONFIG_KEY = "profileSharing";

/** Whether provider credentials are shared across profiles. */
export function resolveGlobalProfileSharing(): boolean {
	const { record, filePath } = readGlobalConfigRecord();
	const value = record[PROFILE_SHARING_CONFIG_KEY];
	if (value === undefined || value === null) return true;
	if (typeof value !== "boolean") {
		throw new Error(
			`Global config ${filePath}: ${PROFILE_SHARING_CONFIG_KEY} must be a boolean ` +
				`(true = share credentials across profiles, false = isolate). Got ${typeof value}.`,
		);
	}
	return value;
}

/** Module-load-safe variant of resolveGlobalProfileSharing. */
export function readGlobalProfileSharingSafe(): boolean {
	try {
		return resolveGlobalProfileSharing();
	} catch {
		return true;
	}
}

/** Set the credential-sharing posture in the global config. */
export function writeGlobalProfileSharing(shared: boolean): string {
	return mutateGlobalConfigKey(PROFILE_SHARING_CONFIG_KEY, () => (shared ? undefined : false));
}

export const ONBOARDING_VERSION_CONFIG_KEY = "onboardingVersion";

export interface GlobalOnboardingVersion {
	version: number | undefined;
	unreadable: boolean;
}

/** The onboarding generation this machine has completed. */
export function resolveGlobalOnboardingVersion(): number | undefined {
	const { record, filePath, presentButUnusable } = readGlobalConfigRecord();
	if (presentButUnusable) {
		throw new Error(
			`Global config ${filePath} exists but holds no settings mapping (it is empty, or not a YAML map), ` +
				`so whether this machine has already completed setup cannot be read. ` +
				`Restore or delete the file; setup was NOT treated as unfinished.`,
		);
	}
	const value = record[ONBOARDING_VERSION_CONFIG_KEY];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(
			`Global config ${filePath}: ${ONBOARDING_VERSION_CONFIG_KEY} must be a finite number ` +
				`(the setup generation already completed on this machine). Got ${typeof value}.`,
		);
	}
	return value;
}

/** Safe variant of resolveGlobalOnboardingVersion reporting if unreadable. */
export function readGlobalOnboardingVersionSafe(): GlobalOnboardingVersion {
	try {
		return { version: resolveGlobalOnboardingVersion(), unreadable: false };
	} catch {
		return { version: undefined, unreadable: true };
	}
}

/** Record the onboarding generation in the global config. */
export function writeGlobalOnboardingVersion(version: number | undefined): string {
	return mutateGlobalConfigKey(ONBOARDING_VERSION_CONFIG_KEY, () => version);
}

const LEGACY_PROFILE_SETUP_VERSION_KEY = "setupVersion";

export interface LegacyProfileSetupVersion {
	version: number | undefined;
	unreadable: boolean;
}

/** The highest retired setupVersion recorded by any profile under profiles/. */
export function readLegacyProfileSetupVersion(): LegacyProfileSetupVersion {
	const profilesRoot = path.join(getBaseConfigRoot(), PROFILES_DIR_NAME);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
	} catch (error) {
		return { version: undefined, unreadable: !isMissingPath(error) };
	}
	let version: number | undefined;
	let unreadable = false;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let candidate: MainConfigCandidate;
		try {
			candidate = selectMainConfigFile(
				path.join(profilesRoot, entry.name, "agent"),
				PROFILE_CONFIG_FILE_KIND,
			).candidate;
		} catch {
			unreadable = true;
			continue;
		}
		if (candidate.kind === "absent") continue;
		if (candidate.kind === "not-a-map") {
			unreadable = true;
			continue;
		}
		const value = candidate.record[LEGACY_PROFILE_SETUP_VERSION_KEY];
		if (value === undefined || value === null) continue;
		if (typeof value !== "number" || !Number.isFinite(value)) {
			unreadable = true;
			continue;
		}
		version = version === undefined ? value : Math.max(version, value);
	}
	return { version, unreadable };
}

/** Machine-wide shared credential store directory. */
export function getSharedAuthDir(): string {
	return path.join(getBaseConfigRoot(), "shared-auth");
}

/** Module-load-safe variant of resolveGlobalDefaultProfile. */
export function readGlobalDefaultProfileSafe(): string | undefined {
	try {
		return resolveGlobalDefaultProfile();
	} catch {
		return undefined;
	}
}

/** Whether any profile environment variable is set. */
export function profileEnvIsSet(): boolean {
	return PROFILE_ENV_KEYS.some(key => process.env[key] !== undefined);
}

/** Startup profile resolution. */
export function resolveStartupProfile(): string | undefined {
	if (profileEnvIsSet()) return resolveProfileFromEnv();
	return resolveGlobalDefaultProfile();
}

function getProfileAgentDir(profile: string): string {
	return path.join(getProfileConfigRoot(profile), "agent");
}

function isProfileDerivedAgentDir(profile: string | undefined, agentDirEnv: string | undefined): boolean {
	return profile !== undefined && agentDirEnv === getProfileAgentDir(profile);
}

function standardizeMacOSPath(p: string): string {
	if (process.platform !== "darwin" || !p.startsWith("/private/")) return p;
	const stripped = p.slice("/private".length);
	try {
		if (fs.realpathSync(p) === fs.realpathSync(stripped)) {
			return stripped;
		}
	} catch {}
	return p;
}

export function resolveEquivalentPath(inputPath: string): string {
	const resolvedPath = path.resolve(inputPath);
	try {
		return fs.realpathSync(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

export function normalizePathForComparison(inputPath: string): string {
	const resolvedPath = resolveEquivalentPath(inputPath);
	return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

export function pathIsWithin(root: string, candidate: string): boolean {
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Path from root down to candidate, or null when candidate is not under root. */
export function relativePathWithinRoot(root: string, candidate: string): string | null {
	const resolvedRoot = resolveEquivalentPath(root);
	const resolvedCandidate = resolveEquivalentPath(candidate);
	const normalizedRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
	const normalizedCandidate = process.platform === "win32" ? resolvedCandidate.toLowerCase() : resolvedCandidate;
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	const depth = relative.split(PATH_SEPARATORS).filter(segment => segment !== "").length;
	if (depth === 0) return null;
	const segments = resolvedCandidate.split(PATH_SEPARATORS).filter(segment => segment !== "");
	return segments.slice(Math.max(0, segments.length - depth)).join(path.sep) || null;
}

const PATH_SEPARATORS = /[\\/]+/u;

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/** Move the project directory, and the process working directory with it. */
export function setProjectDir(dir: string): void {
	const resolved = standardizeMacOSPath(path.resolve(dir));
	try {
		process.chdir(resolved);
	} catch (error) {
		throw new Error(
			`Cannot enter the project directory: ${resolved}\n` +
				`  ${errorMessage(error)}\n` +
				`Check that the directory still exists and that you have permission to read it.`,
			{ cause: error },
		);
	}
	projectDir = resolved;
}

/** Whether dir resolves to an existing directory. */
export async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

function looksAbsolute(value: string): boolean {
	return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isUnderPath(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** The config root named by VEYYON_CONFIG_DIR, or undefined when unset. */
export function getConfigRootOverride(): string | undefined {
	const override = pickProcessEnv(...CONFIG_DIR_ENV_KEYS);
	if (override === undefined || override === "") return undefined;
	const key = CONFIG_DIR_ENV_KEYS[0];
	if (override.trim() === "") {
		throw new Error(
			`${key} is set to whitespace (${JSON.stringify(override)}). It names the directory veyyon keeps its ` +
				`configuration in, so this would create a directory whose name you cannot see. Set it to an absolute ` +
				`path such as "/srv/veyyon", or unset it to use the default (${path.join("~", CONFIG_DIR_NAME)}).`,
		);
	}
	if (!path.isAbsolute(override) && looksAbsolute(override)) {
		throw new Error(
			`${key} is set to "${override}", which is written as an absolute path for another platform and cannot ` +
				`be one here, so it would be resolved as a relative name and create a directory whose name contains ` +
				`a path separator. Set it to an absolute path in this platform's form, such as "/srv/veyyon".`,
		);
	}
	const home = resolveHomeDirOrThrow();
	const resolved = path.resolve(home, override);
	if (isUnderPath(resolved, home) && !process.env[SANDBOX_MARKER_ENV_KEY]) {
		throw new Error(
			`${key} resolves to "${resolved}", which is inside your home directory ("${home}").\n` +
				`It is a PATH to the config root, not a name hung off your home.\n` +
				`Set it to an absolute path OUTSIDE your home (for example "/srv/veyyon", or a temp directory), or ` +
				`unset it to use the default (${path.join(home, CONFIG_DIR_NAME)}).`,
		);
	}
	return resolved;
}

/** Config root relative to home. */
export function getConfigDirName(): string {
	const override = getConfigRootOverride();
	return override === undefined ? CONFIG_DIR_NAME : path.relative(resolveHomeDirOrThrow(), override);
}

/** Get the config agent directory name relative to home. */
export function getConfigAgentDirName(): string {
	return path.join(getConfigDirName(), PROFILES_DIR_NAME, getActiveProfileOrDefault(), "agent");
}

type XdgCategory = "data" | "state" | "cache";

/** Resolves and caches all veyyon directory paths. */
class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	readonly #rootDirs: Record<XdgCategory, string>;
	readonly #agentDirs: Record<XdgCategory, string>;
	readonly #rootCache = new Map<string, string>();
	readonly #agentCache = new Map<string, string>();

	constructor(options: { agentDirOverride?: string; profile?: string } = {}) {
		const profile = normalizeProfileName(options.profile);
		this.configRoot = getProfileConfigRoot(profile);

		const defaultAgent = path.join(this.configRoot, "agent");
		const agentDirOverride = profile ? undefined : options.agentDirOverride;
		this.agentDir = agentDirOverride ? path.resolve(agentDirOverride) : defaultAgent;
		const isDefault = this.agentDir === defaultAgent;

		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (!value || !isUsableXdgBase(envVar, value)) return undefined;
				try {
					const appRoot = path.join(value, APP_NAME);
					if (profile) {
						const profilePath = path.join(appRoot, PROFILES_DIR_NAME, profile);
						return fs.existsSync(profilePath) ? profilePath : undefined;
					}
					return fs.existsSync(appRoot) ? appRoot : undefined;
				} catch {}
				return undefined;
			};
			xdgData = resolveIf("XDG_DATA_HOME");
			xdgState = resolveIf("XDG_STATE_HOME");
			xdgCache = resolveIf("XDG_CACHE_HOME");
		}

		this.#rootDirs = {
			data: xdgData ?? this.configRoot,
			state: xdgState ?? this.configRoot,
			cache: xdgCache ?? this.configRoot,
		};
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	static #cacheKey(subdir: string, xdg?: XdgCategory): string {
		return `${xdg ?? ""}\0${subdir}`;
	}

	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const key = DirResolver.#cacheKey(subdir, xdg);
		const cached = this.#rootCache.get(key);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(key, result);
		return result;
	}

	agentSubdir(userAgentDir: string | undefined, subdir: string, xdg?: XdgCategory): string {
		if (!userAgentDir || userAgentDir === this.agentDir) {
			const key = DirResolver.#cacheKey(subdir, xdg);
			const cached = this.#agentCache.get(key);
			if (cached) return cached;
			const base = xdg ? this.#agentDirs[xdg] : this.agentDir;
			const result = path.join(base, subdir);
			this.#agentCache.set(key, result);
			return result;
		}
		return path.join(userAgentDir, subdir);
	}
}

function resolvePreProfileAgentDir(profile: string | undefined, agentDirEnv: string | undefined): string | undefined {
	return isProfileDerivedAgentDir(profile, agentDirEnv) ? undefined : agentDirEnv;
}

let activeProfile = resolveStartupProfileSafe();

function resolveActiveAgentDirOverride(): string | undefined {
	return activeProfile ? undefined : resolvePreProfileAgentDir(undefined, readAgentDirEnv());
}

try {
	if (activeProfile === undefined && fs.existsSync(path.join(getBaseConfigRoot(), "agent"))) {
		process.emitWarning(
			`Legacy veyyon layout detected at ${path.join(getBaseConfigRoot(), "agent")} — the default profile now lives at ` +
				`${getProfileConfigRoot(undefined)}. Run the veyyon CLI once to migrate (it moves the legacy tree, or names ` +
				`the conflict if both layouts exist).`,
			{ code: "VEYYON_LEGACY_LAYOUT" },
		);
	}
} catch {}

let dirs = new DirResolver({
	agentDirOverride: resolveActiveAgentDirOverride(),
	profile: activeProfile,
});

let preProfileAgentDirEnv: string | undefined = resolvePreProfileAgentDir(activeProfile, readAgentDirEnv());
const RESOLVER_HOME = os.homedir();

/** Rebuild the dirs resolver from the current environment. */
export function refreshDirsFromEnv(): void {
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

/** Get the active profile's config root (~/.veyyon/profiles/<name>). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/** Get the global config home (~/.veyyon). */
export function getGlobalConfigRootDir(): string {
	return getBaseConfigRoot();
}

export interface DirOverridesSnapshot {
	agentDirEnv: string | undefined;
	profileEnv: string | undefined;
	profile: string | undefined;
	preProfileAgentDir: string | undefined;
}

/** Capture process-global dir overrides for later restoration. */
export function captureDirOverrides(): DirOverridesSnapshot {
	return {
		agentDirEnv: process.env[AGENT_DIR_ENV_KEYS[0]],
		profileEnv: process.env.VEYYON_PROFILE,
		profile: activeProfile,
		preProfileAgentDir: preProfileAgentDirEnv,
	};
}

/** Restore environment and active profile from snapshot. */
export function restoreDirOverrides(snapshot: DirOverridesSnapshot): void {
	writeSnapshotEnv(snapshot);
	__resetDirsFromEnvForTests();
	if (activeProfile !== snapshot.profile) setProfile(snapshot.profile);
	writeSnapshotEnv(snapshot);
	preProfileAgentDirEnv = snapshot.preProfileAgentDir;
	refreshDirsFromEnv();
}

/** Test-only: read pre-profile agent-dir baseline. */
export function __preProfileAgentDirForTests(): string | undefined {
	return preProfileAgentDirEnv;
}

function writeSnapshotEnv(snapshot: DirOverridesSnapshot): void {
	if (snapshot.agentDirEnv === undefined) delete process.env[AGENT_DIR_ENV_KEYS[0]];
	else process.env[AGENT_DIR_ENV_KEYS[0]] = snapshot.agentDirEnv;
	if (snapshot.profileEnv === undefined) delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = snapshot.profileEnv;
}

/** Set the coding agent directory. */
export function setAgentDir(dir: string): void {
	activeProfile = undefined;
	dirs = new DirResolver({ agentDirOverride: dir });
	writeAgentDirEnv(dir);
	preProfileAgentDirEnv = dir;
	for (const key of PROFILE_ENV_KEYS) {
		delete process.env[key];
	}
}

/** Test-only: reset pre-profile agent-dir snapshot from environment. */
export function __resetProfileSnapshotForTests(): void {
	preProfileAgentDirEnv = resolvePreProfileAgentDir(activeProfile, readAgentDirEnv());
}

/** Test-only: rebuild profile and directory state from current process env. */
export function __resetDirsFromEnvForTests(): void {
	activeProfile = resolveStartupProfileSafe();
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
}

/** Activate a named profile. Passing undefined or "default" returns to default. */
export function setProfile(profile: string | undefined): void {
	const next = normalizeProfileName(profile);
	if (next && !activeProfile) {
		preProfileAgentDirEnv = resolvePreProfileAgentDir(undefined, readAgentDirEnv());
	}
	activeProfile = next;
	if (activeProfile) {
		dirs = new DirResolver({ profile: activeProfile });
		process.env.VEYYON_PROFILE = activeProfile;
		writeAgentDirEnv(dirs.agentDir);
	} else {
		for (const key of PROFILE_ENV_KEYS) {
			delete process.env[key];
		}
		writeAgentDirEnv(preProfileAgentDirEnv);
		dirs = new DirResolver({ agentDirOverride: preProfileAgentDirEnv });
	}
}

/** Get the active named profile. Undefined means the default profile. */
export function getActiveProfile(): string | undefined {
	return activeProfile;
}

/** Get the active profile directory name (or "default"). */
export function getActiveProfileOrDefault(): string {
	return getActiveProfile() ?? DEFAULT_PROFILE_DIR_NAME;
}

/** Resolve the config root that backs a profile without activating it. */
export function getProfileRootDir(profile: string | undefined): string {
	return getProfileConfigRoot(normalizeProfileName(profile));
}

/** Fail-closed guard for recursive profile-directory removal. */
export function assertRemovableProfileDir(target: string): string {
	const resolved = path.resolve(target);
	const profilesRoot = path.resolve(path.join(getBaseConfigRoot(), PROFILES_DIR_NAME));
	const parent = path.dirname(resolved);
	const base = path.basename(resolved);
	if (parent !== profilesRoot || base === "" || base === "." || base === "..") {
		throw new Error(
			`Refusing to recursively remove ${resolved}: a profile operation may only delete a direct child of ${profilesRoot} ` +
				`(a named profile or its staging sibling), never the profiles root, the config root, the home directory, or a path outside the profiles tree. ` +
				`This is a fail-closed guard against wiping the whole profiles tree.`,
		);
	}
	return resolved;
}

export interface ProfileInfo {
	name: string;
	rootDir: string;
	agentDir: string;
}

/** Enumerate the default profile plus every named profile under profiles/. */
export function listProfiles(): ProfileInfo[] {
	const defaultRoot = getProfileConfigRoot(undefined);
	const profiles: ProfileInfo[] = [
		{
			name: DEFAULT_PROFILE_DIR_NAME,
			rootDir: defaultRoot,
			agentDir: path.join(defaultRoot, "agent"),
		},
	];

	const profilesDir = path.join(getBaseConfigRoot(), PROFILES_DIR_NAME);
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(profilesDir, { withFileTypes: true });
	} catch {
		return profiles;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			if (normalizeProfileName(entry.name) === undefined) continue;
		} catch {
			continue;
		}
		const rootDir = path.join(profilesDir, entry.name);
		profiles.push({
			name: entry.name,
			rootDir,
			agentDir: path.join(rootDir, "agent"),
		});
	}

	profiles.sort((left, right) => left.name.localeCompare(right.name));
	return profiles;
}

/** Existing legacy per-profile shared-auth directories. */
export function getLegacyPerProfileSharedAuthDirs(): string[] {
	const dirsOut: string[] = [];
	for (const profile of listProfiles()) {
		const dir = path.join(profile.rootDir, "shared-auth");
		if (fs.existsSync(dir)) dirsOut.push(dir);
	}
	return dirsOut;
}

/** Whether a profile root exists on disk. */
export function profileExists(profile: string | undefined): boolean {
	const normalized = normalizeProfileName(profile);
	if (!normalized) {
		return fs.existsSync(path.join(getProfileConfigRoot(undefined), "agent"));
	}
	return fs.existsSync(getProfileConfigRoot(normalized));
}

const GLOBAL_ROOT_ENTRIES = new Set<string>([PROFILES_DIR_NAME, INSTALL_ID_FILE, ...MAIN_CONFIG_FILENAMES]);

export interface LegacyLayoutMigrationResult {
	migrated: boolean;
	movedEntries: string[];
	targetDir: string;
}

const LEGACY_MIGRATION_MARKER = ".migration-in-progress";

/** One-time move of legacy bare-root default profile into profiles/default/. */
export function migrateLegacyDefaultProfileLayout(): LegacyLayoutMigrationResult {
	const root = getBaseConfigRoot();
	const legacyAgentDir = path.join(root, "agent");
	const targetDir = path.join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME);
	const markerPath = path.join(targetDir, LEGACY_MIGRATION_MARKER);
	const resuming = fs.existsSync(markerPath);

	if (!fs.existsSync(legacyAgentDir) && !resuming) {
		return { migrated: false, movedEntries: [], targetDir };
	}
	if (fs.existsSync(targetDir) && !resuming) {
		throw new Error(
			`Both the legacy default-profile layout (${legacyAgentDir}) and the new one (${targetDir}) exist. ` +
				`Veyyon cannot guess which is current. Merge or remove one — typically: move the contents of ` +
				`${legacyAgentDir} (and sibling state dirs like logs/, plugins/, cache/) into ${targetDir}, ` +
				`then delete the legacy copies — and relaunch.`,
		);
	}
	fs.mkdirSync(targetDir, { recursive: true });
	fs.writeFileSync(markerPath, "");
	const movedEntries: string[] = [];
	for (const entry of fs.readdirSync(root)) {
		if (GLOBAL_ROOT_ENTRIES.has(entry)) continue;
		fs.renameSync(path.join(root, entry), path.join(targetDir, entry));
		movedEntries.push(entry);
	}
	fs.rmSync(markerPath, { force: true });
	movedEntries.sort((a, b) => a.localeCompare(b));
	return { migrated: true, movedEntries, targetDir };
}

/** Get the active profile's agent config directory. */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.veyyon). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

/** Get the reports directory. */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory. */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file. */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/** Get the plugins directory for the active profile. */
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), PROFILES_DIR_NAME, getActiveProfileOrDefault(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Plugin node_modules directory under profile plugins dir. */
export function getPluginsNodeModules(home?: string): string {
	return path.join(getPluginsDir(home), "node_modules");
}

/** Plugin package.json path under profile plugins dir. */
export function getPluginsPackageJson(home?: string): string {
	return path.join(getPluginsDir(home), "package.json");
}

/** Plugin lock file path under profile plugins dir. */
export function getPluginsLockfile(home?: string): string {
	return path.join(getPluginsDir(home), "veyyon-plugins.lock.json");
}

/** Get the remote mount directory. */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let p = trimmed;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = os.homedir() + p.slice(1);
	return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

let worktreesDirOverride: string | undefined;

/** Relocate the base directory for agent-managed worktrees. */
export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

/** Get the agent-managed worktrees directory. */
export function getWorktreesDir(): string {
	return (
		resolveWorktreeBase(pickProcessEnv("VEYYON_WORKTREE_DIR")) ??
		worktreesDirOverride ??
		dirs.rootSubdir("wt", "data")
	);
}

/** Get the SSH control socket directory. */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory. */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory. */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory. */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory. */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get the docs.rs web cache directory. */
export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

/** Get the AutoQA database directory. */
export function getAutoQaDbDir(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}

/** Stable 7-character hex digest of an absolute filesystem path. */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory. */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path. */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/** Get the GitHub view cache database path. */
export function getGithubCacheDbPath(): string {
	const override = pickProcessEnv("VEYYON_GITHUB_CACHE_DB");
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "github-cache.db"), "cache");
}

/** Get the encrypted auth-broker snapshot cache path. */
export function getAuthBrokerSnapshotCachePath(): string {
	const override = pickProcessEnv("VEYYON_AUTH_BROKER_SNAPSHOT_CACHE");
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "auth-broker-snapshot.enc"), "cache");
}

/** Get the local FastEmbed model cache directory. */
export function getFastembedCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed"), "cache");
}

/** Get the fastembed runtime install directory. */
export function getFastembedRuntimeDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed-runtime"), "cache");
}

/** Get the natives directory. */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/** Get the argot shorthand cache directory. */
export function getArgotCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "argot"), "cache");
}

/** Get the stats database path. */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory. */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory. */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch database path. */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

/** Get the path to agent.db. */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/** Returns the shared auth directory if sharing is enabled. */
export function getSharedAuthStoreDirIfEnabled(): string | undefined {
	return readGlobalProfileSharingSafe() ? getSharedAuthDir() : undefined;
}

/** Get the active agent.db auth path. */
export function getActiveAuthDbPath(agentDir?: string): string {
	return getAgentDbPath(getSharedAuthStoreDirIfEnabled() ?? agentDir ?? getAgentDir());
}

/** Get the last-seen-changelog-version marker file path. */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/** Get the automatic-update state file path. */
export function getAutoUpdateStatePath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "auto-update-state.json", "state");
}

/** Get the update history file path. */
export function getUpdateHistoryPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "update-history.json", "state");
}

/** Get the session history database path. */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the model cache database path. */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the tiny models cache directory. */
export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

/** Get the document conversion cache directory. */
export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}

/** Get the sessions directory. */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory. */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory. */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory. */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the prompts directory. */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the memories directory. */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory. */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the debug log path. */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

/** Get the project-level prompts directory. */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path. */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

/** Get the primary MCP config file path. */
export function getMCPConfigPath(
	scope: "user" | "project",
	cwd: string = getProjectDir(),
	agentDir: string = getAgentDir(),
): string {
	if (scope === "user") {
		return path.join(agentDir, "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH host config path for a profile. */
export function getSSHConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "ssh.json");
}

let cachedInstallId: string | null = null;

/** Persistent per-install UUID stored at ~/.veyyon/install-id. */
export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getBaseConfigRoot(), INSTALL_ID_FILE);

	let observedInvalid = false;
	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (isUuid(existing)) {
			cachedInstallId = existing;
			return existing;
		}
		observedInvalid = true;
		if (existing.length > 0) {
			process.emitWarning(
				`${filePath} does not contain a UUID (${existing.length} bytes), so it is being replaced with a new ` +
					`install id. Anything that identified this install by the old value will see it as a new install.`,
				{ code: "VEYYON_INSTALL_ID_INVALID" },
			);
		}
	} catch (err) {
		if (!isMissingPath(err)) {
			process.emitWarning(
				`${filePath} exists but could not be read (${errorMessage(err)}), so this install's identity could not be ` +
					`recovered. A new id is being used; fix the file's permissions to keep one stable identity.`,
				{ code: "VEYYON_INSTALL_ID_UNREADABLE" },
			);
		}
	}

	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		if (observedInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {}
		}
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${next}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (isUuid(existing)) {
					cachedInstallId = existing;
					return existing;
				}
			} catch {}
		}
		process.emitWarning(
			`Could not persist an install id to ${filePath} (${errorMessage(err)}). This run is using a temporary id, and ` +
				`every future run will generate another one until the path is writable.`,
			{ code: "VEYYON_INSTALL_ID_NOT_PERSISTED" },
		);
	}

	cachedInstallId = next;
	return next;
}

/** Test-only: clear cached install id. */
export function __resetInstallIdCacheForTests(): void {
	cachedInstallId = null;
}
