/**
 * Centralized path helpers for veyyon config directories.
 * Resolves config roots, profile directories, and XDG directory redirections.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { engines, version } from "../package.json" with { type: "json" };
import { APP_DIRECTORY_SLUG } from "./app-identity";
// FIRST, for its side effect: the environment scrub and `$HOME/.env`. Every path this module caches at
// load is decided by `VEYYON_CODING_AGENT_DIR` and the `XDG_*` variables, so a user who sets one of those
// in `$HOME/.env` has to be heard before the first `DirResolver` is built. `./dotenv-home` imports nothing
// that can reach this file, which is why the `.env` layers needing a resolved directory stay in `./env`.
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

/** App name (e.g. "veyyon") */
/**
 * The lowercase slug used in filesystem paths.
 * Read from `app-identity.ts` which also owns `APP_DISPLAY_NAME`.
 * Two names shared across packages caused slug-in-title or name-in-path mistakes.
 */
export const APP_NAME: string = APP_DIRECTORY_SLUG;

/**
 * Launch alias installed next to binary (`vey`). Read by installers and shell completion.
 */
export const APP_ALIAS: string = "vey";

/** Canonical marketing/docs site. Single owner — import, never re-hardcode. */
export const SITE_URL: string = "https://veyyon.dev";

/** Public changelog/releases page. Where `/changelog` and the update notice point. */
export const CHANGELOG_URL: string = "https://veyyon.dev/changelog";

/**
 * Changelog page URL scrolled to one version's anchor (e.g. `#v1-2-3`).
 * Normalizes dots to dashes matching the generator format.
 */
export function changelogUrlForVersion(version: string): string {
	const bare = bareVersion(version);
	return `${CHANGELOG_URL}#v${bare.replace(/\./g, "-")}`;
}

/** Config directory name (e.g. ".veyyon") */
export const CONFIG_DIR_NAME: string = ".veyyon";

/** Ordered main settings filenames: canonical write target first, legacy-compatible YAML fallback second. */
export const MAIN_CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/**
 * Bounded retry for a PRESENT-but-momentarily-unreadable global config (EMFILE /
 * EBUSY / transient IO), so a rebuild's fd pressure cannot flip the credential
 * posture. Small and fixed: this runs on the startup path, and the failure it
 * covers clears in milliseconds or not at all.
 */
const GLOBAL_CONFIG_READ_RETRY_ATTEMPTS = 3;
const GLOBAL_CONFIG_READ_RETRY_DELAY_MS = 5;

/** Basename of the per-install UUID file at the config root (see {@link getInstallId}). */
const INSTALL_ID_FILE = "install-id";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Matches Windows reserved device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9)
 * and their extensions to prevent invalid directory creation.
 */
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Normalize and validate a profile name. Returns `undefined` for default profile
 * and throws for invalid syntax or Windows-reserved names.
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

// The list has one owner, `./dir-env-keys`, because `./dotenv-home` needs it too and cannot import this
// module (this module imports IT). Re-exported here because callers have always taken it from `dirs`.
export { DIR_OVERRIDE_ENV_KEYS } from "./dir-env-keys";

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
 * Module-load profile resolution. Returns `undefined` on invalid input or corrupt config
 * rather than throwing, avoiding import crashes before CLI error handling initializes.
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

/**
 * Check whether an `XDG_*_HOME` value is an absolute path.
 * Relative paths are rejected with a warning to avoid CWD-dependent directory resolution.
 */
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

/**
 * Resolves user home directory or throws with actionable guidance if empty or `/`.
 * Prevents writing config relative to CWD or into filesystem root.
 */
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

/**
 * Base config root before profile resolution, honoring `VEYYON_CONFIG_DIR`.
 */
