/**
 * Centralized path helpers for veyyon config directories.
 *
 * Uses VEYYON_CONFIG_DIR (default ".veyyon") for the config root and
 * VEYYON_CODING_AGENT_DIR to override the agent directory.
 *
 * On Linux, if XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME environment
 * variables are set, paths are redirected to XDG-compliant locations under
 * $XDG_*_HOME/veyyon/. This requires running `veyyon config migrate` first to
 * move data to the new locations. No filesystem existence checks are performed
 * — if the env var is set, veyyon trusts that the migration has been done.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { engines, version } from "../package.json" with { type: "json" };
import { atomicWriteFileSync } from "./atomic-write";
import { withFileLockSync } from "./file-lock";
import { isUuid } from "./regex";
import { errorMessage, isRecord } from "./type-guards";

/** App name (e.g. "veyyon") */
export const APP_NAME: string = "veyyon";

/** Canonical marketing/docs site. Single owner — import, never re-hardcode. */
export const SITE_URL: string = "https://veyyon.dev";

/** Public changelog/releases page. Where `/changelog` and the update notice point. */
export const CHANGELOG_URL: string = "https://veyyon.dev/changelog";

/** Config directory name (e.g. ".veyyon") */
export const CONFIG_DIR_NAME: string = ".veyyon";

/** Ordered main settings filenames: canonical write target first, legacy-compatible YAML fallback second. */
export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/** Basename of the per-install UUID file at the config root (see {@link getInstallId}). */
const INSTALL_ID_FILE = "install-id";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_ENV_KEYS = ["VEYYON_PROFILE"] as const;

/**
 * Names Windows treats as reserved device aliases. Matches the basename
 * itself as well as any `BASENAME.<anything>` form, because Windows reserves
 * `CON.foo`/`PRN.txt`/etc. too — using them as a profile name would let
 * `setProfile` accept the input only for directory creation to fail later
 * with a confusing `ENOENT`/`EINVAL`. Case-insensitive: NTFS treats `CON`
 * and `con` identically.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Normalize and validate a profile name. Returns `undefined` for the implicit
 * default (empty string, whitespace, or the explicit "default" sentinel) and
 * throws for syntactically invalid or platform-reserved names.
 *
 * Exported so consumers of `@veyyon/utils/dirs` (CLI bootstrap, tests,
 * downstream tools) can validate user input without re-deriving the rules.
 */
export function normalizeProfileName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === "default") return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}

/**
 * Resolve the active profile from the `VEYYON_PROFILE` env var. An
 * explicitly-empty value selects the default profile. Delegates
 * validation/normalization to {@link normalizeProfileName} (which throws on a
 * syntactically invalid value).
 */
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

/** Env key accepted for the agent-dir override. */
const AGENT_DIR_ENV_KEYS = ["VEYYON_CODING_AGENT_DIR"] as const;

/** Env key accepted for the config-dir-name override. */
const CONFIG_DIR_ENV_KEYS = ["VEYYON_CONFIG_DIR"] as const;

/**
 * Every env key that redirects veyyon directory resolution (agent dir,
 * profile, config-dir name). Tests spawning children that must resolve dirs
 * from a controlled location (e.g. XDG_* pointing at a temp root) strip these
 * so overrides inherited from the developer/CI environment cannot leak in.
 */
export const DIR_OVERRIDE_ENV_KEYS: readonly string[] = [
	...AGENT_DIR_ENV_KEYS,
	...PROFILE_ENV_KEYS,
	...CONFIG_DIR_ENV_KEYS,
];

/** One owner for reading the agent-dir override from the environment. */
function readAgentDirEnv(): string | undefined {
	return pickProcessEnv(...AGENT_DIR_ENV_KEYS);
}

/**
 * One owner for writing the agent-dir override so child processes reading the
 * key see the same value; `undefined` clears it.
 */
function writeAgentDirEnv(dir: string | undefined): void {
	for (const key of AGENT_DIR_ENV_KEYS) {
		if (dir === undefined) delete process.env[key];
		else process.env[key] = dir;
	}
}

/** Resolve the active profile from `VEYYON_PROFILE`. */
export function resolveProfileFromEnv(): string | undefined {
	for (const key of PROFILE_ENV_KEYS) {
		const value = process.env[key];
		if (value === undefined) continue;
		try {
			return normalizeProfileName(value);
		} catch (error) {
			// Name which env var carried the bad value — the operator set it out-of-band.
			throw new Error(`Invalid ${key}: ${errorMessage(error)}`);
		}
	}
	return undefined;
}

function getProfileFromEnv(): string | undefined {
	return resolveProfileFromEnv();
}

/**
 * Module-load profile resolution. Unlike {@link resolveStartupProfile}, an
 * invalid VEYYON_PROFILE value or broken global config
 * does NOT throw here — a bad value must not crash a bare `import` of this
 * module with an uncaught stack trace before the CLI's error handling is in
 * scope. The default profile is used instead; the CLI re-validates (see
 * `runCli` in coding-agent/src/cli.ts) so the user still gets a clean error.
 */
function readProfileFromEnvSafe(): string | undefined {
	try {
		return getProfileFromEnv();
	} catch {
		return undefined;
	}
}

/** Module-load-safe {@link resolveStartupProfile}: env (safe) first, then the global defaultProfile (safe). */
function resolveStartupProfileSafe(): string | undefined {
	if (profileEnvIsSet()) return readProfileFromEnvSafe();
	return readGlobalDefaultProfileSafe();
}

function getBaseConfigRoot(): string {
	return path.join(os.homedir(), getConfigDirName());
}

/** The default profile's directory name under `profiles/`. */
export const DEFAULT_PROFILE_DIR_NAME = "default";

/**
 * The single directory under the config root that holds all profiles
 * (`<configRoot>/profiles/<name>`). One owner for the segment name so a rename
 * or layout change touches exactly one place; every profile-path builder below
 * joins this rather than repeating the literal.
 */
