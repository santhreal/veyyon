/**
 * Settings singleton with sync get/set and background persistence.
 *
 * Usage:
 *   import { settings } from "./settings";
 *
 *   const enabled = settings.get("compaction.enabled");  // sync read
 *   settings.set("theme.dark", "titanium");               // sync write, saves in background
 *
 * For tests:
 *   const isolated = Settings.isolated({ "compaction.enabled": false });
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { configureProviderMaxInFlightRequests } from "@veyyon/ai/stream";
import {
	atomicWriteFile,
	errorMessage,
	expandTilde,
	findShadowedGlobalConfigFiles,
	getAgentDbPath,
	getAgentDir,
	getLastChangelogVersionPath,
	getProjectDir,
	isEnoent,
	isRecord,
	logger,
	MAIN_CONFIG_FILENAMES,
	procmgr,
	type QuarantinedFile,
	quarantineUnparseableFile,
	setWorktreesDir,
	syncYamlTextToSettings,
	withFileLock,
} from "@veyyon/utils";
import { JSONC, YAML } from "bun";
import { type Settings as SettingsCapabilityItem, settingsCapability } from "../capability/settings";
import type { ModelRole } from "../config/model-roles";
import { loadCapability } from "../discovery";
import { isLightTheme, setAutoThemeMapping, setColorBlindMode, setSymbolPreset } from "../modes/theme/theme";
import { AgentStorage } from "../session/agent-storage";
import { normalizeToolName } from "../tools/builtin-names";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { type CompactionStrategySetting, migrateCompactionStrategyValue } from "./compaction-strategy";
import { GLOBAL_SETTING_BINDINGS } from "./settings-domains/global";
import {
	type BashInterceptorRule,
	describeSettingTypeMismatch,
	type GroupPrefix,
	type GroupTypeMap,
	getDefault,
	isUnsetNumberPath,
	SETTINGS_SCHEMA,
	type SettingPath,
	type SettingValue,
} from "./settings-schema";

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object as stored in YAML */
export interface RawSettings {
	[key: string]: unknown;
}

/**
 * A settings file that failed to parse, and where its bytes were preserved.
 *
 * An alias for the shared shape rather than a second declaration of it, so the
 * settings layer and the keybindings layer describe the same thing one way.
 */
export type QuarantinedSettingsFile = QuarantinedFile;

/** A config file this session repeatedly could not write, and why. */
export interface SettingsSaveFailure {
	path: string;
	reason: string;
	attempts: number;
}

/**
 * How many consecutive failed saves of the same file it takes to tell the user.
 *
 * Saves are debounced and retried, and one failure under a concurrent writer is normal.
 * Three in a row is not a race: it is a path that cannot be written.
 */
const SAVE_FAILURE_REPORT_AFTER = 3;

/** A configured setting whose value does not match the type the schema declares. */
export interface InvalidSettingValue {
	/** Dotted setting path, e.g. `startup.autoUpdate`. */
	path: SettingPath;
	/** The file the bad value came from, so the user knows which line to edit. */
	file: string;
	/** Human-readable explanation naming the expected type and what was found. */
	reason: string;
}

export interface SettingsOptions {
	/** Current working directory for project settings discovery */
	cwd?: string;
	/** Agent directory for config.yml/config.yaml storage */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Read config sources without opening storage or writing migrations */
	readOnly?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
	/** Extra config.yml-style overlays loaded after global/project settings */
	configFiles?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a nested value from an object by path segments.
 */
function getByPath(obj: RawSettings, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

const SETTING_PATH_SEGMENTS: Record<SettingPath, readonly string[]> = Object.fromEntries(
	(Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(settingPath => [settingPath, settingPath.split(".")]),
) as unknown as Record<SettingPath, readonly string[]>;

/**
 * The value optional numeric settings used to store to mean "unset", and the
 * paths that stored it. Unset is an absent key now (see {@link Settings.unset});
 * this pair exists only so the load migration can drop the old sentinel, and the
 * path list is derived from the schema so a new optional numeric setting is
 * covered without being registered anywhere else.
 */
const LEGACY_UNSET_SENTINEL = -1;

/**
 * Migration numbers stamped into the global config as `settingsMigrationVersion`.
 * One per migration that may run only once; bump {@link SETTINGS_MIGRATION_VERSION}
 * and add a named constant when another needs the same treatment.
 */
export const SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY = 1;
export const SETTINGS_MIGRATION_VERSION = SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY;

/**
 * The migrations that may run only ONCE, applied to the global config in place
 * and recorded with a stamp.
 *
 * Every other migration here is idempotent and runs on every read of every
 * source. This one is not: it deletes the `-1` that used to mean "unset", and
 * `-1` is now a value a user can mean (a legal presence penalty). Without the
 * stamp the next load would delete it again — which is precisely what happened
 * in dogfooding, one minute after the change landed, on a value set through the
 * shipped CLI.
 *
 * Exported so its contract can be driven directly: the stamp, the fixed point,
 * and the values it must not touch.
 */
function appliedMigrationVersion(raw: RawSettings): number {
	return typeof raw.settingsMigrationVersion === "number" ? raw.settingsMigrationVersion : 0;
}

/**
 * Drop the `-1` that used to mean "unset" from the owned config, in memory.
 *
 * Safe to run on every load and does nothing once the stamp says the migration
 * has been applied. Returns the paths it removed.
 */
export function stripLegacyUnsetSentinels(raw: RawSettings): string[] {
	if (appliedMigrationVersion(raw) >= SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY) return [];
	const removed: string[] = [];
	for (const segments of LEGACY_UNSET_SENTINEL_PATHS) {
		if (getByPath(raw, segments) !== LEGACY_UNSET_SENTINEL) continue;
		deleteByPath(raw, segments);
		removed.push(segments.join("."));
	}
	return removed;
}

/**
 * Commit the one-shot migrations to the owned config: strip the old sentinels and
 * record that it happened. Returns every path that changed, for the caller to mark
 * modified so the save path actually writes them.
 *
 * Called when a value on one of those paths is written, NOT on every load, for two
 * reasons that pull in opposite directions:
 *
 *  - The stamp must be on disk before a `-1` can be trusted, or the next load
 *    deletes a value the user just set (dogfooded, 2026-07-25).
 *  - Stamping at load time would add a line to every config in existence,
 *    including ones that have never touched a sampling knob.
 *
 * Writing one of these paths is exactly the moment both concerns are satisfied:
 * the file is being rewritten anyway, and the stamp is what makes the new value
 * survivable. Anything still holding a legacy `-1` is stripped in the same write,
 * so the stamp can never certify a config the migration has not finished.
 */
export function stampOwnedConfigMigrations(raw: RawSettings): string[] {
	const changed = stripLegacyUnsetSentinels(raw);
	if (appliedMigrationVersion(raw) !== SETTINGS_MIGRATION_VERSION) {
		raw.settingsMigrationVersion = SETTINGS_MIGRATION_VERSION;
		changed.push("settingsMigrationVersion");
	}
	return changed;
}
const LEGACY_UNSET_SENTINEL_PATHS: readonly (readonly string[])[] = (Object.keys(SETTINGS_SCHEMA) as SettingPath[])
	.filter(settingPath => isUnsetNumberPath(settingPath))
	.map(settingPath => settingPath.split("."));

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (!(segment in current) || typeof current[segment] !== "object" || current[segment] === null) {
			current[segment] = {};
		}
		current = current[segment] as RawSettings;
	}
	current[segments[segments.length - 1]] = value;
}

/**
 * Delete a nested value by path segments, leaving the objects around it alone.
 *
 * The counterpart to {@link setByPath}, and the shape a migration needs: fold the
 * old key's value onto the new key, then remove the old one so the file has one
 * owner per value and the migration is a fixed point on its own output.
 */
function deleteByPath(obj: RawSettings, segments: readonly string[]): void {
	const parent = segments.length > 1 ? getByPath(obj, segments.slice(0, -1)) : obj;
	if (!isRecord(parent)) return;
	delete (parent as Record<string, unknown>)[segments[segments.length - 1]];
}

export function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) continue;
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	return normalized;
}

export function validateProviderMaxInFlightRequests(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	const invalidProviders: string[] = [];
	const normalized: Record<string, number> = {};
	for (const [provider, rawLimit] of Object.entries(value)) {
		if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0) {
			invalidProviders.push(provider);
			continue;
		}
		normalized[provider] = Math.max(1, Math.floor(rawLimit));
	}
	if (invalidProviders.length > 0) {
		throw new Error(`Provider request limits must be positive numbers: ${invalidProviders.join(", ")}`);
	}
	return normalized;
}

const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);

/**
 * Largest `ask.timeout` read as seconds. Anything above it is taken to be a
 * millisecond value from the config format that predates the switch to seconds.
 *
 * There is no marker on disk saying which format a file uses, so the magnitude
 * is the only signal available. 1000 seconds is a bit under 17 minutes: far
 * longer than any timeout the settings UI offers, and far shorter than the
 * 15000-120000 that a millisecond-era file actually contained. The cost of the
 * guess falls on a user who wanted a longer wait than that, which is why the
 * rewrite is reported rather than applied quietly.
 */
export const MAX_ASK_TIMEOUT_SECONDS = 1000;
type PathScopedStringArrayEntry = {
	path?: unknown;
	paths?: unknown;
	pathPrefix?: unknown;
	pathPrefixes?: unknown;
	values?: unknown;
	items?: unknown;
	models?: unknown;
	providers?: unknown;
};

function normalizePathPrefix(prefix: string): string {
	return path.resolve(expandTilde(prefix));
}

function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function stringArrayFromUnknown(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return [];
}

function modelRoleValueFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;

	const entries = stringArrayFromUnknown(value);
	return entries.length === value.length ? entries.join(",") : undefined;
}

type EditVariantEntry = {
	patternLower: string;
	mode: EditMode;
};