function getBaseConfigRoot(): string {
	return getConfigRootOverride() ?? path.join(resolveHomeDirOrThrow(), CONFIG_DIR_NAME);
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
 * Profile-specific config root under `profiles/<name>`.
 * The bare config root is reserved for global cross-profile state.
 */
function getProfileConfigRoot(profile: string | undefined): string {
	return path.join(getBaseConfigRoot(), PROFILES_DIR_NAME, profile ?? DEFAULT_PROFILE_DIR_NAME);
}

/**
 * Read `defaultProfile` from the global config file (`~/.veyyon/config.yml`).
 * Returns `undefined` when absent; throws on unreadable YAML or invalid names.
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
 * Outcome of reading a candidate config file, distinguishing absent files
 * from present-but-empty files that contain no YAML mapping.
 */
type MainConfigCandidate =
	/** Nothing at this path. The ONLY state that means "no config here". */
	| { kind: "absent" }
	/** Present, valid YAML, and a mapping: the one usable shape. */
	| { kind: "map"; record: Record<string, unknown>; text: string }
	/** Present and valid YAML but not a mapping: zero bytes, a scalar, a sequence. */
	| { kind: "not-a-map" };

/** How to name a config file in an error the user has to act on. */
interface ConfigFileKind {
	/** Opens the message: "Global config /home/u/.veyyon/config.yml could not be read...". */
	subject: string;
	/** What the user can safely do about a broken file, appended after the cause. */
	repairHint: string;
}

const GLOBAL_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Global config",
	repairHint: "Fix or remove the file (it holds only cross-profile keys like defaultProfile).",
};

/** The retired per-profile config, read only by {@link readLegacyProfileSetupVersion}. */
const PROFILE_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Profile config",
	repairHint: "Fix or remove the file.",
};

/**
 * Read a candidate config file's text, returning `undefined` only for missing paths.
 * Retries on transient IO errors and aborts on read errors to prevent config truncation.
 */