export const PROFILES_DIR_NAME = "profiles";

/**
 * Every profile — including the default — lives under `profiles/<name>`.
 * The bare config root holds only global, cross-profile state (the global
 * `config.yml`, `install-id`, and `profiles/` itself); see
 * {@link migrateLegacyDefaultProfileLayout} for the one-time move off the
 * legacy bare-root layout.
 */
function getProfileConfigRoot(profile: string | undefined): string {
	return path.join(getBaseConfigRoot(), PROFILES_DIR_NAME, profile ?? DEFAULT_PROFILE_DIR_NAME);
}

/**
 * Read `defaultProfile` from the GLOBAL config file (`~/.veyyon/config.yml` /
 * `config.yaml` at the config root — distinct from any profile's own settings
 * file under `profiles/<name>/agent/`). Returns `undefined` when no global
 * config exists or the key is unset; throws on unreadable YAML or an invalid
 * profile name so the CLI can surface a clean error naming the file.
 */
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

/**
 * Set or clear `defaultProfile` in the GLOBAL config file, preserving every
 * other key. Pass a profile name to set (validated; "default" clears, since
 * the default profile needs no override) or `undefined` to clear. Returns the
 * file written.
 */
export function writeGlobalDefaultProfile(profile: string | undefined): string {
	const normalized = normalizeProfileName(profile);
	// `normalizeProfileName` collapses the default profile to `undefined`, which
	// clears the key — the default needs no override.
	return mutateGlobalConfigKey("defaultProfile", () => normalized);
}

/**
 * Read the whole GLOBAL config file as a parsed record plus the file it came
 * from (or `{}` and the canonical path when no file exists / it is not a YAML
 * mapping). Throws on unreadable YAML naming the file. One reader for every
 * global key so callers do not each re-implement the filename precedence; the
 * returned `filePath` lets each caller name the offending file in its own
 * value-validation errors.
 */
function readGlobalConfigRecord(): { record: Record<string, unknown>; filePath: string } {
	const root = getBaseConfigRoot();
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const filePath = path.join(root, filename);
		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(text);
		} catch (error) {
			throw new Error(
				`Global config ${filePath} is not valid YAML: ${errorMessage(error)}. ` +
					`Fix or remove the file (it holds only cross-profile keys like defaultProfile).`,
			);
		}
		return { record: isRecord(parsed) ? (parsed as Record<string, unknown>) : {}, filePath };
	}
	return { record: {}, filePath: path.join(root, MAIN_CONFIG_FILENAMES[0]) };
}

/**
 * Serialized read-modify-write of a single GLOBAL config key, preserving every
 * other key. `mutate` receives the current record and returns the value to
 * store, or `undefined` to delete the key. Returns the file written. One writer
 * for every global key so the lock target, atomicity, and empty-file cleanup
 * live in exactly one place (see {@link writeGlobalDefaultProfile}, which is a
 * thin wrapper over this).
 */
