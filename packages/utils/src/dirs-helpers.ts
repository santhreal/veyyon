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
import { AGENT_DIR_ENV_KEYS, PROFILE_ENV_KEYS } from "./dir-env-keys";
/** App name (e.g. "veyyon") */
/**
 * The lowercase slug used in filesystem paths.
 *
 * Read from `app-identity.ts`, which also owns the capitalized `APP_DISPLAY_NAME` a person reads. The two used
 * to share this name across packages, and a slug in a notification title or a capitalized name in a path is
 * the kind of mistake nothing reports.
 */
import {
	findShadowedGlobalConfigFiles,
	getConfigRootOverride,
	getInstallId,
	migrateLegacyDefaultProfileLayout,
	mutateGlobalConfigKey,
	profileEnvIsSet,
	readGlobalConfigRecord,
	readGlobalDefaultProfileSafe,
	readLegacyProfileSetupVersion,
	resolveStartupProfile,
} from "./dirs";
import { isMissingPath } from "./fs-error";
import { bareVersion } from "./semver";
import { sleepSync } from "./sleep";
import { errorMessage, isRecord } from "./type-guards";

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
export const GLOBAL_CONFIG_READ_RETRY_ATTEMPTS = 3;
export const GLOBAL_CONFIG_READ_RETRY_DELAY_MS = 5;

/** Basename of the per-install UUID file at the config root (see {@link getInstallId}). */
export const INSTALL_ID_FILE = "install-id";

/** Version (e.g. "1.0.0") */
export const VERSION: string = version;

/** Minimum Bun version */
export const MIN_BUN_VERSION: string = engines.bun.replace(/[^0-9.]/g, "");

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Names Windows treats as reserved device aliases. Matches the basename
 * itself as well as any `BASENAME.<anything>` form, because Windows reserves
 * `CON.foo`/`PRN.txt`/etc. too — using them as a profile name would let
 * `setProfile` accept the input only for directory creation to fail later
 * with a confusing `ENOENT`/`EINVAL`. Case-insensitive: NTFS treats `CON`
 * and `con` identically.
 */
export const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

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

export function pickProcessEnv(...keys: readonly string[]): string | undefined {
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
export function readAgentDirEnv(): string | undefined {
	return pickProcessEnv(...AGENT_DIR_ENV_KEYS);
}

/**
 * One owner for writing the agent-dir override so child processes reading the
 * key see the same value; `undefined` clears it.
 */
export function writeAgentDirEnv(dir: string | undefined): void {
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
export function resolveStartupProfileSafe(): string | undefined {
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
export function isUsableXdgBase(envVar: string, value: string): boolean {
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
export function getBaseConfigRoot(): string {
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
export function getProfileConfigRoot(profile: string | undefined): string {
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
export type MainConfigCandidate =
	/** Nothing at this path. The ONLY state that means "no config here". */
	| { kind: "absent" }
	/** Present, valid YAML, and a mapping: the one usable shape. */
	| { kind: "map"; record: Record<string, unknown>; text: string }
	/** Present and valid YAML but not a mapping: zero bytes, a scalar, a sequence. */
	| { kind: "not-a-map" };

/** How to name a config file in an error the user has to act on. */
export interface ConfigFileKind {
	/** Opens the message: "Global config /home/u/.veyyon/config.yml could not be read...". */
	subject: string;
	/** What the user can safely do about a broken file, appended after the cause. */
	repairHint: string;
}

export const GLOBAL_CONFIG_FILE_KIND: ConfigFileKind = {
	subject: "Global config",
	repairHint: "Fix or remove the file (it holds only cross-profile keys like defaultProfile).",
};

/** The retired per-profile config, read only by {@link readLegacyProfileSetupVersion}. */
export const PROFILE_CONFIG_FILE_KIND: ConfigFileKind = {
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
export function classifyConfigCandidate(filePath: string, fileKind: ConfigFileKind): MainConfigCandidate {
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
export interface MainConfigSelection {
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
export function selectMainConfigFile(root: string, fileKind: ConfigFileKind): MainConfigSelection {
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
export interface GlobalConfigRead {
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
