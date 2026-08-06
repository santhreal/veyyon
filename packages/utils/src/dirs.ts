/**
 * Centralized path helpers for veyyon config directories.
 *
 * Uses VEYYON_CONFIG_DIR (default ".veyyon") for the config root and
 * VEYYON_CODING_AGENT_DIR to override the agent directory. That override applies
 * in default-profile mode only: a named profile derives its own
 * `~/.veyyon/profiles/<name>/agent` and ignores the variable.
 *
 * On Linux and macOS, when XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME are
 * set AND the corresponding `$XDG_*_HOME/veyyon` directory already exists, paths
 * are redirected there. The existence check is the migration signal: setting the
 * variable alone changes nothing until `veyyon config init-xdg` has created and
 * populated that directory. Named profiles key the same check on the
 * profile-specific path, so a profile's location is fixed at first activation.
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
 *
 * Read from `app-identity.ts`, which also owns the capitalized `APP_DISPLAY_NAME` a person reads. The two used
 * to share this name across packages, and a slug in a notification title or a capitalized name in a path is
 * the kind of mistake nothing reports.
 */
export const APP_NAME: string = APP_DIRECTORY_SLUG;

/**
 * The short launch alias installed next to the binary. Both installers create it
 * (`ALIAS_NAME` in scripts/install.sh and scripts/install.ps1) and the shell
 * completion generator registers completions under it, so every consumer must
 * read this constant rather than re-hardcoding the string.
 * `scripts/installer-alias-parity.test.ts` fails if the shell scripts drift.
 */
export const APP_ALIAS: string = "vey";

/** Canonical marketing/docs site. Single owner — import, never re-hardcode. */
export const SITE_URL: string = "https://veyyon.dev";

/** Public changelog/releases page. Where `/changelog` and the update notice point. */
export const CHANGELOG_URL: string = "https://veyyon.dev/changelog";

