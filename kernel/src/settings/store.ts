/**
 * The layered settings store: the profile config a product owns, the config overlays a launch
 * names, and the runtime overrides a session sets, merged into one view with sync reads and a
 * debounced, locked, text-preserving save.
 *
 * The kernel names no setting. Everything a product knows about its own settings — the values
 * that are stored outside the profile file, the migrations that read a config an earlier release
 * wrote, the legacy stores a first run folds in, the side effect a value has on the process, and
 * a value's per-directory resolution — arrives as a {@link SettingsStoreHooks} at construction. The
 * store calls each hook at the point the product's own store called the same code, so a product
 * built on it behaves as it did when the store was its own.
 *
 * The schema the store reads is the registry in `./schema`: every path it enumerates, every
 * default it falls back to and every type it checks a configured value against comes from the
 * tables the product registered before the first read.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile } from "@veyyon/utils/atomic-write";
import {
	findShadowedGlobalConfigFiles,
	getAgentDir,
	getGlobalConfigFilePath,
	getProjectDir,
	MAIN_CONFIG_FILENAMES,
} from "@veyyon/utils/dirs";
import { withFileLock } from "@veyyon/utils/file-lock";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { expandTilde } from "@veyyon/utils/path";
import { type QuarantinedFile, quarantineUnparseableFile } from "@veyyon/utils/quarantine-file";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { syncYamlTextToSettings } from "@veyyon/utils/yaml-sync";
import { YAML } from "bun";
import { UNSET_NUMBER } from "./optional-number";
import {
	describeSettingTypeMismatch,
	getDefault,
	isUnsetNumberPath,
	type SettingPath,
	type SettingValue,
	settingsSchema,
} from "./schema";

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
 * A setting stored outside the profile file and read live through its own binding.
 *
 * A product declares one for a machine-wide value — the onboarding version, a token mask — that
 * lives in the global config rather than the profile store. The store reads it on every `get`,
 * never caches it, and writes it synchronously under the binding's own lock so a following read
 * reflects the write.
 */
export interface GlobalSettingBinding {
	read(): unknown;
	write(value: unknown): void;
}

/**
 * What a product knows about its settings that the store does not.
 *
 * One object per store instance, constructed by the product beside the store, so a hook that has
 * to remember something across reads — a rewrite reported once, a legacy value captured for a
 * marker file — keeps it on the hook object and a fork starts with a fresh one.
 */
