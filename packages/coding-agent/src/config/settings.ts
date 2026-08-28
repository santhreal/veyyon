/** Settings singleton with sync get/set and background persistence. */

import * as fs from "node:fs";
import * as path from "node:path";
// this setter and importing it there cost 285 modules for one function; ~530 test files import
// `Settings`, so this file's graph is the most leveraged one in the package.
import { configureProviderMaxInFlightRequests } from "@veyyon/ai/provider-inflight-limits";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import {
	findShadowedGlobalConfigFiles,
	getAgentDbPath,
	getAgentDir,
	getGlobalConfigFilePath,
	getLastChangelogVersionPath,
	getProjectDir,
	MAIN_CONFIG_FILENAMES,
	setWorktreesDir,
} from "@veyyon/utils/dirs";
import { withFileLock } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { expandTilde } from "@veyyon/utils/path";
import * as procmgr from "@veyyon/utils/procmgr";
import { type QuarantinedFile, quarantineUnparseableFile } from "@veyyon/utils/quarantine-file";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import { JSONC, YAML } from "bun";
import type { ModelRole } from "../config/model-roles";
import { isLightTheme } from "../modes/theme/theme-luminance";
import { AgentStorage } from "../session/agent-storage";
import { normalizeToolName } from "../tools/builtin-names";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { migrateCompactionStrategyValue } from "./compaction-strategy";
import { UNSET_NUMBER } from "./optional-number";
import { GLOBAL_SETTING_BINDINGS } from "./settings-domains/global";
import {
	runSettingsTestResetHooks,
	setSettingsInstance,
	setSettingsInstancePromise,
	settingsInstancePromise,
	settingsOrThrow,
} from "./settings-instance";
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

export type * from "./settings-schema";
export * from "./settings-schema";

/** Raw settings object as stored in YAML */
export interface RawSettings {
	[key: string]: unknown;
}

/** A settings file that failed to parse, and where its bytes were preserved. */
export type QuarantinedSettingsFile = QuarantinedFile;

/** A config file this session repeatedly could not write, and why. */
export interface SettingsSaveFailure {
	path: string;
	reason: string;
	attempts: number;
}

/** Consecutive failed saves before reporting to user. */
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

/** Layer that currently supplies a setting's effective value. */
export type SettingSource = "default" | "profile" | "config-file" | "runtime" | "global";

export interface SettingsOptions {
	/** Current working directory, used to resolve path-scoped settings */
	cwd?: string;
	/** Agent directory for config.yml/config.yaml storage */
	agentDir?: string;
	/** Don't persist to disk (for tests) */
	inMemory?: boolean;
	/** Read config sources without opening storage or writing migrations */
	readOnly?: boolean;
	/** Initial overrides */
	overrides?: Partial<Record<SettingPath, unknown>>;
	/** Extra config.yml-style overlays loaded after the profile settings */
	configFiles?: string[];
}

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

/** Paths that store optional numeric values where absent means unset. */

/** Migration version numbers for one-shot settings migrations. */
export const SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY = 1;
export const SETTINGS_MIGRATION_VERSION = SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY;

/** Represents an unreadable config file. */
class UnreadableConfig {
	constructor(readonly cause: unknown) {}
}

/** Current migration version in raw settings. */
function appliedMigrationVersion(raw: RawSettings): number {
	return typeof raw.settingsMigrationVersion === "number" ? raw.settingsMigrationVersion : 0;
}

/** Drop legacy unset sentinels from raw settings in memory. */
export function stripLegacyUnsetSentinels(raw: RawSettings): string[] {
	if (appliedMigrationVersion(raw) >= SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY) return [];
	const removed: string[] = [];
	for (const segments of LEGACY_UNSET_SENTINEL_PATHS) {
		if (getByPath(raw, segments) !== UNSET_NUMBER) continue;
		deleteByPath(raw, segments);
		removed.push(segments.join("."));
	}
	return removed;
}

/** Commit one-shot migrations and stamp version. */
export function stampOwnedConfigMigrations(raw: RawSettings): string[] {
	const changed = stripLegacyUnsetSentinels(raw);
	if (appliedMigrationVersion(raw) < SETTINGS_MIGRATION_VERSION) {
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

/** Delete a nested value by path segments. */
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

/** Threshold to detect legacy millisecond timeouts in `ask.timeout`. */
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
		for (let vi = 0; vi < values.length; vi++) resolved.push(values[vi]!);
	}

	return resolved;
}

export class Settings {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	#storage: AgentStorage | null = null;

	#configFiles: string[] = [];
	/** Global settings from config.yml/config.yaml */
	#global: RawSettings = {};
	/** Extra config.yml-style overlays passed by CLI */
	#configOverlay: RawSettings = {};
	/** Runtime overrides (not persisted) */
	#overrides: RawSettings = {};
	/** Runtime forks must not apply project-scoped hooks to their parent process. */
	#activateProcessHooks = true;
	/** Settings files that could not be parsed, and where their bytes were kept. */
	#quarantined: QuarantinedSettingsFile[] = [];
	/** Consecutive failed saves of one config file, and why the last one failed. */
	#saveFailure: { path: string; reason: string; attempts: number } | undefined;
	/** Previously announced failure to replay to late subscribers. */
	#reportedSaveFailure: SettingsSaveFailure | undefined;
	/** Told when a save has failed often enough that the user has to hear about it. */
	#saveFailureListeners = new Set<(failure: SettingsSaveFailure) => void>();
	#effectiveSettingListeners = new Set<(path: SettingPath, value: unknown, previous: unknown) => void>();
	/** Configured values whose type contradicts the schema, found during load. */
	#invalidValues: InvalidSettingValue[] = [];
	/** Merged view (profile + config overlays + overrides) */
	#merged: RawSettings = {};
	/** Cached resolved values from the merged view, including defaults/path scoping */
	#resolvedCache = new Map<SettingPath, unknown>();
	#editVariantCache: readonly EditVariantEntry[] | undefined;

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();
	/** Legacy unset sentinels awaiting removal on next write. */
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

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		const inFlight = settingsInstancePromise();
		if (inFlight) return inFlight;