/**
 * The changelog page, scrolled to one version's entry.
 *
 * Three surfaces want to link a specific version: the post-update hint ("here is
 * what changed"), the rollback picker (per row, "what am I giving up"), and any
 * release tooling that names a version. They must agree, so the anchor format
 * lives here rather than being rebuilt at each call site.
 *
 * The format is the one `website/tools/gen-changelog.mjs` emits: it writes
 * `<h2 id="v1-2-3">` for version `1.2.3`, replacing every dot with a dash
 * because a dot in a fragment id is legal but awkward to select in CSS. A
 * leading `v` in the argument is tolerated, since callers hold versions both
 * ways (`ReleaseInfo.tag` is `v1.2.3`, `ReleaseInfo.version` is `1.2.3`), and
 * silently producing `#vv1-2-3` would land the reader at the top of the page
 * with no indication that the link missed.
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

/**
 * Whether an `XDG_*_HOME` value may be used as a base directory.
 *
 * The XDG base-directory spec is explicit that these variables must hold
 * ABSOLUTE paths and that a relative one is invalid and must be ignored. That
 * matters here beyond spec compliance: a relative value would be joined and then
 * `existsSync`-tested against the CURRENT WORKING DIRECTORY, so the same session
 * would resolve its cache, state, and data roots differently after any `cd`, and
 * veyyon would scatter directories through whatever tree the user happened to be
 * standing in.
 *
 * Ignoring is the spec's remedy, but ignoring in silence is not: the user set the
 * variable and would otherwise get the default root with no indication their
 * configuration was discarded. So the value is dropped AND announced. This uses
 * `process.emitWarning` rather than the logger for the reason given elsewhere in
 * this file: the logger imports this module for its own paths, so importing it
 * back would close a cycle in the module that resolves every path.
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
 * The user's home directory, refused rather than guessed when it is unusable.
 *
 * Every path veyyon owns hangs off this one value, so a bad answer here is not a
 * bad path, it is every path. Two answers are bad in ways that do not announce
 * themselves:
 *
 *  - EMPTY (`HOME=` with no usable passwd entry, common in a stripped container
 *    or a `env -i` invocation). `path.join("", ".veyyon")` is `.veyyon`, a
 *    RELATIVE path, so config, sessions, and credentials would be created in
 *    whatever directory the process happened to start in, and a second run from
 *    a different directory would silently see a different, empty veyyon.
 *  - the filesystem ROOT (`HOME=/`). Every write then lands in `/.veyyon`,
 *    outside the user's control and usually not writable, and on the occasions
 *    it IS writable (a root shell) it litters the root of the filesystem.
 *
 * Both are configuration faults with a one-line fix, so this throws and names
 * the fix rather than proceeding somewhere arbitrary.
 *
 * Exported so the refusal can be tested directly: `os.homedir()` is resolved
 * once per process, so a test cannot reach the empty case by assigning `HOME`.
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
 * The config root, before the profile segment.
 *
 * `CONFIG_DIR_NAME` rather than `getConfigDirName()` on the default branch, deliberately:
 * the name is only ever a name in the default case, and asking the override for its
 * basename here would let a `/srv/veyyon-work` override answer `~/veyyon-work`, which is
 * the doubled-path defect the override exists to remove.
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
 * How one candidate config file turned out.
 *
 * These three states must stay distinct because two of them used to collapse
 * into one. `readGlobalConfigRecord` returned `{}` both for "no file exists" and
 * for "a file exists but holds no YAML mapping", so a ZERO-BYTE `config.yml` was
 * indistinguishable from a fresh install: the onboarding gate read "no
 * onboardingVersion", concluded nobody had ever run setup, and walked a
 * long-onboarded user back through the wizard. That empty file is not exotic
 * either. {@link mutateGlobalConfigKey} writes one DELIBERATELY when it cannot
 * unlink a config it has just emptied, so this is a state the code reaches by
 * itself and not something the user broke.
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
 * Read one candidate's bytes, or `undefined` when the path is not there.
 *
 * ONE owner for the absent-versus-unreadable split and its bounded retry,
 * because the reader and the writer each had their own answer and the writer's
 * was destructive. `mutateGlobalConfigKey` did `catch { continue; }`, so a single
 * non-absence error (EMFILE under fd pressure while several rebuilt processes
 * start at once, EACCES, EIO, an NFS blip) made a populated config look empty and
 * the read-modify-write then emitted a file holding ONLY the key being mutated:
 * `defaultProfile`, `profileSharing`, `onboardingVersion` and the auth-broker
 * token all gone, with no error anywhere. A present-but-unreadable file has to
 * ABORT the mutation; it must never shrink it.
 *
 * ENOENT is the obvious absence and ENOTDIR is the same fact reached differently,
 * so absence is {@link isMissingPath} rather than a local ENOENT check that could
 * drift from the rest of the tree. Every other code means the file IS there:
 * treating those as "no config" is what would silently default `profileSharing`
 * and relocate the credential store to the empty shared dir, logging a
 * `profileSharing:false` user out this run and back in the next.
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
 * Apply {@link MAIN_CONFIG_FILENAMES} precedence to one directory.
 *
 * The first name still wins OUTRIGHT when it is usable and the files are never
 * merged, because merging two files that disagree makes the effective config
 * depend on a rule nobody can see. What changed is what "usable" means. A
 * candidate that exists but holds no YAML mapping carries no keys at all, so
 * letting it win bought nothing and cost everything: an empty `config.yml` buried
 * a fully populated `config.yaml` permanently, with no error, no effect, and no
 * way for the user to see why the file they edited was dead. So a usable map now
 * beats a present-but-unusable earlier name, and the loser is still reported by
 * {@link findShadowedGlobalConfigFiles} so the shadowing never goes silent.
 *
 * When NOTHING parses to a map, the first PRESENT candidate is selected and
 * carries `not-a-map`. That is what keeps "present but unusable" tellable from
 * "absent" one level up, and it is also the file the writer has to rewrite.
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
	 * A file exists at `filePath` but holds no YAML mapping, so `record` is empty
	 * because of THAT rather than because the machine is new. Readers whose default
	 * is safe either way (`defaultProfile`, `profileSharing`) deliberately ignore
	 * this and keep their default; the onboarding reader must not, because there
	 * "absent" means run the setup wizard.
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
 * The GLOBAL config file that reads and writes actually use: the first name in
 * {@link MAIN_CONFIG_FILENAMES} that parses to a YAML mapping, else the first one
 * that merely exists, else the canonical `config.yml` that a first write creates.
 *
 * Never throws. Its whole job is to let a user-facing message name the file, and
 * a notification that a save FAILED must not itself fail because the file it
 * wants to name is the unreadable one.
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
 * Config files in `root` that exist but are ignored because another name in
 * {@link MAIN_CONFIG_FILENAMES} is the one being read.
 *
 * The precedence itself is deliberate and must not change: one file wins outright
 * and the others are NOT merged, because merging two files that disagree would
 * make the effective config depend on a rule nobody can see. But leaving the
 * loser silent is its own trap. Someone who edits `config.yaml` while `config.yml`
 * exists gets no error, no effect and no clue: their file is simply dead, and
 * every symptom points at the setting they changed rather than at the file they
 * changed it in.
 *
 * The winner reported here is the one {@link selectMainConfigFile} picks, not
 * blindly the first present name. Comparing against the first name would name the
 * wrong file in exactly the case that hurts most: an empty `config.yml` beside a
 * populated `config.yaml` would send the user to edit the empty file, which is no
 * longer the file being read.
 *
 * This returns the finding instead of logging it because `dirs` sits below the
 * logger (logger imports this module for its own paths). The settings layer, which
 * has both a logger and a user-visible surface, reports it. Precedence still has
 * exactly one owner: the constant and this function live here.
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
 * The onboarding-generation key in the GLOBAL config.
 *
 * Onboarding is something a HUMAN does once per machine, so its marker belongs
 * beside `defaultProfile` rather than inside one profile's settings file. Held
 * per profile it made `--profile <name>` look like a brand-new install: the new
 * profile's `agent/config.yml` has no onboarding key, the gate read the schema
 * default, and a user who had onboarded years ago was walked through the setup
 * wizard again. One owner for the literal so the reader, the writer, and the
 * settings-domain binding agree.
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
 * The onboarding generation this machine has completed, from the GLOBAL config.
 * `undefined` means the key is absent (never onboarded). Throws on unreadable
 * YAML, on a config file that exists but holds no mapping, or on a non-numeric
 * value, naming the file, matching {@link resolveGlobalDefaultProfile}'s
 * strictness so a typo cannot silently decide whether a user is onboarded.
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
 * Never-throwing variant of {@link resolveGlobalOnboardingVersion} that reports
 * WHY the value is missing.
 *
 * The distinction is the whole point: the sibling `*Safe` readers can fold a
 * failure into their default because sharing credentials or using the default
 * profile is a safe posture either way. Onboarding is not symmetric. "Absent"
 * means run the wizard and "unreadable" means do not, so a reader that returned
 * one number for both would re-onboard every launch a config file was corrupt.
 */