function resolvePathScopedStringArray(settingPath: SettingPath, value: unknown, cwd: string): string[] | undefined {
	if (!PATH_SCOPED_ARRAY_SETTINGS.has(settingPath) || !Array.isArray(value)) return undefined;

	const resolved: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			resolved.push(entry);
			continue;
		}
		if (!isRecord(entry)) continue;

		const scoped = entry as PathScopedStringArrayEntry;
		const prefixes = [
			...stringArrayFromUnknown(scoped.path),
			...stringArrayFromUnknown(scoped.paths),
			...stringArrayFromUnknown(scoped.pathPrefix),
			...stringArrayFromUnknown(scoped.pathPrefixes),
		];
		if (prefixes.length === 0 || !prefixes.some(prefix => pathMatchesPrefix(cwd, prefix))) continue;

		const values =
			settingPath === "enabledModels"
				? [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.models),
					]
				: [
						...stringArrayFromUnknown(scoped.values),
						...stringArrayFromUnknown(scoped.items),
						...stringArrayFromUnknown(scoped.providers),
					];
		resolved.push(...values);
	}

	return resolved;
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	#configFiles: string[] = [];
	/** Global settings from config.yml/config.yaml */
	#global: RawSettings = {};
	/** Project settings from .claude/settings.yml etc */
	#project: RawSettings = {};
	/** Extra config.yml-style overlays passed by CLI */
	#configOverlay: RawSettings = {};
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Settings files that could not be parsed, and where their bytes were kept. */
	#quarantined: QuarantinedSettingsFile[] = [];
	/** Consecutive failed saves of `#configPath`, and why the last one failed. */
	#saveFailure: { path: string; reason: string; attempts: number } | undefined;
	/** Told when a save has failed often enough that the user has to hear about it. */
	#saveFailureListeners = new Set<(failure: SettingsSaveFailure) => void>();
	/** Configured values whose type contradicts the schema, found during load. */
	#invalidValues: InvalidSettingValue[] = [];
	/** Merged view (global + project + overrides) */
	#merged: RawSettings = {};
	/** Cached resolved values from the merged view, including defaults/path scoping */
	#resolvedCache = new Map<SettingPath, unknown>();
	#editVariantCache: readonly EditVariantEntry[] | undefined;

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();
	/**
	 * Legacy `-1` sentinels removed from the owned config at load, waiting to be
	 * removed from the FILE. They are written out with the migration stamp, on the
	 * first write to a path the migration governs — see #stampOwnedMigrationsFor.
	 */
	#pendingSentinelStrips: string[] = [];

	/** Legacy `lastChangelogVersion` captured from config.yml during migration (now a marker file). */
	#legacyLastChangelogVersion?: string;
	/** Set once `ask.timeout` has been reported as rewritten, so the warning does not repeat on every read. */
	#reportedAskTimeoutRewrite = false;
	/** Dotted-key problems already reported, so each one is said once per process rather than once per read. */
	#reportedDottedKeyProblems = new Set<string>();

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	private constructor(options: SettingsOptions = {}) {
		this.#cwd = path.normalize(options.cwd ?? getProjectDir());
		this.#agentDir = path.normalize(options.agentDir ?? getAgentDir());
		this.#configPath = options.inMemory ? null : path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		this.#configFiles = options.configFiles?.map(file => path.resolve(this.#cwd, expandTilde(file))) ?? [];
		this.#persist = !options.inMemory && options.readOnly !== true;

		if (options.overrides) {
			for (const [key, value] of Object.entries(options.overrides)) {
				setByPath(this.#overrides, key.split("."), value);
			}

			this.#overrides = this.#migrateRawSettings(this.#overrides);
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		if (globalInstancePromise) return globalInstancePromise;

		const instance = new Settings(options);
		const promise = instance.#load();
		globalInstancePromise = promise;

		return promise.then(
			instance => {
				globalInstance = instance;
				clearBoundSettingsMethods();
				globalInstancePromise = Promise.resolve(instance);
				return instance;
			},
			error => {
				globalInstance = null;
				globalInstancePromise = null;
				clearBoundSettingsMethods();
				throw error;
			},
		);
	}

	/**
	 * Load effective settings from config.yml and project providers without
	 * opening agent.db, migrating legacy settings, or writing marker files.
	 */
	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.#loadReadOnly();
	}

	/**
	 * Load a persisted settings instance without touching the global singleton.
	 */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	/**
	 * Create an isolated instance for testing.
	 * Does not affect the global singleton.
	 */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		return globalInstance;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Core API
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Get a setting value (sync).
	 * Returns the merged value from global + project + overrides, or the default.
	 */
	get<P extends SettingPath>(path: P): SettingValue<P> {
		// Global-scoped settings live in ~/.veyyon/config.yml, not the profile
		// store. Read them live through their binding (never cached) so the UI
		// always reflects the current global config, and fall back to the schema
		// default if the read fails. A runtime override wins (used by non-persisting
		// instances so they never touch the real global config).
		const globalBinding = GLOBAL_SETTING_BINDINGS[path];
		if (globalBinding) {
			const override = getByPath(this.#overrides, path.split("."));
			if (override !== undefined) return override as SettingValue<P>;
			try {
				return globalBinding.read() as SettingValue<P>;
			} catch (error) {
				logger.warn("Settings: global read failed; using default", { path, error: String(error) });
				return getDefault(path);
			}
		}

		if (this.#resolvedCache.has(path)) {
			return this.#resolvedCache.get(path) as SettingValue<P>;
		}

		// A read must never crash startup for an unregistered dotted path (e.g.
		// new subsystems reading `harness.profiles` before it lands in the
		// schema). Fall back to splitting the path — the same computation
		// SETTING_PATH_SEGMENTS memoizes — and skip the schema default lookup,
		// which only exists for registered paths.
		const registered = SETTING_PATH_SEGMENTS[path] !== undefined;
		const segments = registered ? SETTING_PATH_SEGMENTS[path] : path.split(".");
		const value = getByPath(this.#merged, segments);
		const resolved =
			value !== undefined
				? (resolvePathScopedStringArray(path, value, this.#cwd) ?? value)
				: registered
					? getDefault(path)
					: undefined;
		this.#resolvedCache.set(path, resolved);
		return resolved as SettingValue<P>;
	}

	/**
	 * Settings files that could not be parsed during this session's load.
	 *
	 * Empty in the normal case. A non-empty list means the session is running
	 * without those files' settings, and a caller with a user-visible surface
	 * should say so: the log alone is not somewhere anyone looks.
	 */
	get quarantinedFiles(): readonly QuarantinedSettingsFile[] {
		return this.#quarantined;
	}

	/**
	 * The save failure the user needs to hear about, or undefined when saves are landing.
	 *
	 * A save that cannot write the file used to be swallowed into a `logger.warn` and the
	 * paths re-queued for retry. Nothing reached the operator: the UI reported the setting
	 * as changed, the in-memory value WAS changed, and the file on disk was not, so the
	 * setting silently reverted on the next launch. On a read-only home, a full disk, or a
	 * config path that became a directory, the retry never succeeds and the user got no
	 * signal at any point (Law 10).
	 *
	 * Only reported once the retries are spent, because a single failure under a concurrent
	 * writer is normal and self-healing. Cleared by the next save that succeeds.
	 */
	get saveFailure(): SettingsSaveFailure | undefined {
		if (!this.#saveFailure) return undefined;
		const { path: failedPath, reason, attempts } = this.#saveFailure;
		if (attempts < SAVE_FAILURE_REPORT_AFTER) return undefined;
		return { path: failedPath, reason, attempts };
	}

	/**
	 * The last save error on this instance, with no retry threshold applied.
	 *
	 * {@link saveFailure} deliberately waits for a run of failures, because in a live
	 * session one failure is a lost race that the retry fixes. A ONE-SHOT command has no
	 * retry future: `veyyon config set` writes once and exits, so the first failure is the
	 * whole story and it has to be able to report it and exit non-zero rather than print
	 * a success it did not achieve. Cleared by the next save that lands.
	 */
	get lastSaveError(): { path: string; reason: string } | undefined {
		if (!this.#saveFailure) return undefined;
		return { path: this.#saveFailure.path, reason: this.#saveFailure.reason };
	}

	/**
	 * Be told when a save has failed too many times, since a save happens mid-session.
	 *
	 * Startup-only reporting (the shape {@link quarantinedFiles} uses) cannot cover this:
	 * the failure happens when the user changes a setting, which is exactly when they are
	 * looking. Returns an unsubscribe.
	 */
	onSaveFailure(listener: (failure: SettingsSaveFailure) => void): () => void {
		this.#saveFailureListeners.add(listener);
		return () => {
			this.#saveFailureListeners.delete(listener);
		};
	}

	/**
	 * Configured settings whose value does not match the schema's declared type.
	 *
	 * Empty in the normal case. A non-empty list means the config on disk says
	 * something the app cannot honor, and the user has to be told: a wrong type is
	 * usually silently WRONG rather than obviously broken. `autoUpdate: "no"` is a
	 * truthy string, so a setting the user plainly meant to turn off stays on and
	 * nothing explains why. Surfacing this is what keeps that from being invisible
	 * (Law 10); the values themselves are left exactly as written, because quietly
	 * substituting the default would hide the broken config instead of reporting it.
	 */
	get invalidValues(): readonly InvalidSettingValue[] {
		return this.#invalidValues;
	}

	/**
	 * Whether `path` has an explicitly configured value (global config, project
	 * config, or runtime override) rather than falling back to the schema default.
	 */
	isConfigured(path: SettingPath): boolean {
		// Global-scoped paths are not in the profile-merged tree; treat a value that
		// differs from the schema default as explicitly configured.
		if (GLOBAL_SETTING_BINDINGS[path]) {
			return !Object.is(this.get(path), getDefault(path));
		}
		return getByPath(this.#merged, SETTING_PATH_SEGMENTS[path] ?? path.split(".")) !== undefined;
	}

	/**
	 * Set a setting value (sync).
	 * Updates global settings and queues a background save.
	 * Triggers hooks for settings that have side effects.
	 */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);

		// Global-scoped settings persist to ~/.veyyon/config.yml through their
		// binding, never the profile store. Write synchronously (the binding does
		// its own file lock) so a subsequent get() reflects it immediately. A
		// non-persisting instance (in-memory / read-only) keeps the change as a
		// runtime override instead, so it never mutates the real global config.
		const globalBinding = GLOBAL_SETTING_BINDINGS[path];
		if (globalBinding) {
			if (this.#persist) {
				try {
					globalBinding.write(value);
				} catch (error) {
					logger.warn("Settings: global write rejected; value not saved", { path, error: String(error) });
					return;
				}
			} else {
				setByPath(this.#overrides, path.split("."), value);
				this.#rebuildMerged();
			}
			const next = this.get(path);
			const hook = SETTING_HOOKS[path];
			if (hook) hook(next, prev);
			this.#fireEffectiveSettingChanged(path, next, prev);
			return;
		}

		// Before writing one of the optional numeric paths, finish the one-shot
		// migration and stamp it: the value being written may itself be the `-1`
		// that used to mean "unset", and only an on-disk stamp keeps the next load
		// from deleting it. Stamping first also means the strip cannot reach the new
		// value.
		this.#stampOwnedMigrationsFor(path);
		const segments = path.split(".");
		setByPath(this.#global, segments, value);
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();

		// Trigger hook if exists
		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(next, prev);
		}
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

	/**
	 * Return a setting to its default by REMOVING the key, rather than writing a
	 * value that stands for "unset".
	 *
	 * This is what "Default" means for an optional setting. Encoding it as a
	 * magic number instead made that number unreachable as a real value: with
	 * `-1` meaning unset, `presencePenalty: -1` — which the provider accepts —
	 * could not be configured at all. An absent key has no such collision, and
	 * `get` already falls back to the schema default.
	 *
	 * Fires the same hooks and change signals as {@link set}, because from every
	 * reader's point of view the effective value changed.
	 */
	unset(path: SettingPath): void {
		const prev = this.get(path);

		const globalBinding = GLOBAL_SETTING_BINDINGS[path];
		if (globalBinding) {
			if (this.#persist) {
				try {
					globalBinding.write(undefined);
				} catch (error) {
					logger.warn("Settings: global unset rejected; value not cleared", { path, error: String(error) });
					return;
				}
			} else {
				deleteByPath(this.#overrides, path.split("."));
				this.#rebuildMerged();
			}
			const next = this.get(path);
			SETTING_HOOKS[path]?.(next, prev);
			this.#fireEffectiveSettingChanged(path, next, prev);
			return;
		}

		this.#stampOwnedMigrationsFor(path);
		const segments = SETTING_PATH_SEGMENTS[path] ?? path.split(".");
		deleteByPath(this.#global, segments);
		// Also drop a runtime override for the same path. Both are values this
		// process owns, and leaving the override in place would make "Default"
		// appear to do nothing whenever a flag or overlay had set the same knob. A
		// value from a PROJECT config is not touched: this instance does not own
		// that file, and get() still reports it as the effective value.
		deleteByPath(this.#overrides, segments);
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();
		SETTING_HOOKS[path]?.(next, prev);
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

	/**
	 * Stamp the one-shot migrations into the owned config when the path being
	 * written is one they govern. A no-op for every other setting, so an ordinary
	 * write does not add the stamp to a config that has nothing to migrate.
	 */
	#stampOwnedMigrationsFor(path: SettingPath): void {
		if (!isUnsetNumberPath(path)) return;
		// The load already removed the legacy sentinels from the in-memory tree, so
		// they are marked modified from the record kept then: without that the file
		// would keep a `-1` while the stamp said "migrated", and the next load would
		// read that `-1` as the VALUE minus one and send it to the provider.
		for (const strippedPath of this.#pendingSentinelStrips) this.#modified.add(strippedPath);
		this.#pendingSentinelStrips = [];
		for (const changedPath of stampOwnedConfigMigrations(this.#global)) this.#modified.add(changedPath);
	}

	/**
	 * Apply runtime overrides (not persisted).
	 */
	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	/**
	 * Clear a runtime override.
	 */
	clearOverride(path: SettingPath): void {
		const prev = this.get(path);
		const segments = path.split(".");
		let current = this.#overrides;
		for (let i = 0; i < segments.length - 1; i++) {
			const segment = segments[i];
			if (!(segment in current)) return;
			current = current[segment] as RawSettings;
		}
		delete current[segments[segments.length - 1]];
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown): void {
		if (Object.is(value, prev)) return;
		if (path === "statusLine.sessionAccent") {
			statusLineSessionAccentSignal.fire();
		}
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
	}

	/**
	 * Flush any pending saves to disk.
	 * Call before exit to ensure all changes are persisted.
	 */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		if (this.#savePromise) {
			await this.#savePromise;
		}
		if (this.#modified.size > 0) {
			await this.#saveNow();
		}
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#configPath = this.#configPath;
		cloned.#global = structuredClone(this.#global);
		cloned.#project = this.#persist ? await cloned.#loadProjectSettings() : structuredClone(this.#project);
		cloned.#configFiles = [...this.#configFiles];
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		cloned.#overrides = structuredClone(this.#overrides);
		cloned.#rebuildMerged();
		cloned.#fireAllHooks();
		return cloned;
	}

	/**
	 * Re-scope this instance to a new working directory *in place*: reload the
	 * project layer (`.claude/settings.yml` etc.) from `cwd`, re-resolve
	 * path-scoped settings against it, and re-fire side-effect hooks (theme,
	 * symbols, tab width, …). Global settings and runtime overrides are preserved.
	 *
	 * Unlike {@link cloneForCwd}, this mutates the live instance, so every holder
	 * (the `settings` proxy, the active session, controllers) observes the new
	 * project scope without swapping references — used when the process changes
	 * directory mid-run (`/move`, cross-project resume). No-op when `cwd` is
	 * already the current scope.
	 */
	async reloadForCwd(cwd: string): Promise<void> {
		const normalized = path.normalize(cwd);
		if (normalized === this.#cwd) return;
		const prevModelRoles = this.get("modelRoles");
		this.#cwd = normalized;
		if (this.#persist) {
			this.#project = await this.#loadProjectSettings();
		}
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged("modelRoles", this.get("modelRoles"), prevModelRoles);
		this.#fireAllHooks();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getStorage(): AgentStorage | null {
		return this.#storage;
	}

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
	}

	getPlansDirectory(): string {
		return path.join(this.#agentDir, "plans");
	}

	/**
	 * Get shell configuration based on settings.
	 */
	getShellConfig() {
		const shell = this.get("shellPath");
		return procmgr.getShellConfig(shell);
	}

	/**
	 * Get all settings in a group with full type safety.
	 */
	getGroup<G extends GroupPrefix>(prefix: G): GroupTypeMap[G] {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			if (key.startsWith(`${prefix}.`)) {
				const suffix = key.slice(prefix.length + 1);
				result[suffix] = this.get(key);
			}
		}
		return result as unknown as GroupTypeMap[G];
	}

	/**
	 * Resolve every known setting to its effective value, keyed by dotted path.
	 *
	 * This is the complete config that governed a run — compaction strategy,
	 * reserve tokens, advisor/subagent config, tool config, and every other
	 * Tier-A knob — captured as one flat map. A session records this at start so a
	 * later study/backtest can reproduce the exact configuration the run used,
	 * not merely guess it from current defaults. Keys are sorted for stable,
	 * diffable output.
	 */
	getEffectiveSnapshot(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const key of (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).sort()) {
			result[key] = this.get(key);
		}
		return result;
	}

	/**
	 * Get the edit variant for a specific model.
	 * Returns "patch", "replace", "hashline", "apply_patch", or null (use global default).
	 */
	getEditVariantForModel(model: string | undefined): EditMode | null {
		if (!model) return null;
		const variants = this.#getEditVariantEntries();
		if (variants.length === 0) return null;

		const modelLower = model.toLowerCase();

		for (let i = 0; i < variants.length; i++) {
			const variant = variants[i];
			if (modelLower.includes(variant.patternLower)) {
				return variant.mode;
			}
		}
		return null;
	}

	#getEditVariantEntries(): readonly EditVariantEntry[] {
		if (this.#editVariantCache !== undefined) return this.#editVariantCache;

		const value = getByPath(this.#merged, ["edit", "modelVariants"]);
		if (!isRecord(value)) {
			this.#editVariantCache = [];
			return this.#editVariantCache;
		}

		const variants: EditVariantEntry[] = [];
		for (const pattern in value) {
			if (!Object.hasOwn(value, pattern)) continue;
			const rawMode = value[pattern];
			if (typeof rawMode !== "string") continue;
			const mode = normalizeEditMode(rawMode);
			if (mode) {
				variants.push({ patternLower: pattern.toLowerCase(), mode });
			}
		}

		this.#editVariantCache = variants;
		return variants;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	#modelRolesFromLayer(layer: RawSettings): Record<string, string> {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return {};

		const roles: Record<string, string> = {};
		for (const role in value) {
			if (!Object.hasOwn(value, role)) continue;
			const modelId = modelRoleValueFromUnknown(value[role]);
			if (modelId !== undefined) {
				roles[role] = modelId;
			}
		}
		return roles;
	}

	/**
	 * Set a model role (helper for modelRoles record). Passing `undefined`
	 * clears the role from the persisted record and any runtime override.
	 */
	setModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer(this.#global);
		const runtimeOverrides = getByPath(this.#overrides, ["modelRoles"]);
		const updateRuntimeOverride =
			!!runtimeOverrides &&
			typeof runtimeOverrides === "object" &&
			!Array.isArray(runtimeOverrides) &&
			Object.hasOwn(runtimeOverrides, role);

		if (modelId === undefined) {
			delete current[role];
		} else {
			current[role] = modelId;
		}
		this.set("modelRoles", current);

		if (updateRuntimeOverride) {
			const nextRuntimeOverride = this.#modelRolesFromLayer(this.#overrides);
			if (modelId === undefined) {
				delete nextRuntimeOverride[role];
			} else {
				nextRuntimeOverride[role] = modelId;
			}
			this.override("modelRoles", nextRuntimeOverride);
		}
	}

	/**
	 * Get a model role (helper for modelRoles record).
	 */
	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}

	/**
	 * Get all model roles (helper for modelRoles record).
	 */
	getModelRoles(): ReadOnlyDict<string> {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return {};

		const normalized: Record<string, string> = {};
		for (const role in roles) {
			if (!Object.hasOwn(roles, role)) continue;
			const modelId = modelRoleValueFromUnknown(roles[role]);
			if (modelId !== undefined) {
				normalized[role] = modelId;
			}
		}
		return normalized;
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer(this.#overrides);
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
			}
		}
		this.override("modelRoles", next);
	}

	/**
	 * Set disabled providers (for compatibility with discovery system).
	 */
	setDisabledProviders(ids: string[]): void {
		this.set("disabledProviders", ids);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	async #load(): Promise<Settings> {
		// Project settings load (loadCapability scans cwd) is independent of the
		// persist chain (storage open → legacy migration → global config read), so
		// kick it off first and await after the persist chain completes. The
		// persist steps remain sequential: existing config discovery decides
		// whether migration may write config.yml before the global config is read;
		// migration's db fallback needs #storage opened.
		const projectPromise = this.#loadProjectSettings();

		if (this.#persist) {
			this.#storage = await AgentStorage.open(getAgentDbPath(this.#agentDir));
			const existingConfig = await this.#loadExistingMainYaml();
			if (existingConfig) {
				this.#global = existingConfig;
			} else {
				await this.#migrateFromLegacy();
				this.#global = await this.#loadYaml(this.#configPath!);
			}
			await this.#seedLastChangelogVersionMarker();
			// Drop the legacy `-1` sentinels from the owned config, in memory. Not
			// stamped here: the stamp goes in when one of those paths is written (see
			// stampOwnedConfigMigrations), so an upgrade does not add a line to every
			// config on disk, and a `-1` written by this version is still safe from
			// the next load.
			this.#pendingSentinelStrips = stripLegacyUnsetSentinels(this.#global);
		}

		this.#project = await projectPromise;
		this.#configOverlay = await this.#loadConfigOverlays();
		this.#collectInvalidValues(this.#global, this.#configPath ?? "");
		this.#reportShadowedConfigFiles();

		// Build merged view (global → project → overrides; project wins over global)
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

	async #loadReadOnly(): Promise<Settings> {
		const projectPromise = this.#loadProjectSettings();

		const existingConfig = await this.#loadExistingMainYaml();
		if (existingConfig) {
			this.#global = existingConfig;
		}

		this.#project = await projectPromise;
		this.#configOverlay = await this.#loadConfigOverlays();
		this.#collectInvalidValues(this.#global, this.#configPath ?? "");
		this.#rebuildMerged();
		return this;
	}

	/**
	 * Report a config file that exists but is ignored because a higher-precedence
	 * one exists too.
	 *
	 * `dirs` finds these but cannot report them: it sits below the logger, which
	 * imports it. This is the layer that has somewhere to say it, so it says it
	 * here rather than letting a whole settings file be silently dead.
	 */
	#reportShadowedConfigFiles(): void {
		for (const shadowed of findShadowedGlobalConfigFiles()) {
			logger.warn("Global config file is being ignored because a higher-precedence one exists", {
				ignored: shadowed.ignored,
				using: shadowed.using,
				fix: `merge ${path.basename(shadowed.ignored)} into ${path.basename(shadowed.using)} and delete it`,
			});
		}
	}

	/**
	 * Check every configured value in `tree` against the schema and record the
	 * mismatches, naming `file` so the user knows where to edit.
	 *
	 * Walked from the schema rather than from the tree on purpose: iterating the
	 * file's keys would also flag keys this build does not know, which are
	 * deliberately preserved (see the unknown-key preservation suite) and are not
	 * errors. Only paths the schema actually declares can be judged against a
	 * declared type.
	 */
	#collectInvalidValues(tree: RawSettings, file: string): void {
		if (!file) return;
		for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const value = getByPath(tree, SETTING_PATH_SEGMENTS[path] ?? path.split("."));
			if (value === undefined) continue;
			const reason = describeSettingTypeMismatch(path, value);
			if (reason === undefined) continue;
			if (this.#invalidValues.some(entry => entry.path === path && entry.file === file)) continue;
			this.#invalidValues.push({ path, file, reason });
			// Logged as a warning AND exposed on the instance: the log is for a
			// developer reading a session afterwards, the accessor is for a surface
			// that can actually put it in front of the person who wrote the file.
			logger.warn("Settings: configured value does not match its declared type", { file, reason });
		}
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresent(filePath);
		return loaded ?? {};
	}

	async #loadYamlIfPresent(filePath: string): Promise<RawSettings | null> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			logger.warn("Settings: failed to load", { path: filePath, error: String(error) });
			return {};
		}

		try {
			const parsed = YAML.parse(content);
			// A blank or comments-only file parses to null/undefined: that is a
			// legitimately empty settings file, so an empty view is the truth.
			if (parsed === null || parsed === undefined) {
				return {};
			}
			// A file that parses cleanly but to a NON-mapping (a bare scalar, a YAML
			// sequence, a string) is malformed exactly like an unparseable one: the
			// user wrote a settings file, and silently returning {} would drop every
			// setting they configured with no signal at all (Law 10) — worse than the
			// parse-error path, which at least quarantines and reports. The strict
			// overlay loader (#loadOverlayYaml) already rejects a non-mapping root
			// outright; the persistent loader must be just as loud. Quarantine the
			// file and record it so startup can tell the user, instead of pretending
			// the file was empty.
			if (!isRecord(parsed)) {
				await this.#quarantineUnparseableSettings(
					filePath,
					content,
					new Error("settings root must be a YAML mapping, not a scalar or sequence"),
				);
				return {};
			}
			return this.#migrateRawSettings(parsed as RawSettings);
		} catch (error) {
			await this.#quarantineUnparseableSettings(filePath, content, error);
			return {};
		}
	}

	/**
	 * Preserve a settings file we could not parse, and remember it for the UI.
	 *
	 * The preserving itself lives in `@veyyon/utils` because keybindings has the
	 * same hazard; what is specific here is recording the file so
	 * {@link quarantinedFiles} can report it at startup.
	 */
	async #quarantineUnparseableSettings(filePath: string, content: string, error: unknown): Promise<void> {
		const quarantinePath = await quarantineUnparseableFile(filePath, content, error);
		if (!quarantinePath) return;
		if (!this.#quarantined.some(entry => entry.path === filePath)) {
			this.#quarantined.push({ path: filePath, quarantinePath });
		}
	}

	async #loadExistingMainYaml(): Promise<RawSettings | null> {
		if (!this.#configPath) return null;
		for (const filename of MAIN_CONFIG_FILENAMES) {
			const configPath = path.join(this.#agentDir, filename);
			const loaded = await this.#loadYamlIfPresent(configPath);
			if (loaded) {
				this.#configPath = configPath;
				return loaded;
			}
		}
		this.#configPath = path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		return null;
	}

	async #loadProjectSettings(): Promise<RawSettings> {
		try {
			const result = await loadCapability(settingsCapability.id, { cwd: this.#cwd });
			// Surface provider-level warnings (e.g. a malformed project settings
			// file that the capability layer flagged): dropping them silently
			// meant a user's broken settings.json was ignored with no signal.
			for (const warning of result.warnings) {
				logger.warn("Settings: project settings discovery warning", { warning });
			}
			let merged: RawSettings = {};
			for (const item of result.items as SettingsCapabilityItem[]) {
				if (item.level === "project") {
					merged = this.#deepMerge(merged, item.data as RawSettings);
				}
			}
			return this.#migrateRawSettings(merged);
		} catch (error) {
			// Fail soft to defaults so a bad project settings file cannot block
			// startup, but do not swallow the reason (Law 10).
			logger.warn("Settings: failed to load project settings", {
				cwd: this.#cwd,
				error: String(error),
			});
			return {};
		}
	}

	async #loadConfigOverlays(): Promise<RawSettings> {
		let merged: RawSettings = {};
		for (const filePath of this.#configFiles) {
			merged = this.#deepMerge(merged, await this.#loadOverlayYaml(filePath));
		}
		return merged;
	}

	/**
	 * Strict loader for explicit `--config` overlays: unlike `#loadYaml`,
	 * missing or malformed files are hard errors so a typo'd path cannot
	 * silently fall back to the persistent settings.
	 */
	async #loadOverlayYaml(filePath: string): Promise<RawSettings> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			throw new Error(
				isEnoent(error)
					? `Config overlay not found: ${filePath}`
					: `Failed to read config overlay ${filePath}: ${String(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			throw new Error(`Failed to parse config overlay ${filePath}: ${String(error)}`);
		}
		if (parsed === null || parsed === undefined) return {};
		if (typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Config overlay must be a YAML mapping: ${filePath}`);
		}
		return this.#migrateRawSettings(parsed as RawSettings);
	}

	async #migrateFromLegacy(): Promise<void> {
		if (!this.#configPath) return;

		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (isRecord(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed as RawSettings));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch (error) {
					// The settings were migrated in memory; only the archival rename
					// failed. Non-fatal (the next run re-migrates), but surface it.
					logger.warn("Settings: could not archive legacy settings.json after migration", {
						path: settingsJsonPath,
						error: errorMessage(error),
					});
				}
			}
		} catch (error) {
			// A missing legacy file is the normal case (nothing to migrate). A file
			// that exists but cannot be read or parsed means the user's legacy
			// settings would be dropped silently — surface that instead (Law 10).
			if (!isEnoent(error)) {
				logger.warn("Settings: legacy settings.json exists but could not be migrated", {
					path: settingsJsonPath,
					error: errorMessage(error),
				});
			}
		}

		// 2. Migrate from agent.db
		try {
			const dbSettings = this.#storage?.getSettings();
			if (dbSettings) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(dbSettings as RawSettings));
				migrated = true;
			}
		} catch (error) {
			logger.warn("Settings: could not read legacy settings from agent.db during migration", {
				error: errorMessage(error),
			});
		}

		// 3. Write merged settings
		//
		// This write is deliberately NOT wrapped in withFileLock, unlike #saveNow.
		// It runs only from #load when config.yml is absent (first run), and its
		// content is a pure, deterministic function of the legacy sources
		// (settings.json + agent.db) — so a concurrent first-run in another
		// process writes byte-identical content and last-writer-wins is benign.
		// The write itself is atomic (whole file), so no reader ever sees a
		// partial config. INVARIANT: if migration ever becomes non-idempotent or
		// order-dependent, this must move under withFileLock(this.#configPath)
		// with a re-read, matching #saveNow.
		if (migrated && Object.keys(settings).length > 0) {
			try {
				await this.#writeConfigPreservingText(this.#configPath, settings);
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch (error) {
				// The migration ran but the merged config could not be persisted, so
				// the migrated settings are lost for this run. Surface it loudly
				// rather than silently discarding the user's settings (Law 10).
				logger.warn("Settings: migrated settings could not be written to config.yml", {
					path: this.#configPath,
					error: errorMessage(error),
				});
			}
		}
	}

	/**
	 * Say once that `ask.timeout` was rewritten from milliseconds to seconds.
	 *
	 * The conversion is a guess (see the call site), so the one case it gets
	 * wrong is a user who genuinely wanted a timeout longer than
	 * {@link MAX_ASK_TIMEOUT_SECONDS}. Without this they would only find out by
	 * watching an ask auto-select in two seconds and having no idea why. Once per
	 * process, because the migration runs on every read of the file.
	 */
	/**
	 * Expand every top-level dotted key that names a registered setting into the
	 * nested tree it belongs in.
	 *
	 * `subagent.model: openai/gpt-5` at the top level of `config.yml` is the same
	 * setting as `subagent: { model: openai/gpt-5 }` to anyone reading the file, and
	 * people write it that way. It was parsed, merged, and then never read: {@link
	 * get} walks nested segments, so the value sat in the tree under a literal
	 * `"subagent.model"` key that nothing looked at, and the setting silently did
	 * nothing (Law 10). It affected every setting, not one — the shape was found
	 * while migrating the subagent keys, where a migration writing this spelling made
	 * every legacy config revert to defaults with no signal.
	 *
	 * Only paths the schema declares are expanded. An unknown dotted key is left
	 * exactly as written: it belongs to a newer build or another tool, preserving it
	 * verbatim is a documented contract, and guessing at its shape would corrupt it.
	 *
	 * A fixed point, like every migration here: after one pass no registered dotted
	 * key remains, so a second pass changes nothing.
	 */
	#expandDottedSettingKeys(raw: RawSettings): void {
		for (const key of Object.keys(raw)) {
			if (!key.includes(".")) continue;
			const segments = SETTING_PATH_SEGMENTS[key as SettingPath];
			if (segments === undefined) continue;

			// Refuse rather than clobber when the nested spelling is blocked by a
			// non-object: writing through would replace whatever the operator has
			// there. Keep the flat key (so nothing is lost) and say so.
			const parentSegments = segments.slice(0, -1);
			let blocked: string | undefined;
			for (let depth = 1; depth <= parentSegments.length; depth++) {
				const branch = getByPath(raw, parentSegments.slice(0, depth));
				if (branch !== undefined && !isRecord(branch)) {
					blocked = parentSegments.slice(0, depth).join(".");
					break;
				}
			}
			if (blocked !== undefined) {
				this.#reportDottedKeyProblem(
					`Settings: "${key}" cannot be read because "${blocked}" holds a value instead of a block. ` +
						`Remove or rename "${blocked}", or nest the setting under it.`,
					{ key, blocked },
				);
				continue;
			}

			const flat = raw[key];
			delete raw[key];
			const nested = getByPath(raw, segments);
			if (nested !== undefined) {
				// The nested spelling is what the docs show and what every UI writes, so
				// it wins. The flat one is dropped, and never silently: the operator wrote
				// two values for one setting and needs to know which one is live.
				this.#reportDottedKeyProblem(
					`Settings: "${key}" is set twice, flat and nested. The nested value is used and the flat key is dropped.`,
					{ key, used: nested, dropped: flat },
				);
				continue;
			}
			setByPath(raw, [...segments], flat);
		}
	}

	/**
	 * Report one dotted-key problem, once per message per process. The migration
	 * runs on every read of every source, so an unconditional warn would repeat the
	 * same line dozens of times per session and train the reader to skip it.
	 */
	#reportDottedKeyProblem(message: string, context: Record<string, unknown>): void {
		if (this.#reportedDottedKeyProblems.has(message)) return;
		this.#reportedDottedKeyProblems.add(message);
		logger.warn(message, context);
	}

	#reportAskTimeoutRewrite(from: number, to: number): void {
		if (this.#reportedAskTimeoutRewrite) return;
		this.#reportedAskTimeoutRewrite = true;
		logger.warn(
			`Settings: ask.timeout was ${from}, which is read as milliseconds from an older config and rewritten to ${to} seconds. ` +
				`If you meant ${from} seconds, set ask.timeout again; it is in seconds now.`,
			{ from, to, maxSeconds: MAX_ASK_TIMEOUT_SECONDS },
		);
	}

	/**
	 * Fold every retired subagent key onto the `subagent.*` area, in place.
	 *
	 * Runs on every read of a settings source, so it must be a FIXED POINT:
	 * applying it to its own output changes nothing. That holds because each
	 * legacy key is deleted after it is folded, and an already-present new value
	 * always wins (an operator who has set the new key is never overwritten by a
	 * stale legacy one).
	 *
	 * `task.eager` mapped three values onto delegation strength; the new
	 * `subagent.delegation` adds `off` at the bottom, so `default` becomes
	 * `allowed` and `always` becomes `required`. `task.disabledAgents` and
	 * `task.agentModelOverrides` were parallel maps keyed by agent name; both fold
	 * into one row per agent in `subagent.agents`.
	 */
	#migrateSubagentSettings(raw: RawSettings): void {
		// Every value in a settings source is NESTED — the loader builds the tree
		// with `setByPath` and `get` reads it back segment by segment — so a dotted
		// key written at the top level here would be stored but never read. That is
		// not theoretical: writing `raw["subagent.delegation"]` made this whole
		// migration a no-op, and only a test that loaded a legacy config and read the
		// new setting back caught it.
		const read = (segments: string[]): unknown => getByPath(raw, segments);
		const take = (segments: string[]): unknown => {
			const value = getByPath(raw, segments);
			if (value !== undefined) deleteByPath(raw, segments);
			return value;
		};
		const setNew = (key: string[], value: unknown): void => {
			if (value === undefined) return;
			// An explicit new-key value already on disk is authoritative: an operator
			// who has set the new setting is never overwritten by a stale legacy key.
			if (read(["subagent", ...key]) !== undefined) return;
			setByPath(raw, ["subagent", ...key], value);
		};

		const eager = take(["task", "eager"]);
		if (typeof eager === "string") {
			// `task.eager` had three values; `subagent.delegation` adds `off` BELOW all
			// of them. The old bottom value must land on `allowed`, not `off`: someone
			// with eager delegation switched off still delegated by hand, and mapping
			// them onto `off` would take the task tool away entirely.
			const delegation = eager === "always" ? "required" : eager === "preferred" ? "preferred" : "allowed";
			setNew(["delegation"], delegation);
		}

		for (const [legacy, next] of [
			["batch", "batch"],
			["maxConcurrency", "maxConcurrency"],
			["enableLsp", "enableLsp"],
			["maxRecursionDepth", "maxRecursionDepth"],
			["maxRuntimeMs", "maxRuntimeMs"],
			["agentIdleTtlMs", "idleTtlMs"],
			["softRequestBudget", "softRequestBudget"],
			["softRequestBudgetNotice", "softRequestBudgetNotice"],
			["showResolvedModelBadge", "showResolvedModelBadge"],
		] as const) {
			setNew([next], take(["task", legacy]));
		}

		// task.isolation.* -> subagent.isolation.*
		for (const key of ["mode", "merge", "commits"] as const) {
			setNew(["isolation", key], take(["task", "isolation", key]));
		}

		// The two agent-keyed maps become one row per agent. Two parallel maps meant
		// two lookups that could disagree, which is how an agent could read as off on
		// one surface while a model override for it lived on invisibly.
		const agents: Record<string, Record<string, unknown>> = {};
		const disabled = take(["task", "disabledAgents"]);
		if (Array.isArray(disabled)) {
			for (const name of disabled) {
				if (typeof name !== "string" || !name.trim()) continue;
				agents[name.trim()] = { ...(agents[name.trim()] ?? {}), enabled: false };
			}
		}
		const overrides = take(["task", "agentModelOverrides"]);
		if (isRecord(overrides)) {
			for (const [name, model] of Object.entries(overrides)) {
				if (typeof model !== "string" || !model.trim()) continue;
				agents[name] = { ...(agents[name] ?? {}), model: model.trim() };
			}
		}
		// An agent in BOTH legacy maps keeps both facts in its one row: the row says
		// disabled AND remembers the model, so turning it back on later does not
		// silently lose the model the operator chose.
		if (Object.keys(agents).length > 0) setNew(["agents"], agents);

		// modelRoles.task was the "model for subagents" knob before this section
		// existed. It folds into the blanket subagent model AND the role entry goes:
		// leaving it would restore two owners for one value, with role expansion
		// answering first, which is exactly why a subagent model setting used to have
		// no effect.
		const legacyRoleModel = read(["modelRoles", "task"]);
		if (typeof legacyRoleModel === "string" && legacyRoleModel.trim()) {
			setNew(["model"], legacyRoleModel.trim());
			deleteByPath(raw, ["modelRoles", "task"]);
		}

		// Leave no empty husk behind: a surviving `task: {}` block is a second place
		// to look for settings that no longer live there.
		if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
		const isolation = getByPath(raw, ["task", "isolation"]);
		if (isRecord(isolation) && Object.keys(isolation).length === 0) {
			deleteByPath(raw, ["task", "isolation"]);
			if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
		}
	}

	/** Apply schema migrations to raw settings */
	/**
	 * Apply every field-level migration to one raw settings tree.
	 *
	 * Runs on EVERY load of EVERY source (global, project, `--config` overlays,
	 * runtime overrides), so every migration here must be a fixed point on its own
	 * output. A migration that CANNOT be — one that cannot distinguish an old
	 * encoding from a value the user typed — does not belong here: it goes in
	 * {@link migrateOwnedConfigOnce}, which runs once against the config this
	 * instance owns.
	 */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// Both spellings of a key mean the same thing, and only the nested one used
		// to be readable. Runs FIRST so every migration below sees one shape.
		this.#expandDottedSettingKeys(raw);

		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}

		// lastChangelogVersion moved out of config.yml into the
		// <agentDir>/last-changelog-version marker file so version bumps no
		// longer dirty user-tracked configs. Capture for marker seeding (see
		// #seedLastChangelogVersionMarker), then strip the key — the next
		// config save drops it from disk.
		if (typeof raw.lastChangelogVersion === "string") {
			this.#legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;

		// collapseChangelog gated how much of the changelog startup dumped into the
		// terminal. Startup no longer prints release notes at all — it prints one
		// line and `/changelog` opens them on the web — so the old key has no
		// behavior left to control. Drop it rather than leave a toggle that does
		// nothing; `startup.updateNotice` governs the line that replaced it.
		delete raw.collapseChangelog;

		// ask.timeout: ms -> seconds, guessed from the magnitude of the value.
		//
		// Every other migration here is a fixed point: re-running it on its own
		// output changes nothing, which is what lets this function run on every
		// read. This one is not. It cannot be, because 2000 in the file is either
		// 2000 milliseconds from the old format or 2000 seconds from the new one
		// and nothing on disk says which. So a user who legitimately wants a
		// 33-minute timeout gets 2 seconds instead, and an ask they expected to
		// wait for them auto-selects almost immediately.
		//
		// The conversion stays, because silently keeping an old ms value would
		// make the same setting wrong in the other direction for far more users.
		// What changes is that it is no longer silent: a rewrite the user did not
		// ask for is reported with both values so they can see what happened and
		// set it in seconds if the guess was wrong.
		if (raw.ask && typeof (raw.ask as Record<string, unknown>).timeout === "number") {
			const oldValue = (raw.ask as Record<string, unknown>).timeout as number;
			if (oldValue > MAX_ASK_TIMEOUT_SECONDS) {
				const converted = Math.round(oldValue / 1000);
				(raw.ask as Record<string, unknown>).timeout = converted;
				this.#reportAskTimeoutRewrite(oldValue, converted);
			}
		}

		// compaction.thresholdTokens / compaction.thresholdPercent -> compaction.threshold
		//
		// Two keys wrote one axis with an invisible precedence. Fold them into the one
		// key HERE, on load, so the ambiguity leaves the file: an absolute amount
		// becomes a bare token count, a percent becomes `85%`, and the retired keys are
		// dropped. Precedence matches the old resolver (tokens, then percent), so the
		// trigger point does not move. A `threshold` already present always wins and
		// the retired keys are dropped without being read, which is what makes this a
		// fixed point — re-running it on its own output changes nothing.
		//
		// `withLegacyCompactionThreshold` still folds them at read time, for config
		// sources this never rewrites (project files, `--config` overlays, and
		// non-persisting instances).
		const compaction = raw.compaction as Record<string, unknown> | undefined;
		if (compaction && ("thresholdTokens" in compaction || "thresholdPercent" in compaction)) {
			if (compaction.threshold === undefined) {
				const legacyTokens = compaction.thresholdTokens;
				const legacyPercent = compaction.thresholdPercent;
				if (typeof legacyTokens === "number" && Number.isFinite(legacyTokens) && legacyTokens > 0) {
					compaction.threshold = String(legacyTokens);
				} else if (typeof legacyPercent === "number" && Number.isFinite(legacyPercent) && legacyPercent > 0) {
					compaction.threshold = `${legacyPercent}%`;
				}
			}
			delete compaction.thresholdTokens;
			delete compaction.thresholdPercent;
		}

		// Optional numeric settings once stored `-1` to mean "unset", which made -1
		// unreachable as a real value: `presencePenalty: -1` is a penalty the
		// provider accepts, and it could not be configured. Unset is an ABSENT key
		// now, so the old sentinel is dropped — in every prior version it meant
		// exactly this, so nothing a user chose is lost.
		//
		// ONCE, and only in the config this instance owns. This is the one
		// migration here that cannot tell its input apart from a legitimate current
		// value, so re-running it would delete a `-1` the user typed on purpose (it
		// deleted one within a minute of the change landing, in dogfooding). The
		// stamp records that it ran; a project file or a `--config` overlay is
		// hand-written against the current docs, so a `-1` there is a value.

		// Migrate old flat "theme" string to nested theme.dark/theme.light
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				// Built-in defaults — just remove, let new defaults apply
				delete raw.theme;
			} else {
				// Custom theme — detect luminance to place in correct slot
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}

		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}

		// task.simple: removed — the task tool no longer accepts a per-call
		// schema (workflows drive structured output via eval agent()) and the
		// batch/context shape is gated by task.batch instead.
		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}

		// task.eager / todo.eager: boolean -> enum (default | preferred | always).
		// `true` reproduced the previous "on" behavior, which is now `always`.
		if (taskObj && typeof taskObj.eager === "boolean") {
			taskObj.eager = taskObj.eager ? "always" : "default";
		}
		const todoObj = raw.todo as Record<string, unknown> | undefined;
		if (todoObj && typeof todoObj.eager === "boolean") {
			todoObj.eager = todoObj.eager ? "always" : "default";
		}

		// task.isolation.mode: legacy values from before the veyyon-iso PAL refactor.
		// `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
		// and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
		// kinds; the PAL falls back internally when the chosen one isn't
		// available, so we don't need the old TS-side platform guards.
		if (isolationObj && typeof isolationObj.mode === "string") {
			const legacy: Record<string, string> = {
				worktree: "rcopy",
				"fuse-overlay": "overlayfs",
				"fuse-projfs": "projfs",
			};
			const mapped = legacy[isolationObj.mode as string];
			if (mapped !== undefined) {
				isolationObj.mode = mapped;
			}
		}

		// task.* / modelRoles.task -> the subagent.* settings area.
		//
		// Everything about spawned agents used to be spread across `task.*`
		// operational keys, `subagent.model` under Models, `modelRoles.task` in the
		// role table, and two UI-less maps (`task.agentModelOverrides`,
		// `task.disabledAgents`). This rewrites the old keys onto the one section so
		// the file has a single owner per value — no dual-read, which is how the
		// precedence tangle grew in the first place.
		this.#migrateSubagentSettings(raw);

		// edit.mode: removed "atom" and "vim" variants map back to "hashline"
		const editObj = raw.edit as Record<string, unknown> | undefined;
		if (editObj) {
			if (editObj.mode === "atom" || editObj.mode === "vim") {
				editObj.mode = "hashline";
			}
			const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
			if (isRecord(modelVariants)) {
				for (const [pattern, variant] of Object.entries(modelVariants)) {
					if (variant === "atom" || variant === "vim") {
						modelVariants[pattern] = "hashline";
					}
				}
			}
		}
		// compaction.strategy: collapse legacy strategies to handoff|summary; off disables compaction.
		const compactionObj = raw.compaction as Record<string, unknown> | undefined;
		const migrateStrategy = (current: unknown): CompactionStrategySetting | undefined => {
			if (typeof current !== "string") return undefined;
			if (current === "off") return "handoff";
			return migrateCompactionStrategyValue(current);
		};
		if (compactionObj) {
			if (compactionObj.strategy === "shake-summary") {
				compactionObj.strategy = "handoff";
			} else if (compactionObj.strategy === "off") {
				compactionObj.strategy = "handoff";
				if (compactionObj.enabled === undefined) {
					compactionObj.enabled = false;
				}
			} else {
				const migrated = migrateStrategy(compactionObj.strategy);
				if (migrated) compactionObj.strategy = migrated;
			}
			if (compactionObj.compactionModel !== undefined && compactionObj.model === undefined) {
				compactionObj.model = compactionObj.compactionModel;
				delete compactionObj.compactionModel;
			}
		}
		// `compaction.compactionModel` is a RETIRED key, so it survives the dotted-key
		// expansion above (only registered paths are expanded) and both spellings of it
		// still have to be folded. The destination is always nested: a flat
		// `compaction.model` would be written into the tree and then never read.
		const legacyFlatCompactionModel = raw["compaction.compactionModel"];
		if (legacyFlatCompactionModel !== undefined && getByPath(raw, ["compaction", "model"]) === undefined) {
			setByPath(raw, ["compaction", "model"], legacyFlatCompactionModel);
			delete raw["compaction.compactionModel"];
		}
		if (typeof raw.compactionModel === "string" && getByPath(raw, ["compaction", "model"]) === undefined) {
			setByPath(raw, ["compaction", "model"], raw.compactionModel);
			delete raw.compactionModel;
		}

		const modelOverrides = raw.modelOverrides as Record<string, Record<string, unknown>> | undefined;
		if (modelOverrides && getByPath(raw, ["compaction", "model"]) === undefined) {
			for (const entry of Object.values(modelOverrides)) {
				const compactionModel = entry?.compactionModel;
				if (typeof compactionModel === "string" && compactionModel.trim()) {
					setByPath(raw, ["compaction", "model"], compactionModel);
					break;
				}
			}
		}

		// cycleOrder: drop legacy default pseudo-role from ctrl+p order.
		const cycleOrder = raw.cycleOrder;
		if (Array.isArray(cycleOrder)) {
			raw.cycleOrder = cycleOrder.filter(role => role !== "default");
		}

		// The snapcompact image-archive engine was removed; drop any persisted
		// snapcompact.* settings so schema validation does not trip on stale keys.
		delete raw.snapcompact;
		for (const key of Object.keys(raw)) {
			if (key.startsWith("snapcompact.")) delete raw[key];
		}

		// inlineToolDescriptors: boolean -> enum (auto | on | off). The old
		// `true`/`false` mapped directly onto inline-on/inline-off, so preserve
		// the user's explicit choice; new installs get the `auto` default that
		// turns it on only for Gemini models.
		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}

		// statusLine: rename "plan_mode" segment to "mode"
		const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
		if (statusLineObj) {
			for (const key of ["leftSegments", "rightSegments"] as const) {
				const segments = statusLineObj[key];
				if (Array.isArray(segments)) {
					statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
				}
			}
			const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
			if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
				segmentOptions.mode = segmentOptions.plan_mode;
				delete segmentOptions.plan_mode;
			}
		}

		// providers.parallelFetch (boolean) replaced by the providers.fetch reader
		// priority enum. The new default ("auto") supersedes both old values —
		// Parallel is now a deep fallback in the auto chain rather than the first
		// choice — so drop the legacy key (flat and nested) and let the enum
		// default apply.
		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];

		// codexResets.autoRedeem: boolean -> tri-state enum.
		// Existing explicit false keeps the old "do not run" behavior; missing
		// config now falls through to the new "unset" default, which asks before
		// the first eligible spend.
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}

		// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
		// enum if the latter hasn't been set yet. Idempotent: subsequent
		// migrations are no-ops once memory.backend is materialised.
		const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
		const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
		const memoriesObj = raw.memories as Record<string, unknown> | undefined;
		if (!memoryBackendSet && memoriesObj && typeof memoriesObj.enabled === "boolean") {
			const next = memoriesObj.enabled ? "local" : "off";
			const memoryRoot = (memoryBackendObj ?? {}) as Record<string, unknown>;
			memoryRoot.backend = next;
			raw.memory = memoryRoot;
		}

		// Rename the legacy local `mnemosyne` memory backend to `mnemopi`.
		// - `memory.backend: "mnemosyne"` now selects the renamed backend.
		// - the top-level `mnemosyne` settings object becomes `mnemopi`.
		// Idempotent: skips the object move once `mnemopi` is materialised.
		if (memoryBackendObj && memoryBackendObj.backend === "mnemosyne") {
			memoryBackendObj.backend = "mnemopi";
		}
		if ("mnemosyne" in raw && !("mnemopi" in raw)) {
			raw.mnemopi = raw.mnemosyne;
			delete raw.mnemosyne;
		}

		// hindsight: dynamicBankId/agentName -> scoping enum + bankId
		// - dynamicBankId=true  → scoping="per-project" (closest semantic match;
		//   the legacy `agent::project::channel::user` tuple was per-project in
		//   practice — the channel/user env vars were rarely set).
		// - hindsight.agentName was only used as the agent slot in the legacy
		//   dynamic tuple; if the user customised it we surface it as the new
		//   bankId base when no explicit bankId is set.
		const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
		if (hindsightObj) {
			if ("dynamicBankId" in hindsightObj) {
				if (!("scoping" in hindsightObj) && hindsightObj.dynamicBankId === true) {
					hindsightObj.scoping = "per-project";
				}
				delete hindsightObj.dynamicBankId;
			}
			if ("agentName" in hindsightObj) {
				const agentName = hindsightObj.agentName;
				if (
					!("bankId" in hindsightObj) &&
					typeof agentName === "string" &&
					agentName.trim().length > 0 &&
					agentName !== "veyyon" &&
					agentName !== "omp"
				) {
					hindsightObj.bankId = agentName;
				}
				delete hindsightObj.agentName;
			}
		}

		// power.preventIdleSleep / power.preventSystemSleep / power.declareUserActive
		// / power.preventDisplaySleep (four booleans) → power.sleepPrevention enum.
		// The enum is cumulative: each level adds the flags of all lower levels.
		// Migration picks the highest level whose condition is met, scanning from
		// most to least aggressive so a single enum value captures the old state.
		// The flat spelling of the destination needs no check: the expansion above has
		// already folded `power.sleepPrevention` into the nested tree. The legacy
		// booleans below are RETIRED keys, which the expansion leaves alone, so both
		// spellings of those are still read.
		if (!("sleepPrevention" in ((raw.power as Record<string, unknown>) ?? {}))) {
			const powerObj = raw.power as Record<string, unknown> | undefined;
			const getFlag = (key: string): boolean | undefined => {
				const nested = powerObj?.[key];
				const flat = raw[`power.${key}`];
				const value = nested ?? flat;
				return typeof value === "boolean" ? value : undefined;
			};
			const idle = getFlag("preventIdleSleep");
			const system = getFlag("preventSystemSleep");
			const user = getFlag("declareUserActive");
			const display = getFlag("preventDisplaySleep");
			const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
			if (anySet) {
				const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
				const powerRoot = (powerObj ?? {}) as Record<string, unknown>;
				powerRoot.sleepPrevention = mode;
				raw.power = powerRoot;
			}
			// Clean up old keys (nested + flat)
			if (powerObj) {
				delete powerObj.preventIdleSleep;
				delete powerObj.preventSystemSleep;
				delete powerObj.declareUserActive;
				delete powerObj.preventDisplaySleep;
			}
			delete raw["power.preventIdleSleep"];
			delete raw["power.preventSystemSleep"];
			delete raw["power.declareUserActive"];
			delete raw["power.preventDisplaySleep"];
		}

		// Migration for renamed settings grep.* and glob.* from search.* and find.*:
		// 1. Nested settings: find -> glob, search -> grep (per-property merge to avoid clobbering)
		const ensureRawObject = (key: "glob" | "grep"): Record<string, unknown> => {
			const current = raw[key];
			if (isRecord(current)) {
				return current;
			}
			const created: Record<string, unknown> = {};
			raw[key] = created;
			return created;
		};

		if ("find" in raw) {
			const findObj = raw.find;
			if (isRecord(findObj)) {
				const globObj = ensureRawObject("glob");
				const findKeys: Array<"enabled"> = ["enabled"];
				for (const key of findKeys) {
					if (key in findObj && !(key in globObj)) {
						globObj[key] = findObj[key];
					}
				}
			}
			delete raw.find;
		}

		if ("search" in raw) {
			const searchObj = raw.search;
			if (isRecord(searchObj)) {
				const grepObj = ensureRawObject("grep");
				const searchKeys: Array<"enabled" | "contextBefore" | "contextAfter"> = [
					"enabled",
					"contextBefore",
					"contextAfter",
				];
				for (const key of searchKeys) {
					if (key in searchObj && !(key in grepObj)) {
						grepObj[key] = searchObj[key];
					}
				}
			}
			delete raw.search;
		}

		// 2. Flat settings keys: map them to the proper nested target so get/set resolves them correctly
		if ("find.enabled" in raw) {
			const globObj = ensureRawObject("glob");
			if (!("enabled" in globObj)) {
				globObj.enabled = raw["find.enabled"];
			}
			delete raw["find.enabled"];
		}
		if ("search.enabled" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("enabled" in grepObj)) {
				grepObj.enabled = raw["search.enabled"];
			}
			delete raw["search.enabled"];
		}
		if ("search.contextBefore" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("contextBefore" in grepObj)) {
				grepObj.contextBefore = raw["search.contextBefore"];
			}
			delete raw["search.contextBefore"];
		}
		if ("search.contextAfter" in raw) {
			const grepObj = ensureRawObject("grep");
			if (!("contextAfter" in grepObj)) {
				grepObj.contextAfter = raw["search.contextAfter"];
			}
			delete raw["search.contextAfter"];
		}

		// 3. Tool-name arrays use wire IDs too. Preserve user overrides across
		// the rename without duplicating entries if they already added grep/glob.
		const migrateToolNameList = (names: unknown): unknown => {
			if (!Array.isArray(names)) return names;
			const out: unknown[] = [];
			const seen = new Set<string>();
			for (const name of names) {
				const migrated = typeof name === "string" ? normalizeToolName(name) : name;
				if (typeof migrated === "string") {
					if (seen.has(migrated)) continue;
					seen.add(migrated);
				}
				out.push(migrated);
			}
			return out;
		};
		const ensureToolsObject = (): Record<string, unknown> => {
			const current = raw.tools;
			if (isRecord(current)) {
				return current as Record<string, unknown>;
			}
			const created: Record<string, unknown> = {};
			raw.tools = created;
			return created;
		};
		const toolsObj = raw.tools as Record<string, unknown> | undefined;
		if (toolsObj && "essentialOverride" in toolsObj) {
			toolsObj.essentialOverride = migrateToolNameList(toolsObj.essentialOverride);
		}
		if ("tools.essentialOverride" in raw) {
			const nestedToolsObj = ensureToolsObject();
			if (!("essentialOverride" in nestedToolsObj)) {
				nestedToolsObj.essentialOverride = migrateToolNameList(raw["tools.essentialOverride"]);
			}
			delete raw["tools.essentialOverride"];
		}

		// Also clean up any empty nested objects we might have created or left behind
		if (raw.glob && typeof raw.glob === "object" && Object.keys(raw.glob).length === 0) {
			delete raw.glob;
		}
		if (raw.grep && typeof raw.grep === "object" && Object.keys(raw.grep).length === 0) {
			delete raw.grep;
		}
		// readHashLines: removed. Hashline anchors are now driven solely by
		// edit.mode === "hashline"; the separate read toggle only ever produced
		// the incoherent "hashline edits without addressable anchors" state.
		delete raw.readHashLines;

		// serviceTier (single enum with scoped openai-only/claude-only sentinels)
		// → per-family tier.openai/tier.anthropic/tier.google; serviceTierSubagent
		// → tier.subagent; serviceTierAdvisor → tier.advisor. `fastModeScope` is
		// dropped — per-family scoping is now expressed by the three tier settings.
		const tierObj = isRecord(raw.tier) ? raw.tier : {};
		let tierTouched = false;
		const setTier = (family: string, value: unknown): void => {
			if (value !== undefined && !(family in tierObj)) {
				tierObj[family] = value;
				tierTouched = true;
			}
		};
		if (typeof raw.serviceTier === "string") {
			switch (raw.serviceTier) {
				case "priority":
					setTier("openai", "priority");
					setTier("anthropic", "priority");
					setTier("google", "priority");
					break;
				case "openai-only":
					setTier("openai", "priority");
					break;
				case "claude-only":
					setTier("anthropic", "priority");
					break;
				case "auto":
				case "default":
				case "flex":
				case "scale":
					setTier("openai", raw.serviceTier);
					break;
			}
			delete raw.serviceTier;
		}
		const mapInheritTier = (value: unknown): unknown =>
			value === "openai-only" || value === "claude-only" ? "priority" : value;
		if ("serviceTierSubagent" in raw) {
			setTier("subagent", mapInheritTier(raw.serviceTierSubagent));
			delete raw.serviceTierSubagent;
		}
		if ("serviceTierAdvisor" in raw) {
			setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
			delete raw.serviceTierAdvisor;
		}
		if (tierTouched) raw.tier = tierObj;
		delete raw.fastModeScope;

		return raw;
	}

	/**
	 * One-time migration: seed the last-changelog-version marker file from the
	 * legacy config.yml key. An existing marker always wins — it is the newer
	 * source of truth.
	 */
	async #seedLastChangelogVersionMarker(): Promise<void> {
		const legacy = this.#legacyLastChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(this.#agentDir);
		try {
			if ((await Bun.file(markerPath).text()).trim()) return;
		} catch (error) {
			if (!isEnoent(error)) return;
		}
		try {
			await Bun.write(markerPath, legacy);
		} catch (error) {
			logger.warn("Settings: failed to seed last-changelog-version marker", { error: String(error) });
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Saving
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * The ONE place settings are written to disk.
	 *
	 * It edits the existing file as a document rather than re-serializing the settings
	 * object, so the comments, blank lines, key order and quoting the user chose survive a
	 * setting change. `config.yml` is a file people edit by hand; a save that silently
	 * reformatted it was deleting their work.
	 *
	 * The settings object stays the authority on content, so migrations and resets land
	 * exactly as they did when this was a `YAML.stringify` call.
	 */
	async #writeConfigPreservingText(configPath: string, settings: RawSettings): Promise<void> {
		let existing = "";
		try {
			existing = await Bun.file(configPath).text();
		} catch (error) {
			// A missing file is the first-write case and starts from an empty document.
			// Anything else is a read this process should not paper over: writing as if the
			// file were empty would drop every comment and every externally-added key in it.
			if (!isEnoent(error)) throw error;
		}
		let text: string;
		try {
			text = syncYamlTextToSettings(existing, settings);
		} catch (error) {
			// The editor refuses a file it cannot parse, because overwriting it would
			// destroy content nothing else preserved. There is exactly one case where the
			// content HAS been preserved: the loader already copied this file to its
			// `.corrupt` sibling, and the user's change has to be able to land. Then a
			// fresh serialization is the right answer, and it is announced with the path
			// to the rescued copy rather than done quietly (Law 10).
			const rescued = this.#quarantined.find(entry => entry.path === configPath);
			if (!rescued) throw error;
			logger.warn("Settings: rewriting a config file that could not be parsed; the original was preserved", {
				path: configPath,
				preservedAt: rescued.quarantinePath,
				reason: errorMessage(error),
			});
			text = YAML.stringify(settings, null, 2);
		}
		await atomicWriteFile(configPath, text);
	}

	/**
	 * Count a failed save, and tell the operator once the retries are spent.
	 *
	 * The first failures stay quiet on purpose: a lost race with a concurrent writer is
	 * normal and the retry fixes it. A run of them is a broken filesystem or a config path
	 * that is not writable, and that has to reach the user rather than a debug log.
	 */
	#recordSaveFailure(configPath: string, error: unknown): void {
		const reason = errorMessage(error);
		const attempts = (this.#saveFailure?.path === configPath ? this.#saveFailure.attempts : 0) + 1;
		this.#saveFailure = { path: configPath, reason, attempts };
		if (attempts !== SAVE_FAILURE_REPORT_AFTER) return;
		// Exactly at the threshold, so a filesystem that stays broken reports once rather
		// than on every retry for the rest of the session.
		const failure: SettingsSaveFailure = { path: configPath, reason, attempts };
		for (const listener of this.#saveFailureListeners) {
			try {
				listener(failure);
			} catch (listenerError) {
				logger.warn("Settings: a save-failure listener threw", { error: errorMessage(listenerError) });
			}
		}
	}

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

		// Debounce: wait 100ms for more changes
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
		}
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			this.#saveNow().catch(err => {
				logger.warn("Settings: background save failed", { error: String(err) });
			});
		}, 100);
	}

	async #saveNow(): Promise<void> {
		if (!this.#persist || !this.#configPath || this.#modified.size === 0) return;

		const configPath = this.#configPath;
		const modifiedPaths = [...this.#modified];
		this.#modified.clear();

		try {
			await withFileLock(configPath, async () => {
				// Re-read to preserve external changes
				const current = await this.#loadYaml(configPath);

				// Apply only our modified paths
				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const value = getByPath(this.#global, segments);
					setByPath(current, segments, value);
				}

				// Update our global with any external changes we preserved
				this.#global = current;
				await this.#writeConfigPreservingText(configPath, this.#global);
			});
			// The file took the write, so whatever was wrong is over.
			this.#saveFailure = undefined;
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
			// Re-add failed paths for retry
			for (const p of modifiedPaths) {
				this.#modified.add(p);
			}
			this.#recordSaveFailure(configPath, error);
		}

		this.#rebuildMerged();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	#rebuildMerged(): void {
		this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#project);
		this.#merged = this.#deepMerge(this.#merged, this.#configOverlay);
		this.#merged = this.#deepMerge(this.#merged, this.#overrides);
		this.#resolvedCache.clear();
		this.#editVariantCache = undefined;
	}

	#fireAllHooks(): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = this.get(key);
				hook(value, value);
			}
		}
	}

	#deepMerge(base: RawSettings, overrides: RawSettings): RawSettings {
		const result = { ...base };
		for (const key of Object.keys(overrides)) {
			const override = overrides[key];
			const baseVal = base[key];

			if (override === undefined) continue;

			if (
				typeof override === "object" &&
				override !== null &&
				!Array.isArray(override) &&
				typeof baseVal === "object" &&
				baseVal !== null &&
				!Array.isArray(baseVal)
			) {
				result[key] = this.#deepMerge(baseVal as RawSettings, override as RawSettings);
			} else {
				result[key] = override;
			}
		}
		return result;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