function mutateGlobalConfigKey(key: string, mutate: (current: Record<string, unknown>) => unknown): string {
	const root = getBaseConfigRoot();
	fs.mkdirSync(root, { recursive: true });
	// The canonical config path is the stable lock target regardless of which
	// filename actually exists on disk, so every writer serializes on one lock.
	const canonicalPath = path.join(root, MAIN_CONFIG_FILENAMES[0]);
	return withFileLockSync(canonicalPath, () => {
		let filePath = canonicalPath;
		let existing: Record<string, unknown> = {};
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const candidate = path.join(root, filename);
			let text: string;
			try {
				text = fs.readFileSync(candidate, "utf8");
			} catch {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = YAML.parse(text);
			} catch (error) {
				throw new Error(
					`Global config ${candidate} is not valid YAML: ${errorMessage(error)}. ` +
						`Fix or remove the file before changing ${key}.`,
				);
			}
			if (isRecord(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
			filePath = candidate;
			break;
		}
		const next = mutate(existing);
		if (next === undefined) delete existing[key];
		else existing[key] = next;
		if (Object.keys(existing).length === 0) {
			// Nothing left — remove the file rather than leaving an empty stub.
			//
			// If the unlink fails the removal still has to persist. Swallowing it left
			// the file holding its previous contents, so the key the caller just
			// deleted came back on the next read: a profile switch or a change to the
			// credential-sharing posture reported success and silently reverted. An
			// empty file is a worse-looking but honest end state, and the next write
			// cleans it up. A failure to write that is left to throw, because at that
			// point nothing can be persisted and saying so is the only correct move.
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					// process.emitWarning rather than the logger: logger imports this
					// module for getLogsDir, so importing it back would close a cycle in
					// the module that resolves every path the logger needs.
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
		// Atomic: an interrupted write here would corrupt cross-profile keys
		// (the pointer to the active profile, credential-sharing posture).
		atomicWriteFileSync(filePath, YAML.stringify(existing, null, 2));
		return filePath;
	});
}

/**
 * The auth-broker keys in the GLOBAL config. Stored NESTED
 * (`auth: { broker: { url, token } }`); the reader also accepts the legacy
 * flat literal keys (`"auth.broker.url"`), matching the discovery precedence
 * in `packages/ai/src/auth-broker/discover.ts` (nested wins). The writers
 * always persist the nested form and remove any legacy flat duplicate so the
 * value has exactly one home after the first write.
 */
const AUTH_BROKER_SEGMENTS = ["auth", "broker"] as const;

/** The global auth-broker configuration, read without ever exposing the token. */
export interface GlobalAuthBroker {
	url: string | undefined;
	/** Whether a token is stored. The plaintext is deliberately not returned:
	 * settings surfaces render presence, never the secret. */
	tokenSet: boolean;
}

function readAuthBrokerValue(record: Record<string, unknown>, leaf: "url" | "token"): string | undefined {
	// Nested form wins over the legacy flat literal-dot key.
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

/**
 * Read the auth-broker url and token PRESENCE from the GLOBAL config. Safe:
 * a broken global config must never crash a bare import or the settings UI;
 * discovery re-validates loudly on the auth path itself.
 */
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

/** Set or clear (`undefined`/empty) one auth-broker leaf, preserving every
 * other key. Writes the nested form, deletes any legacy flat duplicate, and
 * prunes empty `broker`/`auth` records so a fully cleared config leaves no
 * stub behind. */
function writeGlobalAuthBrokerLeaf(leaf: "url" | "token", value: string | undefined): string {
	const [authKey, brokerKey] = AUTH_BROKER_SEGMENTS;
	return mutateGlobalConfigKey(authKey, existing => {
		// The legacy flat literal key would shadow-read forever; one home only.
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

/** Set or clear the global auth-broker URL. Returns the file written. */
export function writeGlobalAuthBrokerUrl(url: string | undefined): string {
	return writeGlobalAuthBrokerLeaf("url", url);
}

/** Set or clear the global auth-broker bearer token. Never logged, never read
 * back into any UI surface (see {@link readGlobalAuthBrokerSafe}). Returns the
 * file written. */
export function writeGlobalAuthBrokerToken(token: string | undefined): string {
	return writeGlobalAuthBrokerLeaf("token", token);
}

/**
 * The global-config key controlling whether provider credentials are shared
 * across profiles. Absent or `true` means shared (the default posture); `false`
 * isolates each profile to its own credential store. One owner for the literal
 * so the reader, writer, and any settings-domain binding agree.
 */
export const PROFILE_SHARING_CONFIG_KEY = "profileSharing";

/**
 * Whether provider credentials are shared across profiles (the "shared by
 * default" posture). Reads `profileSharing` from the GLOBAL config: absent →
 * shared (`true`); an explicit boolean is honored. A non-boolean value throws
 * naming the file, matching {@link resolveGlobalDefaultProfile}'s strictness so
 * a typo cannot silently flip the credential posture.
 */
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

/** Module-load-safe variant of {@link resolveGlobalProfileSharing}: a broken/invalid global config must never crash a bare import; the CLI re-validates loudly. Defaults to shared. */
export function readGlobalProfileSharingSafe(): boolean {
	try {
		return resolveGlobalProfileSharing();
	} catch {
		return true;
	}
}

/**
 * Set the credential-sharing posture in the GLOBAL config, preserving every
 * other key. `true` shares credentials across profiles (deletes the key, since
 * shared is the default); `false` writes the explicit isolate flag. Returns the
 * file written.
 */
export function writeGlobalProfileSharing(shared: boolean): string {
	return mutateGlobalConfigKey(PROFILE_SHARING_CONFIG_KEY, () => (shared ? undefined : false));
}

/**
 * Directory whose `agent.db` holds the machine-wide SHARED credential store read
 * by every profile when {@link resolveGlobalProfileSharing} is on. Lives beside
 * the global `config.yml` at the base config root, under a dedicated name so it
 * never collides with the legacy `~/.veyyon/agent` layout (which triggers the
 * legacy-migration path) or with `profiles/`. Not XDG-redirected: the shared
 * store is intentionally one fixed machine-wide location.
 */
export function getSharedAuthDir(): string {
	return path.join(getBaseConfigRoot(), "shared-auth");
}

/** Module-load-safe variant of {@link resolveGlobalDefaultProfile}: a broken global config must not crash a bare import; the CLI re-validates loudly. */
export function readGlobalDefaultProfileSafe(): string | undefined {
	try {
		return resolveGlobalDefaultProfile();
	} catch {
		return undefined;
	}
}

/**
 * Whether any profile env var is present in the environment — including an
 * explicitly EMPTY `VEYYON_PROFILE=`, which deliberately forces the default
 * profile past the global `defaultProfile` setting.
 */
export function profileEnvIsSet(): boolean {
	return PROFILE_ENV_KEYS.some(key => process.env[key] !== undefined);
}

/**
 * Startup profile resolution shared by module load (safe) and the CLI
 * (strict): an env var — even empty — wins; otherwise the global
 * `defaultProfile`; otherwise the default profile.
 */
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
// =============================================================================
// Project directory
// =============================================================================

/**
 * On macOS, strip /private prefix only when both paths resolve to the same location.
 * This preserves aliases like /private/tmp -> /tmp without rewriting unrelated paths.
 */
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

export function relativePathWithinRoot(root: string, candidate: string): string | null {
	if (!pathIsWithin(root, candidate)) return null;
	const normalizedRoot = normalizePathForComparison(root);
	const normalizedCandidate = normalizePathForComparison(candidate);
	const relative = path.relative(normalizedRoot, normalizedCandidate);
	return relative || null;
}

let projectDir = standardizeMacOSPath(process.cwd());

/** Get the project directory. */
export function getProjectDir(): string {
	return projectDir;
}

/**
 * Move the project directory, and the process working directory with it.
 *
 * This is the only place either of those changes. They are one thing wearing two
 * hats: `getProjectDir` answers project-relative lookups (settings discovery,
 * AGENTS.md, git detection) and `process.cwd()` answers everything a child
 * process or a relative path resolves against. If they drift apart, half the
 * program is looking at a directory the user never chose, and nothing says so.
 *
 * The `chdir` therefore runs first and the global is assigned only once it has
 * succeeded. Assigning first meant a directory that had been deleted or turned
 * unreadable between resolving it and entering it left `getProjectDir` naming a
 * path the process could not reach, which is exactly the drift this function
 * exists to prevent. Throws when the directory cannot be entered; there is no
 * usable state to fall back to.
 */
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

/**
 * Whether `dir` resolves to an existing directory. Any stat failure — a deleted
 * path (ENOENT), permission error, or a non-directory — returns `false`, so
 * callers can decide whether a directory is safe to `chdir` into or adopt as a
 * working directory before {@link setProjectDir} throws on it.
 */
export async function directoryExists(dir: string): Promise<boolean> {
	try {
		return (await fs.promises.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/** Get the config directory name relative to home (e.g. ".veyyon" or VEYYON_CONFIG_DIR override). */
export function getConfigDirName(): string {
	return pickProcessEnv(...CONFIG_DIR_ENV_KEYS) || CONFIG_DIR_NAME;
}

/** Get the config agent directory name relative to home (e.g. ".veyyon/profiles/default/agent"). */
export function getConfigAgentDirName(): string {
	return path.join(getConfigDirName(), PROFILES_DIR_NAME, getActiveProfileOrDefault(), "agent");
}

// =============================================================================
// DirResolver — cached, XDG-aware path resolution
// =============================================================================

type XdgCategory = "data" | "state" | "cache";

/**
 * Resolves and caches all veyyon directory paths. On Linux, when XDG environment
 * variables are set, paths are redirected under $XDG_*_HOME/veyyon/. A new
 * instance is created whenever the agent directory changes, which naturally
 * invalidates all cached paths.
 */
class DirResolver {
	readonly configRoot: string;
	readonly agentDir: string;

	// Per-category base dirs. Without XDG, all three equal configRoot / agentDir.
	// With XDG on Linux, they point to $XDG_*_HOME/veyyon/.
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

		// XDG is a Linux convention. On supported platforms, default profile state
		// resolves under $XDG_*_HOME/veyyon once `veyyon config init-xdg` has migrated
		// the user's data. Named profiles follow a stricter rule: the XDG choice
		// is keyed on the profile-specific XDG path, never the base app root.
		//
		// Why: if we consulted the base app root for named profiles too, the same
		// profile could resolve to `~/.veyyon/profiles/<name>` on first activation
		// (when no $XDG_*_HOME/veyyon exists yet) and then silently move to
		// `$XDG_*_HOME/veyyon/profiles/<name>` the moment the base appeared, orphaning
		// the earlier state. Pinning on the profile path means a profile's location
		// is decided at first activation and stays put until the user explicitly
		// migrates it (e.g. by mkdir'ing the XDG profile dir).
		let xdgData: string | undefined;
		let xdgState: string | undefined;
		let xdgCache: string | undefined;
		if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
			const resolveIf = (envVar: string) => {
				const value = process.env[envVar];
				if (!value) return undefined;
				try {
					const appRoot = path.join(value, APP_NAME);
					if (profile) {
						const profilePath = path.join(appRoot, PROFILES_DIR_NAME, profile);
						if (fs.existsSync(profilePath)) {
							return profilePath;
						}
						return undefined;
					}
					if (fs.existsSync(appRoot)) {
						return appRoot;
					}
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
		// XDG flattens the agent/ prefix: ~/.veyyon/agent/sessions → $XDG_DATA_HOME/veyyon/sessions
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/**
	 * Cache key for a resolved subdirectory.
	 *
	 * The category is part of the key because it is part of the answer. Under XDG
	 * the three categories are three different roots (`~/.local/share/veyyon`,
	 * `~/.local/state/veyyon`, `~/.cache/veyyon`), so keying on the name alone
	 * meant the first caller to ask for a given name decided the root for every
	 * later caller, whatever category they asked for. Nothing collides today, and
	 * that is exactly why it needed fixing before something did: the symptom would
	 * be data written under one root and read back from another, on XDG machines
	 * only, with no error anywhere.
	 */
	static #cacheKey(subdir: string, xdg?: XdgCategory): string {
		return `${xdg ?? ""}\0${subdir}`;
	}

	/** Config-root subdirectory, with optional XDG override. */
	rootSubdir(subdir: string, xdg?: XdgCategory): string {
		const key = DirResolver.#cacheKey(subdir, xdg);
		const cached = this.#rootCache.get(key);
		if (cached) return cached;
		const base = xdg ? this.#rootDirs[xdg] : this.configRoot;
		const result = path.join(base, subdir);
		this.#rootCache.set(key, result);
		return result;
	}

	/** Agent subdirectory, with optional XDG override. */
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

/**
 * Decide which `VEYYON_CODING_AGENT_DIR` value to capture as the pre-profile
 * baseline. A value equal to a profile's derived agent dir is profile-derived
 * (propagated by a parent's `setProfile`), so it must NOT be snapshotted as the
 * default-mode baseline — otherwise default mode would resolve to the profile's
 * agent dir. Returns `undefined` in that case so reset falls back to the
 * standard `~/.veyyon/agent`.
 */
function resolvePreProfileAgentDir(profile: string | undefined, agentDirEnv: string | undefined): string | undefined {
	return isProfileDerivedAgentDir(profile, agentDirEnv) ? undefined : agentDirEnv;
}

let activeProfile = resolveStartupProfileSafe();

/**
 * Resolve the agent-dir override for the current `activeProfile` from the live
 * environment. A named profile derives its own agent dir (no override); default
 * mode honors a non-profile `VEYYON_CODING_AGENT_DIR` (see
 * {@link resolvePreProfileAgentDir}). Shared by the module-load resolver and
 * {@link refreshDirsFromEnv} so both apply identical logic.
 */
function resolveActiveAgentDirOverride(): string | undefined {
	return activeProfile ? undefined : resolvePreProfileAgentDir(undefined, readAgentDirEnv());
}

// Non-CLI entry points (SDK/library imports) never pass through the CLI's
// migrateLegacyDefaultProfileLayout() call. Reading the new layout while the
// user's data still sits in the legacy bare root would silently resolve to an
// empty tree, so surface it loudly here. Import must stay non-throwing; the
// CLI migrates (or fails closed) right after startup profile resolution.
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
/**
 * Snapshot of `VEYYON_CODING_AGENT_DIR` from before the first named-profile
 * activation. Reset paths restore this value (or its absence) instead of
 * unconditionally deleting the env var. Without the snapshot, a process started
 * with `VEYYON_CODING_AGENT_DIR=/custom` then `setProfile("work")` then
 * `setProfile(undefined)` would silently lose `/custom` and fall back to
 * `~/.veyyon/agent`. Captured at module load — ignoring a profile-derived value
 * inherited from a parent's `setProfile` (see {@link resolvePreProfileAgentDir})
 * — and refreshed on `setAgentDir`, since that call is the user explicitly
 * redefining the baseline.
 */
let preProfileAgentDirEnv: string | undefined = resolvePreProfileAgentDir(activeProfile, readAgentDirEnv());
// Anchor home for the resolver. Captured at module load to stay stable across
// test mocks of `os.homedir()`. `getPluginsDir(home)` compares against this so
// production callers (`home === RESOLVER_HOME`) hit the XDG-aware resolver while
// tests passing a temp HOME short-circuit to a deterministic path.
const RESOLVER_HOME = os.homedir();

/**
 * Rebuild the dirs resolver from the current environment, reusing the profile
 * resolved at module load. Directory-affecting keys (XDG_*_HOME and, in default
 * mode, `VEYYON_CODING_AGENT_DIR`) loaded from a profile/agent `.env` only reach
 * `process.env` *after* this module froze the resolver at import time, so
 * `env.ts` calls this once after applying its `.env` files. The agent `.env`
 * location derives from the profile name + home before this runs, so the
 * rebuild re-reads only the directory vars, never the profile selection. The
 * `preProfileAgentDirEnv` snapshot is intentionally left untouched.
 */
export function refreshDirsFromEnv(): void {
	dirs = new DirResolver({
		agentDirOverride: resolveActiveAgentDirOverride(),
		profile: activeProfile,
	});
}

// =============================================================================
// Root directories
// =============================================================================

/** Get the active profile's config root (~/.veyyon/profiles/<name>). */
export function getConfigRootDir(): string {
	return dirs.configRoot;
}

/**
 * Get the GLOBAL config home (~/.veyyon) — the cross-profile root holding the
 * global `config.yml`, `install-id`, and `profiles/`. Distinct from
 * {@link getConfigRootDir}, which is the active profile's own root.
 */
export function getGlobalConfigRootDir(): string {
	return getBaseConfigRoot();
}

/** Set the coding agent directory. Creates a fresh resolver, invalidating all cached paths. */
export function setAgentDir(dir: string): void {
	activeProfile = undefined;
	dirs = new DirResolver({ agentDirOverride: dir });
	writeAgentDirEnv(dir);
	preProfileAgentDirEnv = dir;
	for (const key of PROFILE_ENV_KEYS) {
		delete process.env[key];
	}
}

/**
 * Test-only: reset the pre-profile `VEYYON_CODING_AGENT_DIR` snapshot to whatever
 * the current environment looks like. Cross-suite test pollution can otherwise
 * leak a stale snapshot through `setAgentDir` and corrupt `setProfile(undefined)`
 * restore semantics. Production code MUST NOT call this — the snapshot's
 * lifecycle is owned by `setAgentDir` / `setProfile` and a runtime caller has
 * no business clearing it.
 */
export function __resetProfileSnapshotForTests(): void {
	preProfileAgentDirEnv = resolvePreProfileAgentDir(activeProfile, readAgentDirEnv());
}

/**
 * Test-only: rebuild profile + directory state from the current process env.
 * Production code keeps the module-load profile stable; tests that mutate
 * `setAgentDir`/`setProfile` need an exact restore point after they put env vars
 * back.
 */
export function __resetDirsFromEnvForTests(): void {
	activeProfile = resolveStartupProfileSafe();
	__resetProfileSnapshotForTests();
	refreshDirsFromEnv();
}

/** Activate a named profile. Passing undefined or "default" returns to the default profile. */
export function setProfile(profile: string | undefined): void {
	const next = normalizeProfileName(profile);
	if (next && !activeProfile) {
		// First activation of a named profile in this process: snapshot the
		// current VEYYON_CODING_AGENT_DIR so a later reset can restore the user's
		// explicit override. Subsequent profile switches keep the original
		// snapshot — the "pre-profile" baseline is the state before profiles
		// entered the picture, not the state between two activations.
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

/**
 * The active profile's directory name, resolving the undefined (default) case to
 * {@link DEFAULT_PROFILE_DIR_NAME}. One owner for the "active profile, or default"
 * idiom so the fallback can never drift between path builders.
 */
export function getActiveProfileOrDefault(): string {
	return getActiveProfile() ?? DEFAULT_PROFILE_DIR_NAME;
}

/** Resolve the config root that backs a profile without activating it. */
export function getProfileRootDir(profile: string | undefined): string {
	return getProfileConfigRoot(normalizeProfileName(profile));
}

/**
 * Fail-closed guard for recursive profile-directory removal. A profile
 * lifecycle operation may delete ONLY a direct child of the current profiles
 * root — `<configRoot>/profiles/<child>` — whether that child is a named
 * profile (`profiles/work`) or a staging sibling (`profiles/.work.<pid>.tmp`).
 *
 * It throws for anything else: the profiles root itself, the config root
 * (`~/.veyyon`), the home directory, or any ancestor of them, and any path
 * outside the profiles tree. This is defense in depth against the class of bug
 * that deleted a user's entire `~/.veyyon/profiles` during a bench run
 * (BACKLOG FINDING-HOST-PROFILE-DIR-DELETED-DURING-BENCH): a mis-computed target
 * (empty profile name, a bad join, a harness pointing at the wrong root) is
 * refused rather than silently wiping the whole profiles tree.
 *
 * It does not special-case "sandbox mode": a named profile dir is removable
 * under whatever config root is active (the real HOME or a VEYYON_CONFIG_DIR
 * override), and the roots themselves are never removable through a profile
 * operation under either. A sandbox teardown that legitimately wants to erase
 * everything removes its own temp root directly, not through this guard.
 *
 * Call this immediately before handing any path to a recursive remove in the
 * profile lifecycle. Returns the resolved absolute path so callers can remove
 * exactly what was validated (no TOCTOU gap between check and use).
 */
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

/** Resolved profile entry for lifecycle listing (`default` is the implicit home profile). */
export interface ProfileInfo {
	name: string;
	rootDir: string;
	agentDir: string;
}

/** Enumerate the default profile plus every named profile under `profiles/`. */
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
			// `default` normalizes to undefined — already covered by the fixed
			// first entry above, so skip its directory to avoid a duplicate row.
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

/**
 * Existing legacy per-profile `shared-auth` directories, one per profile that
 * has one on disk.
 *
 * Early builds resolved {@link getSharedAuthDir} under each profile's own root
 * (`profiles/<name>/shared-auth`). When the shared store moved to the machine-
 * global `~/.veyyon/shared-auth` (so every profile reads one set of logins),
 * credentials already written to those per-profile locations were left behind:
 * the global store starts empty and the first-run promotion only looked at the
 * per-profile *agent* dir, not this old shared-auth dir. Returning these lets
 * the shared-store seed find and promote orphaned logins so a user who updates
 * across that move is not silently logged out. Only directories that exist are
 * returned; the caller decides which to promote.
 */
export function getLegacyPerProfileSharedAuthDirs(): string[] {
	const dirsOut: string[] = [];
	for (const profile of listProfiles()) {
		const dir = path.join(profile.rootDir, "shared-auth");
		if (fs.existsSync(dir)) dirsOut.push(dir);
	}
	return dirsOut;
}

/** Whether a profile root exists on disk (`default` checks `~/.veyyon/profiles/default/agent`). */
export function profileExists(profile: string | undefined): boolean {
	const normalized = normalizeProfileName(profile);
	if (!normalized) {
		return fs.existsSync(path.join(getProfileConfigRoot(undefined), "agent"));
	}
	return fs.existsSync(getProfileConfigRoot(normalized));
}

// =============================================================================
// Legacy bare-root layout migration
// =============================================================================

/**
 * Root entries that stay GLOBAL (cross-profile) under the new layout. Every
 * other entry in the config root belongs to the legacy default profile and is
 * moved into `profiles/default/` by {@link migrateLegacyDefaultProfileLayout}.
 */
const GLOBAL_ROOT_ENTRIES = new Set<string>([PROFILES_DIR_NAME, INSTALL_ID_FILE, ...MAIN_CONFIG_FILENAMES]);

export interface LegacyLayoutMigrationResult {
	migrated: boolean;
	/** Entries moved into `profiles/default/` (empty when nothing to migrate). */
	movedEntries: string[];
	targetDir: string;
}

/**
 * Marker written inside `profiles/default/` while a legacy-layout migration is
 * moving entries, removed once every entry has landed. Its presence is how a
 * resumed migration tells an INTERRUPTED move (finish it) apart from a genuine
 * both-layouts conflict (fail closed).
 */
const LEGACY_MIGRATION_MARKER = ".migration-in-progress";

/**
 * One-time move of the legacy bare-root default profile
 * (`~/.veyyon/agent`, `~/.veyyon/logs`, …) into `~/.veyyon/profiles/default/`.
 *
 * - Nothing to do when no legacy `agent/` dir exists and no migration is in
 *   progress (fresh install, or already migrated).
 * - RESUMES an interrupted migration: if a prior run moved some entries and was
 *   killed mid-loop, a marker file inside `profiles/default/` survives, so the
 *   next run finishes moving the remaining root entries instead of leaving them
 *   silently orphaned outside the profile. The move is a set of independent
 *   same-filesystem renames, so replaying it is safe — an already-moved entry
 *   is simply no longer at the root.
 * - FAILS CLOSED when a FINISHED `profiles/default/` (no marker) and the legacy
 *   `agent/` dir both exist: two candidate default profiles is a state we must
 *   never guess about, so the error names both directories and how to reconcile.
 * - Reports what moved so the caller can print one loud notice.
 *
 * Must run before anything reads or writes profile paths (the CLI calls it
 * right after startup profile resolution, before `.env` loading).
 */
export function migrateLegacyDefaultProfileLayout(): LegacyLayoutMigrationResult {
	const root = getBaseConfigRoot();
	const legacyAgentDir = path.join(root, "agent");
	const targetDir = path.join(root, PROFILES_DIR_NAME, DEFAULT_PROFILE_DIR_NAME);
	const markerPath = path.join(targetDir, LEGACY_MIGRATION_MARKER);
	const resuming = fs.existsSync(markerPath);

	if (!fs.existsSync(legacyAgentDir) && !resuming) {
		// No legacy layout to move and no half-done migration to finish.
		return { migrated: false, movedEntries: [], targetDir };
	}
	if (fs.existsSync(targetDir) && !resuming) {
		// A completed new-layout dir (no marker) next to a legacy one: genuine
		// conflict, never a mid-migration state. Refuse rather than guess.
		throw new Error(
			`Both the legacy default-profile layout (${legacyAgentDir}) and the new one (${targetDir}) exist. ` +
				`Veyyon cannot guess which is current. Merge or remove one — typically: move the contents of ` +
				`${legacyAgentDir} (and sibling state dirs like logs/, plugins/, cache/) into ${targetDir}, ` +
				`then delete the legacy copies — and relaunch.`,
		);
	}
	// Claim the migration by planting the marker BEFORE any move, so an
	// interruption at any point leaves a resumable state, never a silent orphan.
	fs.mkdirSync(targetDir, { recursive: true });
	fs.writeFileSync(markerPath, "");
	const movedEntries: string[] = [];
	for (const entry of fs.readdirSync(root)) {
		if (GLOBAL_ROOT_ENTRIES.has(entry)) continue;
		fs.renameSync(path.join(root, entry), path.join(targetDir, entry));
		movedEntries.push(entry);
	}
	// All entries landed — drop the marker so the migration reads as complete.
	fs.rmSync(markerPath, { force: true });
	movedEntries.sort((a, b) => a.localeCompare(b));
	return { migrated: true, movedEntries, targetDir };
}
/** Get the agent config directory (~/.veyyon/agent). */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.veyyon). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Config-root subdirectories (~/.veyyon/*)
// =============================================================================

/** Get the reports directory (~/.veyyon/reports). */
export function getReportsDir(): string {
	return dirs.rootSubdir("reports", "state");
}

/** Get the logs directory (~/.veyyon/profiles/<name>/logs). */
export function getLogsDir(): string {
	return dirs.rootSubdir("logs", "state");
}

/** Get the path to a dated log file (~/.veyyon/profiles/<name>/logs/veyyon.YYYY-MM-DD.log). */
export function getLogPath(date = new Date()): string {
	return path.join(getLogsDir(), `${APP_NAME}.${date.toISOString().slice(0, 10)}.log`);
}

/**
 * Get the plugins directory for the active profile
 * (`~/.veyyon/profiles/<name>/plugins`, or its XDG equivalent).
 *
 * No-arg form (production callers) goes through the XDG-aware DirResolver so
 * reads and writes always agree. The optional `home` parameter is for test
 * isolation: when it differs from `os.homedir()` it short-circuits the resolver
 * and returns `<home>/<configDir>/profiles/<profile>/plugins`. Passing
 * `os.homedir()` explicitly is identical to the no-arg form — XDG semantics are
 * preserved.
 */
export function getPluginsDir(home?: string): string {
	if (home !== undefined && home !== RESOLVER_HOME) {
		return path.join(home, getConfigDirName(), PROFILES_DIR_NAME, getActiveProfileOrDefault(), "plugins");
	}
	return dirs.rootSubdir("plugins", "data");
}

/** Where npm installs packages (profile plugins dir / node_modules). */
export function getPluginsNodeModules(home?: string): string {
	return path.join(getPluginsDir(home), "node_modules");
}

/** Plugin package.json under the profile plugins dir. */
export function getPluginsPackageJson(home?: string): string {
	return path.join(getPluginsDir(home), "package.json");
}

/** Plugin lock file under the profile plugins dir. */
export function getPluginsLockfile(home?: string): string {
	return path.join(getPluginsDir(home), "veyyon-plugins.lock.json");
}

/** Get the remote mount directory (~/.veyyon/profiles/<name>/remote). */
export function getRemoteDir(): string {
	return dirs.rootSubdir("remote", "data");
}

/**
 * Expand a leading `~` and require an absolute result. Returns `undefined` for
 * empty/whitespace input or a path that is still relative after expansion.
 *
 * A worktree base is process-global and consumed by both creation
 * (PR checkout, task isolation) and cleanup (`veyyon worktree`). A relative value
 * would resolve against whatever cwd happened to launch `veyyon`, so checkout and
 * cleanup could disagree — we refuse it rather than silently bind it to cwd.
 */
function resolveWorktreeBase(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	let p = trimmed;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/") || p.startsWith("~\\")) p = os.homedir() + p.slice(1);
	return path.isAbsolute(p) ? path.normalize(p) : undefined;
}

let worktreesDirOverride: string | undefined;

/**
 * Relocate the base directory for agent-managed worktrees (PR checkouts, task
 * isolation, and `veyyon worktree` cleanup all read the same base). Driven by the
 * `worktree.base` setting in coding-agent; pass `undefined`/empty to clear and
 * fall back to `VEYYON_WORKTREE_DIR` or the profile `wt/` default.
 *
 * `~` is expanded and a relative path is rejected (see {@link resolveWorktreeBase}).
 * Returns the absolute path that took effect, or `undefined` if the input was
 * cleared or rejected — callers can warn on a non-empty input that returns
 * `undefined`.
 */
export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

/**
 * Get the agent-managed worktrees directory. Resolution order: the
 * `VEYYON_WORKTREE_DIR` env var, then the {@link setWorktreesDir} override (the
 * `worktree.base` setting), then the profile `wt/` default. The env var and the
 * override are both `~`-expanded and must be absolute; a relative value is
 * ignored and resolution falls through.
 */
export function getWorktreesDir(): string {
	return (
		resolveWorktreeBase(pickProcessEnv("VEYYON_WORKTREE_DIR")) ??
		worktreesDirOverride ??
		dirs.rootSubdir("wt", "data")
	);
}

/** Get the SSH control socket directory (~/.veyyon/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (profile `remote-host/`). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.veyyon/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (~/.veyyon/agent/python-gateway; XDG default: $XDG_STATE_HOME/veyyon/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (~/.veyyon/puppeteer). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get DOCS_RS cache directory () */
export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

/**Get AutoQa db directory */
export function getAutoQaDbDir(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}
/**
 * Stable 7-character hex digest of an absolute filesystem path.
 *
 * Used to pack the project identity into a single short fs-safe segment
 * (e.g. PR-checkout and task-isolation worktree dirs under profile `wt/`).
 * Bun.hash is non-cryptographic — collision space is ~2^28, which is fine
 * for naming a handful of repos on a single machine. Same input on the
 * same Bun runtime yields the same output.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (profile `wt/<segment>`). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (~/.veyyon/gpu_cache.json). */
export function getGpuCachePath(): string {
	return dirs.rootSubdir("gpu_cache.json", "cache");
}

/**
 * Get the GitHub view cache database path (profile `cache/github-cache.db`).
 * Honors the `VEYYON_GITHUB_CACHE_DB` env var when set so tests can isolate the
 * cache file without touching the rest of the config root.
 */
export function getGithubCacheDbPath(): string {
	const override = pickProcessEnv("VEYYON_GITHUB_CACHE_DB");
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "github-cache.db"), "cache");
}

/**
 * Get the encrypted auth-broker snapshot cache path (profile `cache/auth-broker-snapshot.enc`).
 * Honors the `VEYYON_AUTH_BROKER_SNAPSHOT_CACHE` env var when set so tests and
 * operators can isolate or relocate the cache file.
 */
export function getAuthBrokerSnapshotCachePath(): string {
	const override = pickProcessEnv("VEYYON_AUTH_BROKER_SNAPSHOT_CACHE");
	if (override) return override;
	return dirs.rootSubdir(path.join("cache", "auth-broker-snapshot.enc"), "cache");
}

/** Get the local FastEmbed model cache directory (profile `cache/fastembed`). */
export function getFastembedCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed"), "cache");
}

/** Get the on-demand fastembed runtime install root (profile `cache/fastembed-runtime`). */
export function getFastembedRuntimeDir(): string {
	return dirs.rootSubdir(path.join("cache", "fastembed-runtime"), "cache");
}

/** Get the natives directory (~/.veyyon/natives). */
export function getNativesDir(): string {
	return dirs.rootSubdir("natives", "cache");
}

/**
 * Get the argot shorthand cache directory (profile `cache/argot`). Each project
 * keeps its generated `AGENTS.dict` in a per-id subdirectory here; the cache is
 * a local decode aid that never enters the repository, so it lives under the
 * config root, not the working tree.
 */
export function getArgotCacheDir(): string {
	return dirs.rootSubdir(path.join("cache", "argot"), "cache");
}

/** Get the stats database path (~/.veyyon/stats.db). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory (~/.veyyon/autoresearch). */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory (~/.veyyon/autoresearch/<encoded-project>). */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch SQLite database path (~/.veyyon/autoresearch/<encoded-project>.db). */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

/** Get the per-run artifact directory (~/.veyyon/autoresearch/<encoded-project>/runs/<runId>). */
export function getAutoresearchRunDir(encodedProject: string, runId: number): string {
	return path.join(getAutoresearchProjectDir(encodedProject), "runs", String(runId).padStart(4, "0"));
}

// =============================================================================
// Agent subdirectories (~/.veyyon/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/** Get the last-seen-changelog-version marker file (~/.veyyon/agent/last-changelog-version). */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/**
 * Get the automatic-update state file (~/.veyyon/agent/auto-update-state.json).
 *
 * Holds the record of the last failed background update so a launch that cannot
 * install does not retry and re-report the same failure every time you start.
 * It doubles as the lock target that keeps concurrent launches from installing
 * at once.
 */
export function getAutoUpdateStatePath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "auto-update-state.json", "state");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the tiny title model cache directory (~/.veyyon/agent/cache/tiny-models). */
export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

/** Get the document conversion cache directory (~/.veyyon/agent/cache/document-conversions; XDG default: $XDG_CACHE_HOME/veyyon/cache/document-conversions). */
export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}

/** Get the sessions directory (~/.veyyon/agent/sessions). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory (~/.veyyon/agent/blobs). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory (~/.veyyon/agent/themes). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (~/.veyyon/agent/tools). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the slash commands directory (~/.veyyon/agent/commands). */
export function getCommandsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "commands");
}

/** Get the prompts directory (~/.veyyon/agent/prompts). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (~/.veyyon/agent/modules). */
export function getAgentModulesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "modules");
}

/** Get the memories directory (~/.veyyon/agent/memories). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (~/.veyyon/agent/terminal-sessions). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the crash log path (~/.veyyon/agent/veyyon-crash.log). */
export function getCrashLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "veyyon-crash.log", "state");
}

/** Get the debug log path (~/.veyyon/agent/veyyon-debug.log). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Project subdirectories (.veyyon/*)
// =============================================================================

/** Get the project-level Python modules directory (.veyyon/modules). */
export function getProjectModulesDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "modules");
}