export function readGlobalOnboardingVersionSafe(): GlobalOnboardingVersion {
	try {
		return { version: resolveGlobalOnboardingVersion(), unreadable: false };
	} catch {
		return { version: undefined, unreadable: true };
	}
}

/**
 * Record the onboarding generation in the GLOBAL config, preserving every other
 * key; `undefined` clears it. Returns the file written. Synchronous and atomic
 * under the shared lock, so the fact that a user completed onboarding is on disk
 * before the call returns rather than waiting on a debounced save that a closed
 * terminal would discard.
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
 * The highest retired `setupVersion` recorded by ANY profile under `profiles/`.
 *
 * Onboarding is something a human does once per MACHINE, so evidence that it
 * happened has to be read machine-wide. The promotion that fills in the global
 * `onboardingVersion` used to fall back to the retired key through the settings
 * layer, which resolves the ACTIVE profile only. On the reporting user's disk the
 * record lived in `profiles/work/agent/config.yml` while `profiles/oss-work` had
 * no config file at all, so launching `--profile oss-work` first looked in one
 * profile, found nothing, and declared a fresh install on a machine that had been
 * onboarded for years: the full four-step wizard, from the top.
 *
 * Absence contributes nothing, because a profile that never stored the key is the
 * normal case. Anything else that stops a profile from answering sets `unreadable`
 * instead of vanishing: a file that will not read or parse, a file that holds no
 * mapping, and a `setupVersion` that is present but not a finite number. All three
 * mean the profile has something to say about onboarding that could not be
 * understood, and silently skipping them is the same "declare a fresh install"
 * bug one level down.
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

/**
 * A `VEYYON_CONFIG_DIR` value written as an absolute path, on either platform.
 *
 * `path.isAbsolute` only knows the platform it runs on, and a value written for the
 * other one means the same thing: `C:\veyyon` on Linux is not "absolute" to `path`, so
 * resolving it against the home would produce a directory whose NAME contains a
 * backslash. Both forms are recognised so the value is read as the path its author
 * meant wherever it was written.
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
 * The config root named by `VEYYON_CONFIG_DIR`, or `undefined` when it is unset.
 *
 * ## The bug this is the fix for
 *
 * This used to be `getConfigDirName()`, which returned a NAME that every caller
 * `path.join`ed onto `os.homedir()`. A location that can only ever land inside the home
 * is not a location, it is a rename, and both halves of that produced damage:
 *
 *  - A BARE NAME created a real directory in the operator's real home. Assigning
 *    `process.env.HOME` does not move `os.homedir()` under Bun -- it is resolved once at
 *    process start -- so a suite setting `VEYYON_CONFIG_DIR=".veyyon-mysuite"` believing
 *    it had isolated itself was writing to `~/.veyyon-mysuite`. 136 of those accumulated
 *    in one real home before anyone counted them. The mechanism read as isolation and
 *    was its opposite.
 *  - An ABSOLUTE PATH was REFUSED, so the one spelling that could NOT land in the home
 *    was the one spelling forbidden, and the sanctioned escape was
 *    `path.relative(os.homedir(), tempRoot)`: a run of `..` segments whose correctness
 *    depends on a home the reader cannot see from the call site.
 *
 * So the rule is inverted. The value is a PATH -- absolute taken as written, relative
 * resolved against the home, which keeps the `..` form above working -- and then checked
 * against the one thing it must never be: somewhere inside the operator's home. The
 * default root `~/.veyyon` is unaffected: that is what you get when the variable is
 * unset, and this function is not consulted.
 *
 * ## Why the sandbox marker grants it
 *
 * Inside the test sandbox the home IS disposable: a tmpfs the guest owns, with the
 * operator's real home absent from the filesystem view entirely. Refusing there would
 * break every suite that legitimately puts its config root under its own temp home while
 * protecting nothing. {@link SANDBOX_MARKER_ENV_KEY} is trusted in this one direction
 * only, and it is the weaker half of the pair: the strong half is the reachability proof
 * in `packages/utils/test/helpers/sandbox-gate.ts`, which has already refused to let the
 * process start if a real home was in reach.
 *
 * ## What breaks if this regresses
 *
 * Reverting to a joined name makes `~/.veyyon-<anything>` reachable from one environment
 * variable again, which is how the 136 directories were created.
 * `packages/utils/test/sandbox-gate-contracts.test.ts` fails when it does.
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
 * The config root expressed RELATIVE TO THE HOME, for the callers that hold a home and
 * join a name onto it -- {@link getConfigAgentDirName} below, and through it
 * `USER_CONFIG_BASES` in `packages/coding-agent/src/config.ts`.
 *
 * `path.relative`, not `path.basename`, and the difference is a wrong answer rather than
 * an ugly one. Every caller does `path.join(home, thisValue)`, so the value has to be the
 * one that reconstructs the root: a basename turns an override of `../shared` into
 * `~/shared` and `/srv/veyyon-work` into `~/veyyon-work`, which is the doubled-path defect
 * the override exists to remove, reintroduced one layer up. The `..`-relative form is not
 * pretty, but `path.join(home, "../../srv/veyyon")` is `/srv/veyyon`, which is the root the
 * user asked for.
 *
 * Derived from the resolved root rather than the raw environment value, so it cannot answer
 * anything {@link getConfigRootOverride} refuses: one validator, consulted by both.
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

/**
 * The process-global dir overrides: `VEYYON_CODING_AGENT_DIR`, `VEYYON_PROFILE`, and the
 * in-memory active profile. Captured together so they can be put back exactly.
 *
 * Neither {@link setAgentDir} nor {@link setProfile} is its own inverse, which is why
 * this exists rather than a "call it again with the old value" idiom:
 *
 * - `setAgentDir` always WRITES the environment variable, so it cannot express "the
 *   variable was absent", and it CLEARS the active profile, so a suite that ran under
 *   `work` hands the next file the default profile.
 * - `setProfile` always WRITES `VEYYON_PROFILE`, so restoring a profile through it
 *   leaves that variable exported even when it started out absent — which then wins for
 *   every child process the next suite spawns.
 *
 * Suites that restored either way leaked the developer's real agent dir, or an
 * unexpected profile, into every file that ran after them; `scripts/test-sandbox/find-test-leaks.ts`
 * found roughly thirty of them.
 */