/**
 * Minimal change-notification primitive backing the exported `on*Changed`
 * subscriptions. Holds a listener set, hands out unsubscribe closures, and
 * isolates errors so a single throwing listener can't abort the rest or bubble
 * out of `Settings.set()`.
 *
 * @typeParam A - argument tuple forwarded to each listener on `fire`.
 */
class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {}

	/** Subscribe `cb`; returns an unsubscribe function. */
	on(cb: (...args: A) => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	/**
	 * Invoke every listener with `args`. Iterates a snapshot so a listener may
	 * (un)subscribe mid-fire without re-entrancy — the Hindsight backend
	 * re-registers the fresh state's listener on every rebuild — and wraps each
	 * call so a throwing listener is logged and skipped instead of aborting the
	 * rest.
	 */
	fire(...args: A): void {
		for (const cb of [...this.#listeners]) {
			try {
				cb(...args);
			} catch (err) {
				logger.warn(`Settings: ${this.label} hook failed`, { error: String(err) });
			}
		}
	}
}

const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
	"theme.dark": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			setAutoThemeMapping("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			setSymbolPreset(value)
				.then(result => {
					// The preset applied, but re-rendering the committed theme fell
					// back — record which theme is actually on screen now.
					if (result.fellBack) {
						logger.warn("Settings: symbolPreset applied but the theme fell back", {
							preset: value,
							error: result.error,
						});
					}
				})
				.catch(err => {
					logger.warn("Settings: symbolPreset hook failed", { preset: value, error: String(err) });
				});
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			setColorBlindMode(value)
				.then(result => {
					if (result.fellBack) {
						logger.warn("Settings: colorBlindMode applied but the theme fell back", {
							enabled: value,
							error: result.error,
						});
					}
				})
				.catch(err => {
					logger.warn("Settings: colorBlindMode hook failed", { enabled: value, error: String(err) });
				});
		}
	},
	"provider.appendOnlyContext": value => {
		if (typeof value === "string") {
			appendOnlyModeSignal.fire(value);
		}
	},
	"providers.maxInFlightRequests": value => {
		configureProviderMaxInFlightRequests(validateProviderMaxInFlightRequests(value));
	},
	"hindsight.bankId": () => hindsightScopeSignal.fire(),
	"hindsight.bankIdPrefix": () => hindsightScopeSignal.fire(),
	"hindsight.scoping": () => hindsightScopeSignal.fire(),
	"worktree.base": value => {
		const dir = typeof value === "string" && value.trim() ? value : undefined;
		// Always call so an unset/empty value clears a previously-applied override.
		// setWorktreesDir expands `~`, rejects relative paths, and returns the
		// applied absolute path (or undefined when cleared/rejected).
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};
/** Fires when `provider.appendOnlyContext` changes at runtime. */
const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