/** Get the project-level prompts directory (.veyyon/prompts). */
export function getProjectPromptsDir(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "prompts");
}

/** Get the project-level plugin overrides path (.veyyon/plugin-overrides.json). */
export function getProjectPluginOverridesPath(cwd: string = getProjectDir()): string {
	return path.join(getProjectAgentDir(cwd), "plugin-overrides.json");
}

// =============================================================================
// MCP config paths
// =============================================================================

/** Get the primary MCP config file path (first candidate). */
export function getMCPConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "mcp.json");
	}
	return path.join(getProjectAgentDir(cwd), "mcp.json");
}

/** Get the SSH config file path. */
export function getSSHConfigPath(scope: "user" | "project", cwd: string = getProjectDir()): string {
	if (scope === "user") {
		return path.join(getAgentDir(), "ssh.json");
	}
	return path.join(getProjectAgentDir(cwd), "ssh.json");
}

// =============================================================================
// Install identity
// =============================================================================

let cachedInstallId: string | null = null;

/**
 * Persistent per-install UUID stored at `~/.veyyon/install-id`.
 *
 * Generated lazily on first call and persisted with `O_CREAT|O_EXCL` so
 * concurrent first-call races don't clobber each other (loser re-reads the
 * winner's id). Survives independently of agent state: deleting
 * `~/.veyyon/agent/` does not regenerate it. Server-side dedup for grievance
 * pushes (and similar telemetry) keys on this id.
 *
 * Anchored to the base config root (`~/.veyyon/install-id`) regardless of the
 * active profile: install identity is per-install, not per-profile, so every
 * profile shares one id and the global cache stays correct no matter the
 * profile / `getInstallId` call order.
 */
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
		// File present but unparseable — fall through and overwrite below.
		observedInvalid = existing.length > 0;
	} catch {}

	const next = crypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// If we already saw garbage in the file, unlink first so O_EXCL doesn't
		// trip on it. Ignored if the unlink races against another writer.
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
		// Lost the create race — re-read whatever the winner wrote.
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (isUuid(existing)) {
					cachedInstallId = existing;
					return existing;
				}
			} catch {}
		}
		// Any other failure: keep the generated id in-memory so the rest of
		// this process has a stable value; future processes will retry.
	}

	cachedInstallId = next;
	return next;
}

/** Test-only: clear cached install id. Never call from production code. */
export function __resetInstallIdCacheForTests(): void {
	cachedInstallId = null;
}