export interface DirOverridesSnapshot {
	agentDirEnv: string | undefined;
	profileEnv: string | undefined;
	profile: string | undefined;
	/**
	 * The pre-profile agent-dir baseline (see the field's own docs). It is module state
	 * that `setAgentDir` OVERWRITES, and it cannot always be re-derived from the
	 * environment: a process started with `VEYYON_CODING_AGENT_DIR=/custom` whose suite
	 * then activated a profile leaves the environment pointing at the profile's dir, so a
	 * re-derivation from that environment discards `/custom` and the next
	 * `setProfile(undefined)` anywhere in the process resolves to the wrong place.
	 */
	preProfileAgentDir: string | undefined;
}

/**
 * Capture the dir overrides so {@link restoreDirOverrides} can undo a `setAgentDir` or
 * `setProfile` call completely.
 *
 * For suites outside `packages/coding-agent`. Inside it, prefer
 * `beginSettingsTest()` / `restoreSettingsTestState()`, which capture this along
 * with the Settings singleton, the keybindings singleton, the project dir and the
 * whole environment.
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
 * Put the environment and the active profile back, then rebuild the resolver from
 * them.
 *
 * The profile is recovered with `__resetDirsFromEnvForTests`, not
 * `refreshDirsFromEnv`: the latter rebuilds paths AROUND the current in-memory
 * profile, so a profile `setAgentDir` cleared would stay cleared and every later
 * path would resolve under `profiles/default/` with the environment looking
 * correct. `refreshDirsFromEnv` is then called LAST, once every input is back, so
 * the resolver reflects the snapshot rather than the intermediate states the
 * recovery passes through.
 *
 * Every step is a pure function of `snapshot`. That is the property to preserve:
 * a restore that reads live module state can hand back a resolver the snapshot
 * never described, and the resulting failure lands in whichever suite runs next.
 * `dir-overrides-restore-is-pure.test.ts` pins it across both branches, with the
 * global `defaultProfile` set and unset, since which branch runs depends on it.
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

/** Get the per-run artifact directory (profile `autoresearch/<encoded-project>/runs/<runId>`). */
export function getAutoresearchRunDir(encodedProject: string, runId: number): string {
	return path.join(getAutoresearchProjectDir(encodedProject), "runs", String(runId).padStart(4, "0"));
}