/**
 * Subscribe to append-only mode setting changes.
 * Returns an unsubscribe function. Multiple sessions (main + subagents)
 * can register independently without overwriting each other.
 */
export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

/** Fires when any model role changes at runtime. */
const modelRolesSignal = new SettingSignal("modelRoles");

/** Subscribe to model role changes. Returns an unsubscribe function. */
export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

/** Fires when `statusLine.sessionAccent` changes at runtime. */
const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

/**
 * Subscribe to session-accent setting changes.
 * Returns an unsubscribe function. Callers should re-read settings in the callback.
 */
export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

/** Fires when any `hindsight.bankId` / `bankIdPrefix` / `scoping` value changes. */
const hindsightScopeSignal = new SettingSignal("hindsight scope");

/**
 * Subscribe to changes in the Hindsight bank-scoping settings. Lets the
 * Hindsight backend rebuild the active `HindsightSessionState` when the
 * operator switches `hindsight.bankId`, `hindsight.bankIdPrefix`, or
 * `hindsight.scoping` mid-session so subsequent retain/recall calls land in
 * the new bank instead of the one selected at session start.
 *
 * Returns an unsubscribe function. The callback receives no arguments — the
 * caller is expected to re-read the relevant settings via `Settings.get`.
 */
export const onHindsightScopeChanged = (cb: () => void) => hindsightScopeSignal.on(cb);

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

function clearBoundSettingsMethods(): void {
	boundSettingsInstance = null;
	boundSettingsMethods = new Map<PropertyKey, unknown>();
}

export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/**
 * Reset the global singleton for testing.
 * @internal
 */
export function resetSettingsForTest(): void {
	globalInstance = null;
	globalInstancePromise = null;
	clearBoundSettingsMethods();
	configureProviderMaxInFlightRequests(undefined);
}

/**
 * The global settings singleton.
 * Must call `Settings.init()` before using.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		if (!globalInstance) {
			throw new Error("Settings not initialized. Call Settings.init() first.");
		}
		if (boundSettingsInstance !== globalInstance) {
			clearBoundSettingsMethods();
			boundSettingsInstance = globalInstance;
		}
		const value = (globalInstance as unknown as Record<PropertyKey, unknown>)[prop];
		if (typeof value === "function") {
			const cached = boundSettingsMethods.get(prop);
			if (cached) return cached;
			const bound = value.bind(globalInstance);
			boundSettingsMethods.set(prop, bound);
			return bound;
		}
		return value;
	},
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