function readConfigFileText(filePath: string, fileKind: ConfigFileKind): string | undefined {
	for (let attempt = 0; ; attempt++) {
		try {
			return fs.readFileSync(filePath, "utf8");
		} catch (error) {
			if (isMissingPath(error)) return undefined;
			// Present but momentarily unreadable, which is transient by nature: retry
			// briefly so only a persistent failure surfaces, and never as a silent
			// posture flip.
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

/** Classify one candidate path. Throws only for a file that is present and whose YAML does not parse. */
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

/** The candidate chosen out of {@link MAIN_CONFIG_FILENAMES} for one directory, and what it holds. */
interface MainConfigSelection {
	/** The file every reader and the writer use for this root. */
	filePath: string;
	candidate: MainConfigCandidate;
}

/**
 * Select the winning config file in a directory using {@link MAIN_CONFIG_FILENAMES} precedence.
 * A file with a valid YAML mapping beats an earlier empty candidate.
 */
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

/** The GLOBAL config as a parsed record, the file it came from, and whether that file is present but unusable. */
interface GlobalConfigRead {
	/** The parsed mapping, or `{}` when no file exists or the one that does holds no mapping. */
	record: Record<string, unknown>;
	/**
	 * The file the record came from, or the canonical path when none exists. Lets
	 * each caller name the offending file in its own value-validation errors.
	 */
	filePath: string;
	/**
	 * True when a file exists but contains no YAML mapping (e.g. zero-byte file).
	 */
	presentButUnusable: boolean;
}

/**
 * Read the whole GLOBAL config file. One reader for every global key so callers
 * do not each re-implement the filename precedence. Throws on unreadable or
 * unparseable YAML, naming the file.
 */
function readGlobalConfigRecord(): GlobalConfigRead {
	const { filePath, candidate } = selectMainConfigFile(getBaseConfigRoot(), GLOBAL_CONFIG_FILE_KIND);
	return {
		record: candidate.kind === "map" ? candidate.record : {},
		filePath,
		presentButUnusable: candidate.kind === "not-a-map",
	};
}

/**
 * Global config file path for reads and writes. Selects the first usable YAML mapping,
 * existing candidate, or default `config.yml`. Never throws.
 */
export function getGlobalConfigFilePath(): string {
	const root = getBaseConfigRoot();
	try {
		return selectMainConfigFile(root, GLOBAL_CONFIG_FILE_KIND).filePath;
	} catch {
		// A candidate that cannot even be classified (unreadable, unparseable) is
		// exactly the file the caller wants to talk about, and it is reached before any
		// later name, so the canonical path is the right thing to name.
		return path.join(root, MAIN_CONFIG_FILENAMES[0]);
	}
}

/** A config file that exists but is ignored because a higher-precedence one does too. */
export interface ShadowedConfigFile {
	/** The file that is being ignored. */
	ignored: string;
	/** The file being used instead. */
	using: string;
}

/**
 * Find config files in `root` that exist but are shadowed by higher-precedence files.
 * Used to report ignored configuration files to the user.
 */
export function findShadowedGlobalConfigFiles(root: string = getBaseConfigRoot()): ShadowedConfigFile[] {
	// existsSync, not the classifier, decides PRESENCE: a directory named
	// `config.yml` is not readable as a file yet really does sit where a config
	// would, and the user still needs to be told it is not being read.
	const present = MAIN_CONFIG_FILENAMES.filter(filename => fs.existsSync(path.join(root, filename)));
	const usable = present.find(filename => {
		try {
			return classifyConfigCandidate(path.join(root, filename), GLOBAL_CONFIG_FILE_KIND).kind === "map";
		} catch {
			// Unreadable or unparseable is exactly "not usable", and this function only
			// ever feeds a warning: throwing here would turn a diagnostic about a dead
			// file into a crash.
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

/**
 * Atomic read-modify-write of a single global config key under file lock.
 * `mutate` returns the new value or `undefined` to delete the key.
 */
function mutateGlobalConfigKey(key: string, mutate: (current: Record<string, unknown>) => unknown): string {
	const root = getBaseConfigRoot();
	fs.mkdirSync(root, { recursive: true });
	// The canonical config path is the stable lock target regardless of which
	// filename actually exists on disk, so every writer serializes on one lock.
	const canonicalPath = path.join(root, MAIN_CONFIG_FILENAMES[0]);
	return withFileLockSync(canonicalPath, () => {
		// The same selection the readers use, so a write can never land in a file
		// the next read ignores. It throws for a present-but-unreadable candidate,
		// which is the point: aborting leaves the user's other global keys intact,
		// where swallowing the error rewrote the file with only `key` in it.
		const { filePath, candidate } = selectMainConfigFile(root, {
			subject: GLOBAL_CONFIG_FILE_KIND.subject,
			repairHint: `Fix or remove the file before changing ${key}.`,
		});
		const existing = candidate.kind === "map" ? candidate.record : {};
		// The file's own bytes, so the write can EDIT it rather than re-serialize it: this
		// is a file people hand-edit, and a re-serialization discards their comments,
		// blank lines and key order (see syncYamlTextToSettings). A candidate that is not
		// a mapping has no keys, comments or order to keep, and splicing a key into a
		// scalar document would not even be valid YAML, so it is rewritten from empty.
		const existingText = candidate.kind === "map" ? candidate.text : "";
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
		atomicWriteFileSync(filePath, syncYamlTextToSettings(existingText, existing));
		return filePath;
	});
}

/**
 * Auth-broker config key path (`auth.broker`). Always persisted nested;
 * readers accept legacy flat keys.
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
 * Whether provider credentials are shared across profiles (defaults to true).
 * Reads `profileSharing` from global config.
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
 * Global config key for onboarding version. Stored globally so onboarding
 * state is machine-wide rather than per-profile.
 */
export const ONBOARDING_VERSION_CONFIG_KEY = "onboardingVersion";

/** The machine-wide onboarding generation, and whether it could be read at all. */
export interface GlobalOnboardingVersion {
	/** The stored generation, or `undefined` when the key is absent. */
	version: number | undefined;
	/**
	 * True when the global config is present but could not be read or parsed, so
	 * `version` is absent because of that failure rather than because the machine
	 * is new. A caller deciding whether to onboard MUST NOT read this case as a
	 * first install: that is how a corrupt config re-ran the setup wizard.
	 */
	unreadable: boolean;
}

/**
 * Resolved completed onboarding generation from global config.
 * Returns `undefined` if absent; throws on invalid or unreadable YAML.
 */
export function resolveGlobalOnboardingVersion(): number | undefined {
	const { record, filePath, presentButUnusable } = readGlobalConfigRecord();
	if (presentButUnusable) {
		// The one reader that must NOT fold this into its default. A config file that
		// exists but holds no mapping (zero bytes is the common one) carries no
		// onboarding record, and reading that as "never onboarded" is precisely how a
		// machine set up years ago got marched through the setup wizard again. The
		// sibling readers keep their default here because sharing credentials or using
		// the default profile is safe either way; re-onboarding is not.
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

/**
 * Safe reader for global onboarding version that reports why the value is missing
 * without throwing, distinguishing absent from unreadable config.
 */
export function readGlobalOnboardingVersionSafe(): GlobalOnboardingVersion {
	try {
		return { version: resolveGlobalOnboardingVersion(), unreadable: false };
	} catch {
		return { version: undefined, unreadable: true };
	}
}

/**
 * Record completed onboarding generation in global config under file lock.
 */
export function writeGlobalOnboardingVersion(version: number | undefined): string {
	return mutateGlobalConfigKey(ONBOARDING_VERSION_CONFIG_KEY, () => version);
}

/**
 * The RETIRED per-profile onboarding key. Never written any more; read only so a
 * machine onboarded before the key moved to the global config is still recognised.
 */
const LEGACY_PROFILE_SETUP_VERSION_KEY = "setupVersion";

/** The highest retired per-profile `setupVersion` on this machine, and whether any profile hid one. */
export interface LegacyProfileSetupVersion {
	/** The maximum recorded generation across every profile, or `undefined` when none records one. */
	version: number | undefined;
	/**
	 * A profile config exists but could not be read, parsed, or understood, so
	 * `version` may be too low or missing entirely. A caller deciding whether to
	 * onboard MUST treat this as "cannot tell", never as "never onboarded".
	 */
	unreadable: boolean;
}

/**
 * Highest retired `setupVersion` across all profile configs under `profiles/`.
 * Read machine-wide during migration to prevent re-prompting onboarded users.
 */
export function readLegacyProfileSetupVersion(): LegacyProfileSetupVersion {
	const profilesRoot = path.join(getBaseConfigRoot(), PROFILES_DIR_NAME);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
	} catch (error) {
		// No `profiles/` at all is a genuinely fresh install and contributes nothing.
		// Any other failure HID profiles that may well record a version, so it must
		// not read as "never onboarded".
		return { version: undefined, unreadable: !isMissingPath(error) };
	}
	let version: number | undefined;
	let unreadable = false;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		let candidate: MainConfigCandidate;
		try {
			// Same filename precedence and same read-with-retry as the global config,
			// so a profile's `config.yml`/`config.yaml` cannot be resolved two ways.
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

/**
 * Directory for machine-wide shared credential store (`~/.veyyon/shared-auth`).
 * Used when {@link resolveGlobalProfileSharing} is enabled.
 */
export function getSharedAuthDir(): string {
	return path.join(getBaseConfigRoot(), "shared-auth");
}

/** Module-load-safe variant of {@link resolveGlobalDefaultProfile}: a broken global config must not crash a bare import; the CLI re-validates loudly. */
export function readGlobalDefaultProfileSafe(): string | undefined {
	try {
		return resolveGlobalDefaultProfile();
	} catch {
		// Undefined means "no global default", so the caller uses the built-in default profile. Quiet on
		// purpose and only here: this runs at module load, where there is no logger to report to yet, and
		// the CLI re-reads the same config through the validating path that DOES report it.
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
 * Update the project directory and process working directory synchronously.
 * Changes process CWD first to guarantee the directory is accessible.
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

/**
 * Check if a path string appears absolute on POSIX or Windows.
 */
function looksAbsolute(value: string): boolean {
	return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** True when `candidate` is `root` or sits underneath it. */
function isUnderPath(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Resolved config root override from `VEYYON_CONFIG_DIR`, or `undefined` if unset.
 * Rejects paths inside the real user home unless running in test sandbox.
 */
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
	// A value written for the OTHER platform is still refused, and this is the one refusal
	// that survived the inversion above. `C:\veyyon` is not absolute to POSIX `path`, so it
	// would be resolved as a relative name and create a directory whose name contains a
	// backslash -- a thing no listing shows sensibly and no user asked for. There is no
	// reading of it that is worth guessing at.
	if (!path.isAbsolute(override) && looksAbsolute(override)) {
		throw new Error(
			`${key} is set to "${override}", which is written as an absolute path for another platform and cannot ` +
				`be one here, so it would be resolved as a relative name and create a directory whose name contains ` +
				`a path separator. Set it to an absolute path in this platform's form, such as "/srv/veyyon".`,
		);
	}
	const home = resolveHomeDirOrThrow();
	// One `resolve`, because it already does both jobs: an absolute `override` replaces
	// `home` outright, and a relative one is resolved against it.
	const resolved = path.resolve(home, override);
	if (isUnderPath(resolved, home) && !process.env[SANDBOX_MARKER_ENV_KEY]) {
		throw new Error(
			`${key} resolves to "${resolved}", which is inside your home directory ("${home}").\n` +
				`It is a PATH to the config root, not a name hung off your home, and a value that lands back in your ` +
				`home is how 136 stray ${CONFIG_DIR_NAME}* directories were created in one: a bare name such as ` +
				`"${CONFIG_DIR_NAME}-mysuite" reads like isolation and is a directory in the real home.\n` +
				`Set it to an absolute path OUTSIDE your home (for example "/srv/veyyon", or a temp directory), or ` +
				`unset it to use the default (${path.join(home, CONFIG_DIR_NAME)}).`,
		);
	}
	return resolved;
}

/**
 * Config root expressed relative to home for path reconstruction with `path.join`.
 * Uses `path.relative` to preserve directory targets outside home.
 */
export function getConfigDirName(): string {
	const override = getConfigRootOverride();
	return override === undefined ? CONFIG_DIR_NAME : path.relative(resolveHomeDirOrThrow(), override);
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
				if (!isUsableXdgBase(envVar, value)) return undefined;
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
		// XDG flattens the profile+agent prefix: ~/.veyyon/profiles/default/agent/sessions → $XDG_DATA_HOME/veyyon/sessions
		this.#agentDirs = {
			data: xdgData ?? this.agentDir,
			state: xdgState ?? this.agentDir,
			cache: xdgCache ?? this.agentDir,
		};
	}

	/**
	 * Cache key for a resolved subdirectory combining name and XDG category.
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
 * Resolve baseline `VEYYON_CODING_AGENT_DIR` for default-profile mode,
 * ignoring values inherited from a named profile.
 */
function resolvePreProfileAgentDir(profile: string | undefined, agentDirEnv: string | undefined): string | undefined {
	return isProfileDerivedAgentDir(profile, agentDirEnv) ? undefined : agentDirEnv;
}

let activeProfile = resolveStartupProfileSafe();

/**
 * Resolve active agent-dir override for the current profile from environment.
 * Named profiles derive their own path; default profile honors override.
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
 * Snapshot of `VEYYON_CODING_AGENT_DIR` before profile activation,
 * restored when switching back to the default profile.
 */
let preProfileAgentDirEnv: string | undefined = resolvePreProfileAgentDir(activeProfile, readAgentDirEnv());
// Anchor home for the resolver. Captured at module load to stay stable across
// test mocks of `os.homedir()`. `getPluginsDir(home)` compares against this so
// production callers (`home === RESOLVER_HOME`) hit the XDG-aware resolver while
// tests passing a temp HOME short-circuit to a deterministic path.
const RESOLVER_HOME = os.homedir();

/**
 * Rebuild directory resolver from environment after loading `.env` files.
 * Re-reads directory override variables while preserving profile selection.
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

/**
 * Snapshot of process-global directory overrides and active profile state,
 * used by tests to cleanly restore environment state.
 */
export interface DirOverridesSnapshot {
	agentDirEnv: string | undefined;
	profileEnv: string | undefined;
	profile: string | undefined;
	/**
	 * Baseline agent-dir override captured before named-profile activation.
	 */
	preProfileAgentDir: string | undefined;
}

/**
 * Capture current directory override environment variables and active profile.
 */
export function captureDirOverrides(): DirOverridesSnapshot {
	return {
		agentDirEnv: process.env[AGENT_DIR_ENV_KEYS[0]],
		profileEnv: process.env.VEYYON_PROFILE,
		profile: activeProfile,
		preProfileAgentDir: preProfileAgentDirEnv,
	};
}

/**
 * Restore directory overrides and active profile from a snapshot,
 * rebuilding the resolver state.
 */
export function restoreDirOverrides(snapshot: DirOverridesSnapshot): void {
	writeSnapshotEnv(snapshot);
	// The reset's `__resetProfileSnapshotForTests` re-derives the pre-profile baseline from
	// the environment written on the line above, which is why the profile switch below can
	// safely build the resolver from that baseline: by then it is the snapshot's value and
	// not whatever the test being undone left behind. Moving the env write after the reset
	// would break that and resolve every path under the undone test's directory, with the
	// environment and the module state both reading back correct.
	__resetDirsFromEnvForTests();
	// The environment does not always pin the profile: an active profile that was
	// selected in-process (no `VEYYON_PROFILE`) is only in module state, so it is
	// re-applied explicitly rather than inferred.
	if (activeProfile !== snapshot.profile) setProfile(snapshot.profile);
	// `setProfile` EXPORTS the profile's agent dir (so child processes inherit it), which
	// is right in production and wrong here: it would leave a variable behind that the
	// snapshot says was absent. The profile outranks the variable anyway, so re-pinning
	// the environment after the switch restores the variables without moving any path.
	writeSnapshotEnv(snapshot);
	// Re-assigned because `setProfile`'s first activation overwrites the baseline from the
	// live environment.
	preProfileAgentDirEnv = snapshot.preProfileAgentDir;
	// LAST, and deliberately unconditional: which of the steps above last touched `dirs`
	// depends on whether the profile switch ran, and that depends on the machine's global
	// `defaultProfile`. One rebuild from the now fully-restored inputs makes the resolver
	// match the snapshot by construction instead of by every branch happening to leave it
	// right, which is the difference between a bug here and a bug in whichever suite runs
	// next.
	refreshDirsFromEnv();
}

/** Test-only: read the pre-profile agent-dir baseline, so a leak tracer can watch it. */
export function __preProfileAgentDirForTests(): string | undefined {
	return preProfileAgentDirEnv;
}

function writeSnapshotEnv(snapshot: DirOverridesSnapshot): void {
	if (snapshot.agentDirEnv === undefined) delete process.env[AGENT_DIR_ENV_KEYS[0]];
	else process.env[AGENT_DIR_ENV_KEYS[0]] = snapshot.agentDirEnv;
	if (snapshot.profileEnv === undefined) delete process.env.VEYYON_PROFILE;
	else process.env.VEYYON_PROFILE = snapshot.profileEnv;
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
 * Test-only: reset the pre-profile agent directory snapshot.
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
 * Guard for recursive profile removal. Throws if target is not a direct child
 * of profiles directory (`profiles/<name>` or staging `profiles/.<name>.<pid>.tmp`).
 * Returns resolved absolute path.
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
 * Find existing legacy per-profile `shared-auth` directories to seed
 * the global shared credential store during migration.
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
 * Migrate legacy root profile layout (`~/.veyyon/agent`) to `profiles/default/`.
 * Resumes interrupted migrations and fails closed on conflicting directories.
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
/** Get the active profile's agent config directory (~/.veyyon/profiles/<name>/agent). */
export function getAgentDir(): string {
	return dirs.agentDir;
}

/** Get the project-local config directory (.veyyon). */
export function getProjectAgentDir(cwd: string = getProjectDir()): string {
	return path.join(cwd, CONFIG_DIR_NAME);
}

// =============================================================================
// Profile-root subdirectories (~/.veyyon/profiles/<name>/*)
// =============================================================================

/** Get the reports directory (~/.veyyon/profiles/<name>/reports). */
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
 * Get the plugins directory for the active profile (`profiles/<name>/plugins`).
 * Optional `home` parameter overrides home directory for test isolation.
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
 * Expand leading `~` and validate that result is an absolute path.
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
 * Override the base directory for agent worktrees (`worktree.base` setting).
 * Expands `~` and rejects relative paths.
 */
export function setWorktreesDir(dir: string | undefined): string | undefined {
	worktreesDirOverride = resolveWorktreeBase(dir);
	return worktreesDirOverride;
}

/**
 * Get worktrees directory from `VEYYON_WORKTREE_DIR`, override, or profile default (`wt/`).
 */
export function getWorktreesDir(): string {
	return (
		resolveWorktreeBase(pickProcessEnv("VEYYON_WORKTREE_DIR")) ??
		worktreesDirOverride ??
		dirs.rootSubdir("wt", "data")
	);
}

/** Get the SSH control socket directory (~/.veyyon/profiles/<name>/ssh-control). */
export function getSshControlDir(): string {
	return dirs.rootSubdir("ssh-control", "state");
}

/** Get the remote host info directory (profile `remote-host/`). */
export function getRemoteHostDir(): string {
	return dirs.rootSubdir("remote-host", "data");
}

/** Get the managed Python venv directory (~/.veyyon/profiles/<name>/python-env). */
export function getPythonEnvDir(): string {
	return dirs.rootSubdir("python-env", "data");
}

/** Get the shared Python gateway state directory (profile `agent/python-gateway`; XDG default: $XDG_STATE_HOME/veyyon/python-gateway). */
export function getPythonGatewayDir(): string {
	return dirs.agentSubdir(undefined, "python-gateway", "state");
}

/** Get the puppeteer sandbox directory (profile `puppeteer/`). */
export function getPuppeteerDir(): string {
	return dirs.rootSubdir("puppeteer", "cache");
}

/** Get the docs.rs web cache directory (profile `webcache/`). */
export function getDocsRsCacheDir(): string {
	return dirs.rootSubdir("webcache", "cache");
}

/** Get the AutoQA database directory (profile `autoqa.db`). */
export function getAutoQaDbDir(): string {
	return dirs.rootSubdir("autoqa.db", "data");
}
/**
 * Stable 7-character hex digest of an absolute path for directory naming.
 */
export function hashPath(absPath: string): string {
	return Bun.hash(path.resolve(absPath)).toString(16).padStart(16, "0").slice(-7);
}

/** Get the path to a single worktree directory (profile `wt/<segment>`). */
export function getWorktreeDir(segment: string): string {
	return path.join(getWorktreesDir(), segment);
}

/** Get the GPU cache path (profile `gpu_cache.json`). */
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

/** Get the natives directory (profile `natives/`). */
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

/** Get the stats database path (profile `stats.db`). */
export function getStatsDbPath(): string {
	return dirs.rootSubdir("stats.db", "data");
}

/** Get the autoresearch state directory (profile `autoresearch/`). */
export function getAutoresearchDir(): string {
	return dirs.rootSubdir("autoresearch", "state");
}

/** Get the per-project autoresearch state directory (profile `autoresearch/<encoded-project>`). */
export function getAutoresearchProjectDir(encodedProject: string): string {
	return path.join(getAutoresearchDir(), encodedProject);
}

/** Get the per-project autoresearch SQLite database path (profile `autoresearch/<encoded-project>.db`). */
export function getAutoresearchDbPath(encodedProject: string): string {
	return path.join(getAutoresearchDir(), `${encodedProject}.db`);
}

// =============================================================================
// Agent subdirectories (~/.veyyon/profiles/<name>/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/**
 * Agent directory for credentials when profile sharing is enabled,
 * or `undefined` when each profile uses its own store.
 */
export function getSharedAuthStoreDirIfEnabled(): string | undefined {
	return readGlobalProfileSharingSafe() ? getSharedAuthDir() : undefined;
}

/**
 * Path to active `agent.db` holding credentials for current profile,
 * resolving to shared store if profile sharing is enabled.
 */
export function getActiveAuthDbPath(agentDir?: string): string {
	return getAgentDbPath(getSharedAuthStoreDirIfEnabled() ?? agentDir ?? getAgentDir());
}

/** Get the last-seen-changelog-version marker file (agent `last-changelog-version`). */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/**
 * Path to automatic-update state file (`auto-update-state.json`).
 */
export function getAutoUpdateStatePath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "auto-update-state.json", "state");
}

/**
 * Path to update history file (`update-history.json`) for rollback tracking.
 */
export function getUpdateHistoryPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "update-history.json", "state");
}

/** Get the path to history.db (SQLite database for session history). */
export function getHistoryDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "history.db", "data");
}

/** Get the path to models.db (model cache database). */
export function getModelDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "models.db", "data");
}

/** Get the tiny title model cache directory (agent `cache/tiny-models`). */
export function getTinyModelsCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "tiny-models"), "cache");
}

/** Get the document conversion cache directory (agent `cache/document-conversions`; XDG default: $XDG_CACHE_HOME/veyyon/cache/document-conversions). */
export function getDocumentConversionCacheDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, path.join("cache", "document-conversions"), "cache");
}

