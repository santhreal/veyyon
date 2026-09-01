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

import * as path from "node:path";
import { expandTilde } from "@veyyon/utils/path";
import type { QuarantinedFile } from "@veyyon/utils/quarantine-file";
import { isRecord } from "@veyyon/utils/type-guards";
import type { EditMode } from "../utils/edit-mode";
import { UNSET_NUMBER } from "./optional-number";
import { isUnsetNumberPath, SETTINGS_SCHEMA, type SettingPath } from "./settings-schema";

// Re-export types that callers need
export type * from "./settings-schema";
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Raw settings object as stored in YAML */
import { Settings } from "./settings";

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
export const SAVE_FAILURE_REPORT_AFTER = 3;

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

export const SETTING_PATH_SEGMENTS: Record<SettingPath, readonly string[]> = Object.fromEntries(
	(Object.keys(SETTINGS_SCHEMA) as SettingPath[]).map(settingPath => [settingPath, settingPath.split(".")]),
) as unknown as Record<SettingPath, readonly string[]>;

/**
 * The paths that used to store `-1` to mean "unset". Unset is an absent key now (see
 * {@link Settings.unset}); this list exists only so the load migration can drop the old
 * sentinel, and it is derived from the schema so a new optional numeric setting is covered
 * without being registered anywhere else. The number itself is {@link UNSET_NUMBER}, owned
 * by `config/optional-number.ts` -- this file used to declare its own `-1` beside it, which
 * is two names for one encoding and exactly the duplication that made the sentinel hard to
 * remove in the first place.
 */

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
export class UnreadableConfig {
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
	for (const segments of LEGACY_UNSET_SENTINEL_PATHS) {
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
export const LEGACY_UNSET_SENTINEL_PATHS: readonly (readonly string[])[] = (
	Object.keys(SETTINGS_SCHEMA) as SettingPath[]
)
	.filter(settingPath => isUnsetNumberPath(settingPath))
	.map(settingPath => settingPath.split("."));

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

export const PATH_SCOPED_ARRAY_SETTINGS = new Set<SettingPath>(["enabledModels", "disabledProviders"]);

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
export type PathScopedStringArrayEntry = {
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

export function modelRoleValueFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;

	const entries = stringArrayFromUnknown(value);
	return entries.length === value.length ? entries.join(",") : undefined;
}

export type EditVariantEntry = {
	patternLower: string;
	mode: EditMode;
};

export function resolvePathScopedStringArray(
	settingPath: SettingPath,
	value: unknown,
	cwd: string,
): string[] | undefined {
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