// =============================================================================
// Agent subdirectories (~/.veyyon/profiles/<name>/agent/*)
// =============================================================================

/** Get the path to agent.db (SQLite database for settings and auth storage). */
export function getAgentDbPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "agent.db", "data");
}

/**
 * The credential-store agent directory when profile-sharing redirects it to the
 * machine-wide shared store, or `undefined` when each profile keeps its own
 * store (sharing off).
 *
 * This is the ONE owner of the "sharing on → shared store" decision. Both the
 * store opener (`discoverAuthStorage`, which passes this as `storeAgentDir`) and
 * every "where do my logins live" message ({@link getActiveAuthDbPath}) resolve
 * through it, so they can never point at different files. Before this existed,
 * the store opened the shared `~/.veyyon/shared-auth/agent.db` while the login
 * messages printed the per-profile `agent.db` computed straight from
 * `getAgentDbPath()` — a sibling that is empty under sharing — so a user with
 * working, shared credentials was told they lived in an empty file and it read
 * as corruption.
 */
export function getSharedAuthStoreDirIfEnabled(): string | undefined {
	return readGlobalProfileSharingSafe() ? getSharedAuthDir() : undefined;
}

/**
 * The `agent.db` that actually holds credentials for the current profile right
 * now: the machine-wide shared store when profile-sharing is on (the default),
 * otherwise this profile's own store. Use this for any user-facing "credentials
 * saved to …" message so it always names the exact file the store opens, never a
 * sibling that may be empty.
 */