		// interchangeable: the bare load settles first, so a second caller awaiting it could resume before
		// `globalInstance` was set and see `isSettingsInitialized()` return false straight after `await
		// Settings.init()`. Recording the derived promise also makes `init()` return the same object every
		// time, which is what makes "a second init joins the first" checkable rather than merely likely.
		const instance = new Settings(options);
		const ready = instance.#load().then(
			loaded => {
				setSettingsInstance(loaded);
				return loaded;
			},
			error => {
				setSettingsInstance(null);
				setSettingsInstancePromise(null);
				throw error;
			},
		);
		setSettingsInstancePromise(ready);
		return ready;
	}

	/** Load effective settings in read-only mode without opening storage. */
	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.#loadReadOnly();
	}

	/** Load a persisted settings instance. */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	/** Create an isolated instance for testing. */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#rebuildMerged();
		return instance;
	}

	/** Get the global singleton. Throws if not initialized. */
	static get instance(): Settings {
		return settingsOrThrow();
	}

	/** Get a setting value (sync). */
	get<P extends SettingPath>(path: P): SettingValue<P> {
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

	/** Settings files that could not be parsed during load. */
	get quarantinedFiles(): readonly QuarantinedSettingsFile[] {
		return this.#quarantined;
	}

	/** The active save failure when threshold is exceeded. */
	get saveFailure(): SettingsSaveFailure | undefined {
		if (!this.#saveFailure) return undefined;
		const { path: failedPath, reason, attempts } = this.#saveFailure;
		if (attempts < SAVE_FAILURE_REPORT_AFTER) return undefined;
		return { path: failedPath, reason, attempts };
	}

	/** The last save error on this instance without retry threshold. */
	get lastSaveError(): { path: string; reason: string } | undefined {
		if (!this.#saveFailure) return undefined;
		return { path: this.#saveFailure.path, reason: this.#saveFailure.reason };
	}

	/** Subscribe to save failure notifications. Returns unsubscribe function. */
	onSaveFailure(listener: (failure: SettingsSaveFailure) => void): () => void {
		this.#saveFailureListeners.add(listener);
		// promotion writes the global config during startup, before the interactive
		// mode exists to subscribe, so its refusal would otherwise be announced to an
		// empty set and never mentioned again, which is the silence this whole path
		// exists to end.
		if (this.#reportedSaveFailure) this.#deliverSaveFailure(listener, this.#reportedSaveFailure);
		return () => {
			this.#saveFailureListeners.delete(listener);
		};
	}

	onEffectiveSettingChanged(listener: (path: SettingPath, value: unknown, previous: unknown) => void): () => void {
		this.#effectiveSettingListeners.add(listener);
		return () => {
			this.#effectiveSettingListeners.delete(listener);
		};
	}

	/** Configured settings whose value contradicts schema types. */
	get invalidValues(): readonly InvalidSettingValue[] {
		return this.#invalidValues;
	}

	/** Whether `path` has an explicitly configured value. */
	isConfigured(path: SettingPath): boolean {
		// Global-scoped paths are not in the profile-merged tree; treat a value that
		// differs from the schema default as explicitly configured.
		if (GLOBAL_SETTING_BINDINGS[path]) {
			return !Object.is(this.get(path), getDefault(path));
		}
		return getByPath(this.#merged, SETTING_PATH_SEGMENTS[path] ?? path.split(".")) !== undefined;
	}

	/** Identify the highest-precedence layer supplying `path`. */
	getSource(path: string): SettingSource {
		const segments = SETTING_PATH_SEGMENTS[path as SettingPath] ?? path.split(".");
		if (getByPath(this.#overrides, segments) !== undefined) return "runtime";
		if (GLOBAL_SETTING_BINDINGS[path]) {
			return this.isConfigured(path as SettingPath) ? "global" : "default";
		}
		if (getByPath(this.#configOverlay, segments) !== undefined) return "config-file";
		if (getByPath(this.#global, segments) !== undefined) return "profile";
		return "default";
	}

	/** Set a setting value (sync). */
	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);

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
					this.#recordGlobalWriteFailure(error);
					return;
				}
				this.#clearGlobalWriteFailure();
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

	/** Return a setting to its default by removing the key. */
	unset(path: SettingPath): void {
		const prev = this.get(path);

		const globalBinding = GLOBAL_SETTING_BINDINGS[path];
		if (globalBinding) {
			if (this.#persist) {
				try {
					globalBinding.write(undefined);
				} catch (error) {
					logger.warn("Settings: global unset rejected; value not cleared", { path, error: String(error) });
					this.#recordGlobalWriteFailure(error);
					return;
				}
				this.#clearGlobalWriteFailure();
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

	/** Stamp one-shot migrations for governed paths. */
	#stampOwnedMigrationsFor(path: SettingPath): void {
		if (!isUnsetNumberPath(path)) return;
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

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown, applyProcessHooks = true): void {
		if (Object.is(value, prev)) return;
		for (const listener of this.#effectiveSettingListeners) listener(path, value, prev);
		if (!applyProcessHooks || !this.#activateProcessHooks) return;
		if (path === "statusLine.sessionAccent") {
			statusLineSessionAccentSignal.fire();
		}
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
	}

	/** Flush any pending saves to disk. */
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

	/** Create a non-persisting runtime fork preserving layer provenance. */
	forkWithRuntimeOverrides(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const forked = new Settings({
			cwd: this.#cwd,
			agentDir: this.#agentDir,
			inMemory: true,
		});
		forked.#activateProcessHooks = false;
		forked.#configFiles = this.#configFiles.slice();
		forked.#global = structuredClone(this.#global);
		forked.#configOverlay = structuredClone(this.#configOverlay);
		forked.#overrides = structuredClone(this.#overrides);
		for (const [settingPath, value] of Object.entries(overrides)) {
			setByPath(forked.#overrides, settingPath.split("."), value);
		}
		forked.#overrides = forked.#migrateRawSettings(forked.#overrides);
		forked.#rebuildMerged();
		return forked;
	}

	async cloneForCwd(cwd: string): Promise<Settings> {
		const cloned = new Settings({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#storage = this.#storage;
		cloned.#configPath = this.#configPath;
		cloned.#activateProcessHooks = this.#activateProcessHooks;
		cloned.#global = structuredClone(this.#global);
		cloned.#configFiles = this.#configFiles.slice();
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		cloned.#overrides = structuredClone(this.#overrides);
		cloned.#rebuildMerged();
		cloned.#fireAllHooks();
		return cloned;
	}

	/** Re-scope this instance to a new working directory in place. */
	async reloadForCwd(cwd: string): Promise<void> {
		const normalized = path.normalize(cwd);
		if (normalized === this.#cwd) return;
		const settingPaths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];
		const previousValues = new Map(settingPaths.map(settingPath => [settingPath, this.get(settingPath)]));
		this.#cwd = normalized;
		this.#rebuildMerged();
		for (const settingPath of settingPaths) {
			this.#fireEffectiveSettingChanged(settingPath, this.get(settingPath), previousValues.get(settingPath));
		}
		this.#fireAllHooks();
	}

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

	/** Resolve all known settings to their effective values. */
	getEffectiveSnapshot(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const key of (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).sort()) {
			result[key] = this.get(key);
		}
		return result;
	}

	/** Get edit variant for a specific model. */
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

		const value = this.get("edit.modelVariants");
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

	#modelRoleFromLayer(layer: RawSettings, role: ModelRole | string): string | undefined {
		const value = getByPath(layer, ["modelRoles"]);
		if (!isRecord(value)) return undefined;
		return modelRoleValueFromUnknown(value[role]);
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

	/** Return one role from the profile layer, excluding project and runtime overrides. */
	getPersistedModelRole(role: ModelRole | string): string | undefined {
		return this.#modelRoleFromLayer(this.#global, role);
	}

	/** Identify the layer that supplies one effective model-role slot. */
	getModelRoleSource(role: ModelRole | string): SettingSource {
		if (this.#modelRoleFromLayer(this.#overrides, role) !== undefined) return "runtime";
		if (this.#modelRoleFromLayer(this.#configOverlay, role) !== undefined) return "config-file";
		if (this.#modelRoleFromLayer(this.#global, role) !== undefined) return "profile";
		return "default";
	}

	/** Persist one profile role without rewriting higher-precedence overrides. */
	setPersistedModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer(this.#global);
		if (modelId === undefined) delete current[role];
		else current[role] = modelId;
		this.set("modelRoles", current);
	}

	/** Set a model role. */
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

	/** Override model roles. */
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

	async #load(): Promise<Settings> {
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
			// stamped here: the stamp goes in when one of those paths is written (see
			// stampOwnedConfigMigrations), so an upgrade does not add a line to every
			// config on disk, and a `-1` written by this version is still safe from
			// the next load.
			this.#pendingSentinelStrips = stripLegacyUnsetSentinels(this.#global);
		}

		this.#configOverlay = await this.#loadConfigOverlays();
		this.#collectInvalidValues(this.#global, this.#configPath ?? "");
		this.#reportShadowedConfigFiles();

		// Build merged view (profile → config overlays → overrides)
		this.#rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

	async #loadReadOnly(): Promise<Settings> {
		const existingConfig = await this.#loadExistingMainYaml();
		if (existingConfig) {
			this.#global = existingConfig;
		}

		this.#configOverlay = await this.#loadConfigOverlays();
		this.#collectInvalidValues(this.#global, this.#configPath ?? "");
		this.#rebuildMerged();
		return this;
	}

	/** Warn about shadowed config files. */
	#reportShadowedConfigFiles(): void {
		for (const shadowed of findShadowedGlobalConfigFiles()) {
			logger.warn("Global config file is being ignored because a higher-precedence one exists", {
				ignored: shadowed.ignored,
				using: shadowed.using,
				fix: `merge ${path.basename(shadowed.ignored)} into ${path.basename(shadowed.using)} and delete it`,
			});
		}
	}

	/** Collect invalid setting values found in a config tree. */
	#collectInvalidValues(tree: RawSettings, file: string): void {
		if (!file) return;
		for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const value = getByPath(tree, SETTING_PATH_SEGMENTS[path] ?? path.split("."));
			if (value === undefined) continue;
			const reason = describeSettingTypeMismatch(path, value);
			if (reason === undefined) continue;
			if (this.#invalidValues.some(entry => entry.path === path && entry.file === file)) continue;
			this.#invalidValues.push({ path, file, reason });
			// developer reading a session afterwards, the accessor is for a surface
			// that can actually put it in front of the person who wrote the file.
			logger.warn("Settings: configured value does not match its declared type", { file, reason });
		}
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresent(filePath);
		if (loaded instanceof UnreadableConfig) return {};
		return loaded ?? {};
	}

	/** Re-read a config file for saving. */
	async #loadYamlForSave(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresent(filePath);
		if (loaded instanceof UnreadableConfig) throw loaded.cause;
		return loaded ?? {};
	}

	async #loadYamlIfPresent(filePath: string): Promise<RawSettings | null | UnreadableConfig> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			if (isEnoent(error)) return null;
			logger.warn("Settings: failed to load", { path: filePath, error: String(error) });
			return new UnreadableConfig(error);
		}

		try {
			const parsed = YAML.parse(content);
			// A blank or comments-only file parses to null/undefined: that is a
			// legitimately empty settings file, so an empty view is the truth.
			if (parsed === null || parsed === undefined) {
				return {};
			}
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

	/** Quarantine an unparseable settings file. */
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
			if (loaded instanceof UnreadableConfig) {
				// read failed. Falling through to the next candidate would start
				// writing a different file and strand the operator's real one.
				this.#configPath = configPath;
				return {};
			}
			if (loaded) {
				this.#configPath = configPath;
				return loaded;
			}
		}
		this.#configPath = path.join(this.#agentDir, MAIN_CONFIG_FILENAMES[0]);
		return null;
	}

	async #loadConfigOverlays(): Promise<RawSettings> {
		let merged: RawSettings = {};
		for (const filePath of this.#configFiles) {
			merged = this.#deepMerge(merged, await this.#loadOverlayYaml(filePath));
		}
		return merged;
	}

	/** Load a CLI config overlay file. */
	async #loadOverlayYaml(filePath: string): Promise<RawSettings> {
		let content: string;
		try {
			content = await Bun.file(filePath).text();
		} catch (error) {
			throw new Error(
				isEnoent(error)
					? `Config overlay not found: ${filePath}`
					: `Failed to read config overlay ${filePath}: ${errorMessage(error)}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = YAML.parse(content);
		} catch (error) {
			throw new Error(`Failed to parse config overlay ${filePath}: ${errorMessage(error)}`);
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

		if (migrated && Object.keys(settings).length > 0) {
			try {
				await this.#writeConfigPreservingText(this.#configPath, settings);
				logger.debug("Settings: migrated to config.yml", { path: this.#configPath });
			} catch (error) {
				// the migrated settings are lost for this run. Surface it loudly
				// rather than silently discarding the user's settings (Law 10).
				logger.warn("Settings: migrated settings could not be written to config.yml", {
					path: this.#configPath,
					error: errorMessage(error),
				});
			}
		}
	}

	/** Report ask.timeout migration once per process. */
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
				// it wins. The flat one is dropped, and never silently: the operator wrote
				// two values for one setting and needs to know which one is live.
				this.#reportDottedKeyProblem(
					`Settings: "${key}" is set twice, flat and nested. The nested value is used and the flat key is dropped.`,
					{ key, used: nested, dropped: flat },
				);
				continue;
			}
			setByPath(raw, segments.slice(), flat);
		}
	}

	/** Report a dotted-key problem once per message per process. */
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

	/** Fold legacy subagent/task keys to subagent.* */
	#migrateSubagentSettings(raw: RawSettings): void {
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
			// bottom value lands on `allowed`: someone with eager delegation switched
			// off still delegated by hand, and taking the task tool away would change
			// what their sessions can do.
			const delegation = eager === "always" ? "required" : eager === "preferred" ? "preferred" : "allowed";
			setNew(["delegation"], delegation);
		}

		// existed, so one setting answered two questions: whether subagents exist, and
		// how hard to push them. Someone who wrote `off` was turning subagents OFF —
		// that is the half to preserve — so it becomes `enabled: false` and the
		// strength falls back to its default, ready for when they turn it back on.
		// Deleted rather than left in place because `off` is no longer a legal value:
		// leaving it would fail validation and read as a corrupt config.
		if (read(["subagent", "delegation"]) === "off") {
			deleteByPath(raw, ["subagent", "delegation"]);
			if (read(["subagent", "enabled"]) === undefined) {
				setByPath(raw, ["subagent", "enabled"], false);
			}
		}

		for (const [legacy, next] of [
			["batch", "batch"],
			["maxConcurrency", "maxConcurrency"],
			["enableLsp", "enableLsp"],
			["maxRuntimeMs", "maxRuntimeMs"],
			["agentIdleTtlMs", "idleTtlMs"],
			["softRequestBudget", "softRequestBudget"],
			["softRequestBudgetNotice", "softRequestBudgetNotice"],
			["showResolvedModelBadge", "showResolvedModelBadge"],
		] as const) {
			setNew([next], take(["task", legacy]));
		}

		// nested subagent levels, so old 1 becomes new 0. Old 0 disabled even the
		// root task tool; preserve that behavior through the dedicated master
		// switch. Both legacy paths are consumed, with the newer subagent path
		// winning when a file somehow contains both.
		const legacyTaskDepth = take(["task", "maxRecursionDepth"]);
		const legacySubagentDepth = take(["subagent", "maxRecursionDepth"]);
		const legacyDepth = legacySubagentDepth ?? legacyTaskDepth;
		if (legacyDepth !== undefined) {
			if (legacyDepth === 0) setByPath(raw, ["subagent", "enabled"], false);
			const nestedDepth =
				typeof legacyDepth === "number" && Number.isInteger(legacyDepth)
					? legacyDepth < 0
						? -1
						: Math.max(0, legacyDepth - 1)
					: legacyDepth;
			setNew(["maxNestedSpawnDepth"], nestedDepth);
		}

		// task.isolation.* -> subagent.isolation.*
		for (const key of ["mode", "merge", "commits"] as const) {
			setNew(["isolation", key], take(["task", "isolation", key]));
		}

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
		// subagent model question, above the blanket setting and invisible from it,
		// and they are gone; writing them into the new section would only recreate
		// the drift in a new spelling. Folding them into `subagent.model` instead is
		// not available either — several agents could name several models and there
		// is no honest way to pick one. So the values are dropped and named, once,
		// with the setting that replaced them.
		const overrides = take(["task", "agentModelOverrides"]);
		if (isRecord(overrides)) {
			const dropped = Object.entries(overrides)
				.filter(([, model]) => typeof model === "string" && model.trim().length > 0)
				.map(([name, model]) => `${name}=${String(model).trim()}`);
			if (dropped.length > 0) {
				logger.warn(
					`Settings: task.agentModelOverrides (${dropped.join(", ")}) is no longer read — per-agent models were ` +
						`unified into one subagent model setting. Set Subagents → Subagent Model, or give the agent file its ` +
						`own \`model:\` frontmatter.`,
					{ setting: "task.agentModelOverrides", dropped },
				);
			}
		}
		// `disabledAgents` is the only legacy map with a home in the new section, so a
		// row written here carries exactly one fact: whether the agent runs.
		if (Object.keys(agents).length > 0) setNew(["agents"], agents);

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

	/** Apply schema migrations to raw settings. */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// Both spellings of a key mean the same thing, and only the nested one used
		// to be readable. Runs FIRST so every migration below sees one shape.
		this.#expandDottedSettingKeys(raw);

		this.#migrateQueueMode(raw);
		this.#migrateLastChangelogVersion(raw);
		this.#migrateCollapseChangelog(raw);
		this.#migrateAskTimeout(raw);
		this.#migrateCompactionThreshold(raw);
		this.#migrateThemeString(raw);
		this.#migrateTaskIsolation(raw);
		this.#migrateTaskSimple(raw);
		this.#migrateTaskEager(raw);
		this.#migrateTaskIsolationMode(raw);
		this.#migrateSubagentSettings(raw);
		this.#migrateEditMode(raw);
		this.#migrateCompactionStrategy(raw);
		this.#migrateCompactionModel(raw);
		this.#migrateModelOverridesCompactionModel(raw);
		this.#migrateCycleOrder(raw);
		this.#migrateSnapcompact(raw);
		this.#migrateInlineToolDescriptors(raw);
		this.#migrateStatusLinePlanMode(raw);
		this.#migrateProvidersParallelFetch(raw);
		this.#migrateCodexResetsAutoRedeem(raw);
		this.#migrateMemoryBackend(raw);
		this.#migrateMnemosyneRename(raw);
		this.#migrateHindsight(raw);
		this.#migratePowerSleepPrevention(raw);
		this.#migrateSearchFindRename(raw);
		this.#migrateToolNameLists(raw);
		this.#migrateReadHashLines(raw);
		this.#migrateServiceTier(raw);
		this.#migrateArgotEncode(raw);

		return raw;
	}

	#migrateQueueMode(raw: RawSettings): void {
		// queueMode -> steeringMode
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}
	}

	#migrateLastChangelogVersion(raw: RawSettings): void {
		// <agentDir>/last-changelog-version marker file so version bumps no
		// longer dirty user-tracked configs. Capture for marker seeding (see
		// #seedLastChangelogVersionMarker), then strip the key — the next
		// config save drops it from disk.
		if (typeof raw.lastChangelogVersion === "string") {
			this.#legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;
	}

	#migrateCollapseChangelog(raw: RawSettings): void {
		// terminal. Startup no longer prints release notes at all — it prints one
		// line and `/changelog` opens them on the web — so the old key has no
		// behavior left to control. Drop it rather than leave a toggle that does
		// nothing; `startup.updateNotice` governs the line that replaced it.
		delete raw.collapseChangelog;
	}

	#migrateAskTimeout(raw: RawSettings): void {
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
	}

	#migrateCompactionThreshold(raw: RawSettings): void {
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
	}

	#migrateThemeString(raw: RawSettings): void {
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
	}

	#migrateTaskIsolation(raw: RawSettings): void {
		// task.isolation.enabled (boolean) -> task.isolation.mode (enum)
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
		if (isolationObj && "enabled" in isolationObj) {
			if (typeof isolationObj.enabled === "boolean") {
				isolationObj.mode = isolationObj.enabled ? "auto" : "none";
			}
			delete isolationObj.enabled;
		}
	}

	#migrateTaskSimple(raw: RawSettings): void {
		// schema (workflows drive structured output via eval agent()) and the
		// batch/context shape is gated by task.batch instead.
		const taskObj = raw.task as Record<string, unknown> | undefined;
		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}
	}

	#migrateTaskEager(raw: RawSettings): void {
		// task.eager / todo.eager: boolean -> enum (default | preferred | always).
		// `true` reproduced the previous "on" behavior, which is now `always`.
		const taskObj = raw.task as Record<string, unknown> | undefined;
		if (taskObj && typeof taskObj.eager === "boolean") {
			taskObj.eager = taskObj.eager ? "always" : "default";
		}
		const todoObj = raw.todo as Record<string, unknown> | undefined;
		if (todoObj && typeof todoObj.eager === "boolean") {
			todoObj.eager = todoObj.eager ? "always" : "default";
		}
	}

	#migrateTaskIsolationMode(raw: RawSettings): void {
		// `worktree` was git worktree → now lives under `rcopy`. `fuse-overlay`
		// and `fuse-projfs` are now the platform-named `overlayfs` / `projfs`
		// kinds; the PAL falls back internally when the chosen one isn't
		// available, so we don't need the old TS-side platform guards.
		const taskObj = raw.task as Record<string, unknown> | undefined;
		const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;
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
	}

	#migrateEditMode(raw: RawSettings): void {
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
	}

	#migrateCompactionStrategy(raw: RawSettings): void {
		// compaction.strategy: collapse every legacy strategy to summary; off also disables compaction.
		const compactionObj = raw.compaction as Record<string, unknown> | undefined;
		if (compactionObj) {
			if (compactionObj.strategy === "off") {
				compactionObj.strategy = "summary";
				if (compactionObj.enabled === undefined) {
					compactionObj.enabled = false;
				}
			} else {
				const migrated =
					typeof compactionObj.strategy === "string"
						? migrateCompactionStrategyValue(compactionObj.strategy)
						: undefined;
				if (migrated) compactionObj.strategy = migrated;
			}
			if (compactionObj.compactionModel !== undefined && compactionObj.model === undefined) {
				compactionObj.model = compactionObj.compactionModel;
				delete compactionObj.compactionModel;
			}
		}
	}

	#migrateCompactionModel(raw: RawSettings): void {
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
	}

	#migrateModelOverridesCompactionModel(raw: RawSettings): void {
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
	}

	#migrateCycleOrder(raw: RawSettings): void {
		// cycleOrder: drop legacy default pseudo-role from ctrl+p order.
		const cycleOrder = raw.cycleOrder;
		if (Array.isArray(cycleOrder)) {
			raw.cycleOrder = cycleOrder.filter(role => role !== "default");
		}
	}

	#migrateSnapcompact(raw: RawSettings): void {
		// The snapcompact image-archive engine was removed; drop any persisted
		// snapcompact.* settings so schema validation does not trip on stale keys.
		delete raw.snapcompact;
		for (const key of Object.keys(raw)) {
			if (key.startsWith("snapcompact.")) delete raw[key];
		}
	}

	#migrateInlineToolDescriptors(raw: RawSettings): void {
		// `true`/`false` mapped directly onto inline-on/inline-off, so preserve
		// the user's explicit choice; new installs get the `auto` default that
		// turns it on only for Gemini models.
		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}
	}

	#migrateStatusLinePlanMode(raw: RawSettings): void {
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
	}

	#migrateProvidersParallelFetch(raw: RawSettings): void {
		// priority enum. The new default ("auto") supersedes both old values —
		// Parallel is now a deep fallback in the auto chain rather than the first
		// choice — so drop the legacy key (flat and nested) and let the enum
		// default apply.
		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];
	}

	#migrateCodexResetsAutoRedeem(raw: RawSettings): void {
		// Existing explicit false keeps the old "do not run" behavior; missing
		// config now falls through to the new "unset" default, which asks before
		// the first eligible spend.
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}
	}

	#migrateMemoryBackend(raw: RawSettings): void {
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
	}

	#migrateMnemosyneRename(raw: RawSettings): void {
		// - `memory.backend: "mnemosyne"` now selects the renamed backend.
		// - the top-level `mnemosyne` settings object becomes `mnemopi`.
		// Idempotent: skips the object move once `mnemopi` is materialised.
		const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
		if (memoryBackendObj && memoryBackendObj.backend === "mnemosyne") {
			memoryBackendObj.backend = "mnemopi";
		}
		if ("mnemosyne" in raw && !("mnemopi" in raw)) {
			raw.mnemopi = raw.mnemosyne;
			delete raw.mnemosyne;
		}
	}

	#migrateHindsight(raw: RawSettings): void {
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
	}

	#migratePowerSleepPrevention(raw: RawSettings): void {
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
	}

	#ensureRawObject(raw: RawSettings, key: "glob" | "grep"): Record<string, unknown> {
		const current = raw[key];
		if (isRecord(current)) {
			return current;
		}
		const created: Record<string, unknown> = {};
		raw[key] = created;
		return created;
	}

	#migrateSearchFindRename(raw: RawSettings): void {
		this.#migrateNestedSearchFind(raw);
		this.#migrateFlatSearchFind(raw);
		this.#cleanEmptyGlobGrep(raw);
	}

	#migrateNestedSearchFind(raw: RawSettings): void {
		// Migration for renamed settings grep.* and glob.* from search.* and find.*:
		// 1. Nested settings: find -> glob, search -> grep (per-property merge to avoid clobbering)
		if ("find" in raw) {
			const findObj = raw.find;
			if (isRecord(findObj)) {
				const globObj = this.#ensureRawObject(raw, "glob");
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
				const grepObj = this.#ensureRawObject(raw, "grep");
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
	}

	#migrateFlatSearchFind(raw: RawSettings): void {
		// 2. Flat settings keys: map them to the proper nested target so get/set resolves them correctly
		if ("find.enabled" in raw) {
			const globObj = this.#ensureRawObject(raw, "glob");
			if (!("enabled" in globObj)) {
				globObj.enabled = raw["find.enabled"];
			}
			delete raw["find.enabled"];
		}
		if ("search.enabled" in raw) {
			const grepObj = this.#ensureRawObject(raw, "grep");
			if (!("enabled" in grepObj)) {
				grepObj.enabled = raw["search.enabled"];
			}
			delete raw["search.enabled"];
		}
		if ("search.contextBefore" in raw) {
			const grepObj = this.#ensureRawObject(raw, "grep");
			if (!("contextBefore" in grepObj)) {
				grepObj.contextBefore = raw["search.contextBefore"];
			}
			delete raw["search.contextBefore"];
		}
		if ("search.contextAfter" in raw) {
			const grepObj = this.#ensureRawObject(raw, "grep");
			if (!("contextAfter" in grepObj)) {
				grepObj.contextAfter = raw["search.contextAfter"];
			}
			delete raw["search.contextAfter"];
		}
	}

	#cleanEmptyGlobGrep(raw: RawSettings): void {
		// Clean up any empty nested objects we might have created or left behind
		if (raw.glob && typeof raw.glob === "object" && Object.keys(raw.glob).length === 0) {
			delete raw.glob;
		}
		if (raw.grep && typeof raw.grep === "object" && Object.keys(raw.grep).length === 0) {
			delete raw.grep;
		}
	}

	#ensureToolsObject(raw: RawSettings): Record<string, unknown> {
		const current = raw.tools;
		if (isRecord(current)) {
			return current as Record<string, unknown>;
		}
		const created: Record<string, unknown> = {};
		raw.tools = created;
		return created;
	}

	#migrateToolNameList(names: unknown): unknown {
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
	}

	#migrateToolNameLists(raw: RawSettings): void {
		// Tool-name arrays use wire IDs too. Preserve user overrides across
		// the rename without duplicating entries if they already added grep/glob.
		const toolsObj = raw.tools as Record<string, unknown> | undefined;
		if (toolsObj && "essentialOverride" in toolsObj) {
			toolsObj.essentialOverride = this.#migrateToolNameList(toolsObj.essentialOverride);
		}
		if ("tools.essentialOverride" in raw) {
			const nestedToolsObj = this.#ensureToolsObject(raw);
			if (!("essentialOverride" in nestedToolsObj)) {
				nestedToolsObj.essentialOverride = this.#migrateToolNameList(raw["tools.essentialOverride"]);
			}
			delete raw["tools.essentialOverride"];
		}
	}

	#migrateReadHashLines(raw: RawSettings): void {
		// edit.mode === "hashline"; the separate read toggle only ever produced
		// the incoherent "hashline edits without addressable anchors" state.
		delete raw.readHashLines;
	}

	#mapInheritTier(value: unknown): unknown {
		return value === "openai-only" || value === "claude-only" ? "priority" : value;
	}

	#migrateServiceTier(raw: RawSettings): void {
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
		if ("serviceTierSubagent" in raw) {
			setTier("subagent", this.#mapInheritTier(raw.serviceTierSubagent));
			delete raw.serviceTierSubagent;
		}
		if ("serviceTierAdvisor" in raw) {
			setTier("advisor", this.#mapInheritTier(raw.serviceTierAdvisor));
			delete raw.serviceTierAdvisor;
		}
		if (tierTouched) raw.tier = tierObj;
		delete raw.fastModeScope;
	}

	#migrateArgotEncode(raw: RawSettings): void {
		//
		// The two keys that gate ENCODING are grouped under the sub-feature they
		// belong to, the way `read.summarize.*` and `bash.autoBackground.*` are.
		// They are the only two of Argot's six settings that decide whether the
		// model is taught to WRITE shorthand; `enabled`, `autoload`, `tokenBudget`
		// and `subagents` decide whether the feature runs, when a dictionary is
		// built, how large it is, and what a child agent starts with. Reading a
		// flat `argot.models` gave no hint that it governs one side of the feature
		// while decoding is unconditional, which is the distinction an operator has
		// to hold to predict what turning it off does.
		//
		// The nested spelling always wins and the flat one is dropped without being
		// read, which is what makes this a fixed point: re-running it on its own
		// output changes nothing, and it has to be, because it runs on every load of
		// every source. `argot` keeps its other keys, so no empty husk is possible.
		// Both spellings have to be folded. `#expandDottedSettingKeys` above only expands
		// REGISTERED paths, and these two are retired, so a literal `argot.models:` key
		// written flat in a config file survives it untouched and would otherwise sit in
		// the tree forever with nothing reading it.
		for (const key of ["models", "disableAboveTokens"] as const) {
			const flat = `argot.${key}`;
			if (!(flat in raw)) continue;
			if (getByPath(raw, ["argot", "encode", key]) === undefined) {
				setByPath(raw, ["argot", "encode", key], raw[flat]);
			}
			delete raw[flat];
		}

		const argotObj = raw.argot as Record<string, unknown> | undefined;
		if (argotObj) {
			for (const key of ["models", "disableAboveTokens"] as const) {
				if (!(key in argotObj)) continue;
				// stale `undefined` captured before that would make the second key replace
				// the block instead of joining it, silently dropping the first value.
				const encode = isRecord(argotObj.encode) ? argotObj.encode : {};
				if (!(key in encode)) encode[key] = argotObj[key];
				argotObj.encode = encode;
				delete argotObj[key];
			}
		}
	}

	/** Seed last-changelog-version marker file from legacy config key. */
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

	/** Write settings to disk preserving file structure and comments. */
	async #writeConfigPreservingText(configPath: string, settings: RawSettings): Promise<void> {
		let existing = "";
		try {
			existing = await Bun.file(configPath).text();
		} catch (error) {
			// Anything else is a read this process should not paper over: writing as if the
			// file were empty would drop every comment and every externally-added key in it.
			if (!isEnoent(error)) throw error;
		}
		let text: string;
		try {
			text = syncYamlTextToSettings(existing, settings);
		} catch (error) {
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

	/** Record a save failure and notify listeners when retry threshold is reached. */
	#recordSaveFailure(configPath: string, error: unknown): void {
		const reason = errorMessage(error);
		const attempts = (this.#saveFailure?.path === configPath ? this.#saveFailure.attempts : 0) + 1;
		this.#saveFailure = { path: configPath, reason, attempts };
		if (attempts !== SAVE_FAILURE_REPORT_AFTER) return;
		// Exactly at the threshold, so a filesystem that stays broken reports once rather
		// than on every retry for the rest of the session.
		this.#announceSaveFailure({ path: configPath, reason, attempts });
	}

	/** Record a global save failure. */
	#recordGlobalWriteFailure(error: unknown): void {
		const filePath = getGlobalConfigFilePath();
		const reason = errorMessage(error);
		const attempts = (this.#saveFailure?.path === filePath ? this.#saveFailure.attempts : 0) + 1;
		this.#saveFailure = { path: filePath, reason, attempts };
		if (attempts !== 1) return;
		this.#announceSaveFailure({ path: filePath, reason, attempts });
	}

	/** The global config took a write, so a failure recorded against it is over. */
	#clearGlobalWriteFailure(): void {
		// Only when a global failure is actually pending: resolving the path costs
		// filesystem probes, and a pending PROFILE failure must survive untouched.
		if (!this.#saveFailure) return;
		if (this.#saveFailure.path !== getGlobalConfigFilePath()) return;
		this.#saveFailure = undefined;
		this.#reportedSaveFailure = undefined;
	}

	/** Hand a failure to every listener, and keep it for anyone who subscribes later. */
	#announceSaveFailure(failure: SettingsSaveFailure): void {
		this.#reportedSaveFailure = failure;
		for (const listener of this.#saveFailureListeners) {
			this.#deliverSaveFailure(listener, failure);
		}
	}

	/** One listener call, isolated so a listener that throws cannot silence the rest. */
	#deliverSaveFailure(listener: (failure: SettingsSaveFailure) => void, failure: SettingsSaveFailure): void {
		try {
			listener(failure);
		} catch (listenerError) {
			logger.warn("Settings: a save-failure listener threw", { error: errorMessage(listenerError) });
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
		const modifiedPaths = Array.from(this.#modified);
		this.#modified.clear();

		try {
			await withFileLock(configPath, async () => {
				// Re-read to preserve external changes. Strict: an unreadable file
				// fails the save rather than being written over as if it were empty.
				const current = await this.#loadYamlForSave(configPath);

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
			this.#reportedSaveFailure = undefined;
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

	#rebuildMerged(): void {
		this.#merged = this.#deepMerge({}, this.#global);
		this.#merged = this.#deepMerge(this.#merged, this.#configOverlay);
		this.#merged = this.#deepMerge(this.#merged, this.#overrides);
		this.#resolvedCache.clear();
		this.#editVariantCache = undefined;
	}

	#fireAllHooks(): void {
		if (!this.#activateProcessHooks) return;
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

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

/** Change notification primitive for setting signals. */
/**
 * Every signal declared in this module, in declaration order.
 *
 * The registry exists so there is ONE place that knows the full set. Without it, clearing the
 * signals meant naming all nine at the reset site, and a tenth signal added later would silently
 * not be cleared -- which is the failure mode this whole mechanism was leaking through.
 */
const SETTING_SIGNALS: SettingSignal<never[]>[] = [];

class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();
	/** Permanent subscribers registered at module import. */
	#permanent = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {
		SETTING_SIGNALS.push(this as unknown as SettingSignal<never[]>);
	}

	/** Count of releasable listeners. */
	get listenerCount(): number {
		return this.#listeners.size;
	}

	/** How many import-time subscribers are attached. One per importing module, and it stays. */
	get permanentListenerCount(): number {
		return this.#permanent.size;
	}

	/** The signal's name, so a leak report can say WHICH signal is holding listeners. */
	get name(): string {
		return this.label;
	}

	/** Drop every releasable listener, keeping import-time ones. Only `resetSettingsForTest` calls this. */
	clear(): void {
		this.#listeners.clear();
	}

	/** Subscribe callback to setting changes. */
	on(cb: (...args: A) => void, options?: { readonly permanent?: boolean }): () => void {
		const set = options?.permanent ? this.#permanent : this.#listeners;
		set.add(cb);
		return () => {
			set.delete(cb);
		};
	}

	/** Invoke all listeners with args. */
	fire(...args: A): void {
		for (const cb of Array.from(this.#permanent).concat(Array.from(this.#listeners))) {
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
			autoThemeMappingSignal.fire("dark", value);
		}
	},
	"theme.light": value => {
		if (typeof value === "string") {
			autoThemeMappingSignal.fire("light", value);
		}
	},
	symbolPreset: value => {
		if (typeof value === "string" && (value === "unicode" || value === "nerd" || value === "ascii")) {
			symbolPresetSignal.fire(value);
		}
	},
	colorBlindMode: value => {
		if (typeof value === "boolean") {
			colorBlindModeSignal.fire(value);
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
		// setWorktreesDir expands `~`, rejects relative paths, and returns the
		// applied absolute path (or undefined when cleared/rejected).
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};
/** Fires when theme.dark or theme.light changes at runtime. */
const autoThemeMappingSignal = new SettingSignal<[slot: "dark" | "light", themeName: string]>("theme mapping");

/** Subscribe to theme changes. Returns unsubscribe function. */
export const onAutoThemeMappingChanged = (
	cb: (slot: "dark" | "light", themeName: string) => void,
	options?: { readonly permanent?: boolean },
) => autoThemeMappingSignal.on(cb, options);

/** Fires when `symbolPreset` changes at runtime. */
const symbolPresetSignal = new SettingSignal<[preset: "unicode" | "nerd" | "ascii"]>("symbolPreset");

/** Subscribe to `symbolPreset` changes. Returns an unsubscribe function. */
export const onSymbolPresetChanged = (
	cb: (preset: "unicode" | "nerd" | "ascii") => void,
	options?: { readonly permanent?: boolean },
) => symbolPresetSignal.on(cb, options);

/** Fires when `colorBlindMode` changes at runtime. */
const colorBlindModeSignal = new SettingSignal<[enabled: boolean]>("colorBlindMode");

/** Subscribe to `colorBlindMode` changes. Returns an unsubscribe function. */
export const onColorBlindModeChanged = (cb: (enabled: boolean) => void, options?: { readonly permanent?: boolean }) =>
	colorBlindModeSignal.on(cb, options);

/** Fires when `provider.appendOnlyContext` changes at runtime. */
const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

/** Subscribe to append-only mode setting changes. Returns unsubscribe function. */
export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

/** Fires when any model role changes at runtime. */
const modelRolesSignal = new SettingSignal("modelRoles");

/** Subscribe to model role changes. Returns an unsubscribe function. */
export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

/** Fires when `statusLine.sessionAccent` changes at runtime. */
const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

/** Subscribe to session-accent setting changes. Returns unsubscribe function. */
export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

/** Fires when any `hindsight.bankId` / `bankIdPrefix` / `scoping` value changes. */
const hindsightScopeSignal = new SettingSignal("hindsight scope");

/** Subscribe to Hindsight bank-scoping changes. Returns unsubscribe function. */
export const onHindsightScopeChanged = (cb: () => void) => hindsightScopeSignal.on(cb);

/** Test reset hook. */
export { registerSettingsTestResetHook } from "./settings-instance";

/** Reset settings for testing. */
export function resetSettingsForTest(): void {
	setSettingsInstance(null);
	setSettingsInstancePromise(null);
	configureProviderMaxInFlightRequests(undefined);
	for (const signal of SETTING_SIGNALS) signal.clear();
	runSettingsTestResetHooks();
}

/** Return listener counts per setting signal. */
export function settingSignalListenerCounts(): Record<string, number> {
	return Object.fromEntries(SETTING_SIGNALS.map(signal => [signal.name, signal.listenerCount]));
}

/** Global settings instance and initialization check. */
export { isSettingsInitialized, settings } from "./settings-instance";