/** Get the sessions directory (agent `sessions/`). */
export function getSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "sessions", "data");
}

/** Get the content-addressed blob store directory (agent `blobs/`). */
export function getBlobsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "blobs", "data");
}

/** Get the custom themes directory (agent `themes/`). */
export function getCustomThemesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "themes");
}

/** Get the tools directory (agent `tools/`). */
export function getToolsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "tools");
}

/** Get the prompts directory (agent `prompts/`). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the memories directory (agent `memories/`). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (agent `terminal-sessions/`). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the debug log path (agent `veyyon-debug.log`). */
export function getDebugLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, `${APP_NAME}-debug.log`, "state");
}

// =============================================================================
// Project subdirectories (.veyyon/*)
// =============================================================================

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

/**
 * Primary MCP config file path for the specified or active profile.
 */
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

/**
 * Path to profile-specific SSH host configuration (`ssh.json`).
 */
export function getSSHConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "ssh.json");
}

// =============================================================================
// Install identity
// =============================================================================

let cachedInstallId: string | null = null;

/**
 * Persistent per-install UUID (`~/.veyyon/install-id`), created atomically on first access.
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
		// File present and not an id — fall through and overwrite below. This is set for an
		// EMPTY file too, which is what a crash between the create and the write leaves
		// behind. It used to be `existing.length > 0`, so a zero-length file was never
		// unlinked, the `O_EXCL` create below then failed with EEXIST forever, and the
		// install generated a brand new id on every single launch with nothing to fix.
		observedInvalid = true;
		if (existing.length > 0) {
			// Replacing this file changes the install's identity, which is what server-side
			// dedup keys on: the same machine starts counting as a new one. Doing that in
			// silence leaves nobody able to explain the discontinuity later.
			process.emitWarning(
				`${filePath} does not contain a UUID (${existing.length} bytes), so it is being replaced with a new ` +
					`install id. Anything that identified this install by the old value will see it as a new install.`,
				{ code: "VEYYON_INSTALL_ID_INVALID" },
			);
		}
	} catch (err) {
		// A missing file is the first run and says nothing. Anything else means the id IS
		// on disk and unreadable, so a fresh one is generated below and the write almost
		// certainly fails the same way, leaving a per-process identity (see the tail of
		// this function). Announce the cause here while the errno is still in hand.
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
		// If we already saw garbage in the file, unlink first so O_EXCL doesn't
		// trip on it. Ignored if the unlink races against another writer.
		if (observedInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {
				// Losing this race is fine and expected: another process replaced the same
				// garbage, and the O_EXCL open below then fails with EEXIST and re-reads its
				// id. The unlink failing for any other reason surfaces as the persist warning
				// at the end of this function, which is where it matters.
			}
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
			} catch {
				// The winner's file cannot be read back. Falls through to the warning below,
				// which is the right report: this process ends up with an id of its own.
			}
		}
		// Keep the generated id in-memory so the rest of this process has a stable value.
		// It is stable for THIS process only: nothing was persisted, so the next launch
		// generates another one, and every run of veyyon on this machine looks like a
		// different install. Server-side dedup keyed on the id then never dedups anything.
		// That is a permanent, invisible degradation, so it is announced (Law 10).
		process.emitWarning(
			`Could not persist an install id to ${filePath} (${errorMessage(err)}). This run is using a temporary id, and ` +
				`every future run will generate another one until the path is writable.`,
			{ code: "VEYYON_INSTALL_ID_NOT_PERSISTED" },
		);
	}

	cachedInstallId = next;
	return next;
}

/** Test-only: clear cached install id. Never call from production code. */
export function __resetInstallIdCacheForTests(): void {
	cachedInstallId = null;
}