export interface SettingsStoreHooks {
	/** The binding for a path stored outside the profile file, or `undefined` for a profile setting. */
	globalBinding(path: string): GlobalSettingBinding | undefined;
	/**
	 * Rewrite one raw source in place and return it, after the store has expanded every dotted
	 * key that names a registered path. Runs on every read of every source — the profile file,
	 * each overlay, the initial overrides, a fork's overrides — so apart from what it reports it
	 * must be a fixed point: applied to its own output it changes nothing.
	 */
	migrate(raw: RawSettings): RawSettings;
	/**
	 * Fold the stores an earlier release wrote into one raw config, for a first run that has no
	 * profile file yet. `migrate` is the store's full source migration, dotted-key expansion
	 * included, for the hook to apply to each legacy source. Returns `null` when there was nothing
	 * to fold; a non-empty result is written as the first profile file.
	 */
	loadLegacySources(agentDir: string, migrate: (raw: RawSettings) => RawSettings): Promise<RawSettings | null>;
	/** Runs after the owned profile file has loaded and before the merged view is built. */
	afterOwnedConfigLoaded(agentDir: string): Promise<void>;
	/**
	 * A configured value's resolution against the working directory, or `undefined` to take the
	 * value as written. The store caches the answer until the merged view is rebuilt.
	 */
	resolveForCwd(path: SettingPath, value: unknown, cwd: string): unknown;
	/** The side effect a setting's new value has on the process, applied after the value is stored. */
	applyHook(path: SettingPath, next: unknown, prev: unknown): void;
	/** Every side effect at once, each with the setting's current value: at load, on a clone, on a rescope. */
	applyAllHooks(store: SettingsStore): void;
	/** A process-wide notification for a path whose effective value changed. */
	notifyEffectiveChange(path: SettingPath): void;
	/** The merged view was rebuilt, so a cache derived from it is stale. */
	mergedViewRebuilt(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Path Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a nested value from an object by path segments.
 */
export function getByPath(obj: RawSettings, segments: readonly string[]): unknown {
	let current: unknown = obj;
	for (const segment of segments) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/**
 * Set a nested value in an object by path segments.
 * Creates intermediate objects as needed.
 */
export function setByPath(obj: RawSettings, segments: string[], value: unknown): void {
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
export function deleteByPath(obj: RawSettings, segments: readonly string[]): void {
	const parent = segments.length > 1 ? getByPath(obj, segments.slice(0, -1)) : obj;
	if (!isRecord(parent)) return;
	delete (parent as Record<string, unknown>)[segments[segments.length - 1]];
}

/**
 * Merge `overrides` over `base`, recursing into a mapping on both sides and replacing anything
 * else, with an `undefined` override leaving the base value in place.
 */
export function deepMergeSettings(base: RawSettings, overrides: RawSettings): RawSettings {
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
			result[key] = deepMergeSettings(baseVal as RawSettings, override as RawSettings);
		} else {
			result[key] = override;
		}
	}
	return result;
}

/**
 * The registered paths, split once into segments, and the ones whose `-1` used to mean "unset".
 *
 * Derived from the registry rather than declared here, so a new setting is covered without being
 * registered anywhere else, and derived lazily because the registry is empty while this module
 * loads: the product's schema module registers its tables when IT loads, and the store's own
 * import runs first. `declareSettings` rejects a path declared twice, so the key count only ever
 * grows and is the version the index is keyed on.
 */
interface SchemaIndex {
	readonly size: number;
	readonly paths: readonly SettingPath[];
	readonly segments: Readonly<Record<string, readonly string[]>>;
	/**
	 * The paths that used to store `-1` to mean "unset". Unset is an absent key now (see
	 * {@link SettingsStore.unset}); this list exists only so the load migration can drop the old
	 * sentinel. The number itself is {@link UNSET_NUMBER}, owned by `./optional-number` -- the
	 * store used to declare its own `-1` beside it, which is two names for one encoding and
	 * exactly the duplication that made the sentinel hard to remove in the first place.
	 */
	readonly legacyUnsetSentinelPaths: readonly (readonly string[])[];
}

let schemaIndex: SchemaIndex | undefined;

function indexedSchema(): SchemaIndex {
	const schema = settingsSchema();
	const paths = Object.keys(schema) as SettingPath[];
	if (schemaIndex && schemaIndex.size === paths.length) return schemaIndex;
	const segments: Record<string, readonly string[]> = Object.fromEntries(
		paths.map(settingPath => [settingPath, settingPath.split(".")]),
	);
	schemaIndex = {
		size: paths.length,
		paths,
		segments,
		legacyUnsetSentinelPaths: paths
			.filter(settingPath => isUnsetNumberPath(settingPath))
			.map(settingPath => settingPath.split(".")),
	};
	return schemaIndex;
}

/** The segments of a registered path, memoized, or `undefined` for a path no table declares. */
function registeredSegments(settingPath: string): readonly string[] | undefined {
	return indexedSchema().segments[settingPath];
}

/**
 * Migration numbers stamped into the global config as `settingsMigrationVersion`.
 * One per migration that may run only once; bump {@link SETTINGS_MIGRATION_VERSION}
 * and add a named constant when another needs the same treatment.
 */
export const SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY = 1;
export const SETTINGS_MIGRATION_VERSION = SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY;

/**
 * The config file is there, but this process could not read it.
 *
 * Distinct from absent and from empty, because the three want different
 * answers. Startup treats an unreadable file as empty so a transient fault does
 * not stop the CLI from running. A save must not: the writer deletes every key
 * the in-memory view no longer has, so saving one setting against a view built
 * from a failed read empties the whole file, and a read failure is not
 * quarantined the way a parse failure is, so there is no copy to restore from.
 */
class UnreadableConfig {
	constructor(readonly cause: unknown) {}
}

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
	for (const segments of indexedSchema().legacyUnsetSentinelPaths) {
		if (getByPath(raw, segments) !== UNSET_NUMBER) continue;
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
 *    deletes a value the user just set.
 *  - Stamping at load time would add a line to every config in existence,
 *    including ones that have never touched a sampling knob.
 *
 * Writing one of these paths is exactly the moment both concerns are satisfied:
 * the file is being rewritten anyway, and the stamp is what makes the new value
 * survivable. Anything still holding a legacy `-1` is stripped in the same write,
 * so the stamp can never certify a config the migration has not finished.
 *
 * The stamp only ever moves FORWARD. Two versions of veyyon share a config
 * directory more often than it looks (an installed binary beside a source
 * checkout, or a downgrade after a bad release), and a stamp of 2 rewritten to
 * 1 by the older build tells the newer one that a one-shot migration has not
 * run yet. It then runs a second time, on values the user set in between, which
 * is the exact deletion the stamp exists to prevent. `stripLegacyUnsetSentinels`
 * already reads the stamp as "at least this far", so anything below would
 * disagree with it.
 */
export function stampOwnedConfigMigrations(raw: RawSettings): string[] {
	const changed = stripLegacyUnsetSentinels(raw);
	if (appliedMigrationVersion(raw) < SETTINGS_MIGRATION_VERSION) {
		raw.settingsMigrationVersion = SETTINGS_MIGRATION_VERSION;
		changed.push("settingsMigrationVersion");
	}
	return changed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════════════

export class SettingsStore {
	#configPath: string | null;
	#cwd: string;
	#agentDir: string;
	readonly #hooks: SettingsStoreHooks;

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
	/**
	 * The failure already announced to listeners, replayed to anyone who
	 * subscribes later. Cleared when the same file finally takes a write.
	 */
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

	/** Paths modified during this session (for partial save) */
	#modified = new Set<string>();
	/**
	 * Legacy `-1` sentinels removed from the owned config at load, waiting to be
	 * removed from the FILE. They are written out with the migration stamp, on the
	 * first write to a path the migration governs — see #stampOwnedMigrationsFor.
	 */
	#pendingSentinelStrips: string[] = [];

	/** Dotted-key problems already reported, so each one is said once per process rather than once per read. */
	#reportedDottedKeyProblems = new Set<string>();

	/** Pending save (debounced) */
	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

	/** Whether to persist changes */
	#persist: boolean;

	constructor(options: SettingsOptions, hooks: SettingsStoreHooks) {
		this.#hooks = hooks;
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
	 * A fresh store of the same class, for a fork or a clone: a product that subclasses the store
	 * returns its own class here so a fork of a product store is a product store.
	 */
	newInstance(options: SettingsOptions): this {
		return new SettingsStore(options, this.#hooks) as this;
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
		const globalBinding = this.#hooks.globalBinding(path);
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
		// the schema index memoizes — and skip the schema default lookup,
		// which only exists for registered paths.
		const memoized = registeredSegments(path);
		const registered = memoized !== undefined;
		const segments = memoized ?? path.split(".");
		const value = getByPath(this.#merged, segments);
		const resolved =
			value !== undefined
				? (this.#hooks.resolveForCwd(path, value, this.#cwd) ?? value)
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
		// Replay a failure announced before anyone was listening. The onboarding
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
		if (this.#hooks.globalBinding(path)) {
			return !Object.is(this.get(path), getDefault(path));
		}
		return getByPath(this.#merged, registeredSegments(path) ?? path.split(".")) !== undefined;
	}

	/**
	 * Identify the highest-precedence layer that supplies `path`.
	 *
	 * `/settings` writes profile values. Callers use this provenance to avoid
	 * presenting a shadowed profile row as though an accepted edit took effect.
	 */
	getSource(path: string): SettingSource {
		const segments = registeredSegments(path) ?? path.split(".");
		if (getByPath(this.#overrides, segments) !== undefined) return "runtime";
		if (this.#hooks.globalBinding(path)) {
			return this.isConfigured(path as SettingPath) ? "global" : "default";
		}
		if (getByPath(this.#configOverlay, segments) !== undefined) return "config-file";
		if (getByPath(this.#global, segments) !== undefined) return "profile";
		return "default";
	}

	/**
	 * A value from one configured layer, by path segments, with no default and no
	 * per-directory resolution. For a product accessor that reads a sub-key of a record
	 * setting from one layer — a persisted model role, as opposed to the effective one.
	 */
	layerValue(layer: "profile" | "config-file" | "runtime", segments: readonly string[]): unknown {
		const tree = layer === "profile" ? this.#global : layer === "config-file" ? this.#configOverlay : this.#overrides;
		return getByPath(tree, segments);
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
		const globalBinding = this.#hooks.globalBinding(path);
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
				this.rebuildMerged();
			}
			const next = this.get(path);
			this.#hooks.applyHook(path, next, prev);
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
		this.rebuildMerged();
		const next = this.get(path);
		this.#queueSave();

		// Trigger hook if exists
		this.#hooks.applyHook(path, next, prev);
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

		const globalBinding = this.#hooks.globalBinding(path);
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
				this.rebuildMerged();
			}
			const next = this.get(path);
			this.#hooks.applyHook(path, next, prev);
			this.#fireEffectiveSettingChanged(path, next, prev);
			return;
		}

		this.#stampOwnedMigrationsFor(path);
		const segments = registeredSegments(path) ?? path.split(".");
		deleteByPath(this.#global, segments);
		// Also drop a runtime override for the same path. Both are values this
		// process owns, and leaving the override in place would make "Default"
		// appear to do nothing whenever a flag or overlay had set the same knob. A
		// value from a PROJECT config is not touched: this instance does not own
		// that file, and get() still reports it as the effective value.
		deleteByPath(this.#overrides, segments);
		this.#modified.add(path);
		this.rebuildMerged();
		const next = this.get(path);
		this.#queueSave();
		this.#hooks.applyHook(path, next, prev);
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
		this.rebuildMerged();
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
		this.rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

	#fireEffectiveSettingChanged(path: SettingPath, value: unknown, prev: unknown, applyProcessHooks = true): void {
		if (Object.is(value, prev)) return;
		for (const listener of this.#effectiveSettingListeners) listener(path, value, prev);
		if (!applyProcessHooks || !this.#activateProcessHooks) return;
		this.#hooks.notifyEffectiveChange(path);
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

	/**
	 * Create a non-persisting runtime fork while retaining the provenance of
	 * every layer. Unlike flattening get() values into an isolated instance, this
	 * leaves CLI config files in the config overlay and genuine runtime
	 * overrides in the override layer.
	 */
	forkWithRuntimeOverrides(overrides: Partial<Record<SettingPath, unknown>> = {}): this {
		const forked = this.newInstance({
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
		forked.rebuildMerged();
		return forked;
	}

	async cloneForCwd(cwd: string): Promise<this> {
		const cloned = this.newInstance({
			cwd,
			agentDir: this.#agentDir,
			inMemory: !this.#persist,
		});
		cloned.#configPath = this.#configPath;
		cloned.#activateProcessHooks = this.#activateProcessHooks;
		cloned.#global = structuredClone(this.#global);
		cloned.#configFiles = this.#configFiles.slice();
		cloned.#configOverlay = structuredClone(this.#configOverlay);
		cloned.#overrides = structuredClone(this.#overrides);
		cloned.rebuildMerged();
		cloned.#fireAllHooks();
		return cloned;
	}

	/**
	 * Re-scope this instance to a new working directory *in place*: re-resolve
	 * path-scoped settings against it and re-fire side-effect hooks (theme,
	 * symbols, tab width, …). Every configured layer is preserved, because none
	 * of them is sourced from the working tree.
	 *
	 * Unlike {@link cloneForCwd}, this mutates the live instance, so every holder
	 * (the `settings` proxy, the active session, controllers) observes the new
	 * scope without swapping references — used when the process changes
	 * directory mid-run (`/move`, cross-project resume). No-op when `cwd` is
	 * already the current scope.
	 */
	async reloadForCwd(cwd: string): Promise<void> {
		const normalized = path.normalize(cwd);
		if (normalized === this.#cwd) return;
		const settingPaths = indexedSchema().paths;
		const previousValues = new Map(settingPaths.map(settingPath => [settingPath, this.get(settingPath)]));
		this.#cwd = normalized;
		this.rebuildMerged();
		for (const settingPath of settingPaths) {
			this.#fireEffectiveSettingChanged(settingPath, this.get(settingPath), previousValues.get(settingPath));
		}
		this.#fireAllHooks();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getCwd(): string {
		return this.#cwd;
	}

	getAgentDir(): string {
		return this.#agentDir;
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
		for (const key of indexedSchema().paths.slice().sort()) {
			result[key] = this.get(key);
		}
		return result;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Loading
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Load every source: the owned profile file (folding the legacy stores in on a first run),
	 * the config overlays, then the merged view and every side-effect hook.
	 */
	async load(): Promise<this> {
		if (this.#persist) {
			const existingConfig = await this.#loadExistingMainYaml();
			if (existingConfig) {
				this.#global = existingConfig;
			} else {
				await this.#migrateFromLegacy();
				this.#global = await this.#loadYaml(this.#configPath!);
			}
			await this.#hooks.afterOwnedConfigLoaded(this.#agentDir);
			// Drop the legacy `-1` sentinels from the owned config, in memory. Not
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
		this.rebuildMerged();
		this.#fireAllHooks();
		return this;
	}

	/**
	 * Load the effective settings from the profile file and the overlays without opening
	 * storage, migrating legacy settings, or writing marker files.
	 */
	async loadReadOnly(): Promise<this> {
		const existingConfig = await this.#loadExistingMainYaml();
		if (existingConfig) {
			this.#global = existingConfig;
		}

		this.#configOverlay = await this.#loadConfigOverlays();
		this.#collectInvalidValues(this.#global, this.#configPath ?? "");
		this.rebuildMerged();
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
		for (const path of indexedSchema().paths) {
			const value = getByPath(tree, registeredSegments(path) ?? path.split("."));
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
		if (loaded instanceof UnreadableConfig) return {};
		return loaded ?? {};
	}

	/**
	 * Re-read for a save. Refuses on anything but a clean read or a genuinely
	 * absent file, so the caller's retry path runs instead of a write built on a
	 * view of the file that is known to be wrong.
	 *
	 * The original error is what propagates, not a summary of it: the operator's
	 * only clue about why saving stopped working is the filesystem's own reason,
	 * and the save-failure report puts that reason in front of them.
	 */
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
			if (loaded instanceof UnreadableConfig) {
				// The file at this name exists, so it is the config even though this
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
			merged = deepMergeSettings(merged, await this.#loadOverlayYaml(filePath));
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

		const settings = await this.#hooks.loadLegacySources(this.#agentDir, raw => this.#migrateRawSettings(raw));

		// Write merged settings
		//
		// This write is deliberately NOT wrapped in withFileLock, unlike #saveNow.
		// It runs only from load when config.yml is absent (first run), and its
		// content is a pure, deterministic function of the legacy sources
		// (settings.json + agent.db) — so a concurrent first-run in another
		// process writes byte-identical content and last-writer-wins is benign.
		// The write itself is atomic (whole file), so no reader ever sees a
		// partial config. INVARIANT: if migration ever becomes non-idempotent or
		// order-dependent, this must move under withFileLock(this.#configPath)
		// with a re-read, matching #saveNow.
		if (settings && Object.keys(settings).length > 0) {
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
			const segments = registeredSegments(key);
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
			setByPath(raw, segments.slice(), flat);
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

	/**
	 * The full migration of one raw source: the registry-driven dotted-key expansion, then the
	 * product's own rewrites. Every source passes through here — the profile file, each overlay,
	 * the initial overrides and a fork's — so a value read from any of them has one shape.
	 */
	#migrateRawSettings(raw: RawSettings): RawSettings {
		// Both spellings of a key mean the same thing, and only the nested one used
		// to be readable. Runs FIRST so every migration below sees one shape.
		this.#expandDottedSettingKeys(raw);
		return this.#hooks.migrate(raw);
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
		this.#announceSaveFailure({ path: configPath, reason, attempts });
	}

	/**
	 * A refused write to the machine-wide `~/.veyyon/config.yml`, told to the same
	 * listeners a refused profile save reaches.
	 *
	 * Announced on the FIRST failure rather than after a run of them, because a
	 * global binding writes synchronously under its own lock and nothing retries
	 * it: there is no later attempt to be quieter about, and the caller has
	 * already given up. It swallowed the error and logged instead, so a machine
	 * that could not persist `onboardingVersion` re-ran the whole setup wizard on
	 * every launch and said nothing about why.
	 *
	 * Announced once per file: a caller that writes the same value twice after a
	 * failure (the setup wizard marks completion again in its `finally`) reports
	 * one message, not one per attempt.
	 */
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
		clearTimeout(this.#saveTimer);
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
			// The lock directory lands beside the config file, so the parent has to exist before the
			// lock is taken: a profile that has never been launched interactively has no agent
			// directory yet, so the first save into it failed the lock's own lstat with ENOENT and
			// reported the setting as unsaved. Inside this try, a home that cannot take the directory
			// at all is recorded as a save failure like any other, rather than as a missing lock.
			await fsp.mkdir(path.dirname(configPath), { recursive: true });
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

		this.rebuildMerged();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Utilities
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Rebuild the merged view (profile → config overlays → overrides) and drop every value
	 * resolved from the previous one. Bare rather than private so a product can seal an
	 * in-memory instance it constructed from overrides alone, the way `Settings.isolated` does.
	 */
	rebuildMerged(): void {
		this.#merged = deepMergeSettings({}, this.#global);
		this.#merged = deepMergeSettings(this.#merged, this.#configOverlay);
		this.#merged = deepMergeSettings(this.#merged, this.#overrides);
		this.#resolvedCache.clear();
		this.#hooks.mergedViewRebuilt();
	}

	#fireAllHooks(): void {
		if (!this.#activateProcessHooks) return;
		this.#hooks.applyAllHooks(this);
	}
}