export function getActiveAuthDbPath(agentDir?: string): string {
	return getAgentDbPath(getSharedAuthStoreDirIfEnabled() ?? agentDir ?? getAgentDir());
}

/** Get the last-seen-changelog-version marker file (agent `last-changelog-version`). */
export function getLastChangelogVersionPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "last-changelog-version", "state");
}

/**
 * Get the automatic-update state file (agent `auto-update-state.json`).
 *
 * Holds the record of the last failed background update so a launch that cannot
 * install does not retry and re-report the same failure every time you start.
 * It doubles as the lock target that keeps concurrent launches from installing
 * at once.
 */
export function getAutoUpdateStatePath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "auto-update-state.json", "state");
}

/**
 * Get the version-move history file (agent `update-history.json`).
 *
 * Records each deliberate move between versions (from, to, when) so the rollback
 * picker can annotate a row with "you were here before" and so a support
 * question about "it worked last week" has an answer on disk.
 *
 * It is ANNOTATION ONLY and is never the source of the version list: that comes
 * from the release source every time. A history file is trivially incomplete —
 * it knows nothing about installs that happened through the shell installer, a
 * package manager, or another machine — so treating it as the catalog would
 * quietly hide most versions from the picker.
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

/** Get the slash commands directory (agent `commands/`). */
export function getCommandsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "commands");
}

/** Get the prompts directory (agent `prompts/`). */
export function getPromptsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "prompts");
}

/** Get the user-level Python modules directory (agent `modules/`). */
export function getAgentModulesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "modules");
}

/** Get the memories directory (agent `memories/`). */
export function getMemoriesDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "memories", "state");
}

/** Get the terminal sessions directory (agent `terminal-sessions/`). */
export function getTerminalSessionsDir(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "terminal-sessions", "state");
}

/** Get the crash log path (agent `veyyon-crash.log`). */
export function getCrashLogPath(agentDir?: string): string {
	return dirs.agentSubdir(agentDir, "veyyon-crash.log", "state");
}

/** Get the debug log path (agent `veyyon-debug.log`). */
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

/**
 * Get the primary MCP config file path (first candidate).
 *
 * `agentDir` names WHICH profile owns the user-scope file. It defaults to the
 * process-active profile, so every existing caller is unchanged; a caller
 * loading on behalf of another profile passes that profile's agent dir so the
 * server list and the disable/force-enable lists come out of the same file.
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
 * Path to the SSH host config for one profile.
 *
 * There is no project scope. A repository is untrusted input, so a checked-in
 * `ssh.json` must never name a machine the ssh tool will connect to, and a
 * writer that offered a project scope would be writing a file nothing reads.
 *
 * `agentDir` names WHICH profile, defaulting to the process-active one. It used
 * to be absent, so this always resolved the booted profile and a caller loading
 * for another profile silently got the wrong host list.
 */
export function getSSHConfigPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, "ssh.json");
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
