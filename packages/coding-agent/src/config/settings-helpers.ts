import * as path from "node:path";
import { configureProviderMaxInFlightRequests } from "@veyyon/ai/provider-inflight-limits";
import { setWorktreesDir } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { expandTilde } from "@veyyon/utils/path";
import type { QuarantinedFile } from "@veyyon/utils/quarantine-file";
import { isRecord } from "@veyyon/utils/type-guards";
import type { EditMode } from "../utils/edit-mode";
import { UNSET_NUMBER } from "./optional-number";
import { runSettingsTestResetHooks, setSettingsInstance, setSettingsInstancePromise } from "./settings-instance";
import { isUnsetNumberPath, SETTINGS_SCHEMA, type SettingPath, type SettingValue } from "./settings-schema";

export type * from "./settings-schema";
export * from "./settings-schema";

export interface RawSettings {
	[key: string]: unknown;
}

export type QuarantinedSettingsFile = QuarantinedFile;

export interface SettingsSaveFailure {
	path: string;
	reason: string;
	attempts: number;
}

export const SAVE_FAILURE_REPORT_AFTER = 3;

export interface InvalidSettingValue {
	path: SettingPath;
	file: string;
	reason: string;
}

export type SettingSource = "default" | "profile" | "config-file" | "runtime" | "global";

export interface SettingsOptions {
	cwd?: string;
	agentDir?: string;
	inMemory?: boolean;
	readOnly?: boolean;
	overrides?: Partial<Record<SettingPath, unknown>>;
	configFiles?: string[];
}

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

export const SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY = 1;
export const SETTINGS_MIGRATION_VERSION = SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY;

export class UnreadableConfig {
	constructor(readonly cause: unknown) {}
}

export function appliedMigrationVersion(raw: RawSettings): number {
	return typeof raw.settingsMigrationVersion === "number" ? raw.settingsMigrationVersion : 0;
}

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

export function normalizePathPrefix(prefix: string): string {
	return path.resolve(expandTilde(prefix));
}

export function pathMatchesPrefix(cwd: string, prefix: string): boolean {
	const relative = path.relative(normalizePathPrefix(prefix), path.resolve(cwd));
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function stringArrayFromUnknown(value: unknown): string[] {
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
		for (let vi = 0; vi < values.length; vi++) resolved.push(values[vi]!);
	}

	return resolved;
}

export type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

export const SETTING_SIGNALS: SettingSignal<never[]>[] = [];

export class SettingSignal<A extends unknown[] = []> {
	#listeners = new Set<(...args: A) => void>();
	#permanent = new Set<(...args: A) => void>();

	constructor(private readonly label: string) {
		SETTING_SIGNALS.push(this as unknown as SettingSignal<never[]>);
	}

	get listenerCount(): number {
		return this.#listeners.size;
	}

	get permanentListenerCount(): number {
		return this.#permanent.size;
	}

	get name(): string {
		return this.label;
	}

	clear(): void {
		this.#listeners.clear();
	}

	on(cb: (...args: A) => void, options?: { readonly permanent?: boolean }): () => void {
		const set = options?.permanent ? this.#permanent : this.#listeners;
		set.add(cb);
		return () => {
			set.delete(cb);
		};
	}

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

export const SETTING_HOOKS: Partial<Record<SettingPath, SettingHook<any>>> = {
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
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};
export const autoThemeMappingSignal = new SettingSignal<[slot: "dark" | "light", themeName: string]>("theme mapping");

export const onAutoThemeMappingChanged = (
	cb: (slot: "dark" | "light", themeName: string) => void,
	options?: { readonly permanent?: boolean },
) => autoThemeMappingSignal.on(cb, options);

export const symbolPresetSignal = new SettingSignal<[preset: "unicode" | "nerd" | "ascii"]>("symbolPreset");

export const onSymbolPresetChanged = (
	cb: (preset: "unicode" | "nerd" | "ascii") => void,
	options?: { readonly permanent?: boolean },
) => symbolPresetSignal.on(cb, options);

export const colorBlindModeSignal = new SettingSignal<[enabled: boolean]>("colorBlindMode");

export const onColorBlindModeChanged = (cb: (enabled: boolean) => void, options?: { readonly permanent?: boolean }) =>
	colorBlindModeSignal.on(cb, options);

export const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

export const modelRolesSignal = new SettingSignal("modelRoles");

export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

export const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

export const hindsightScopeSignal = new SettingSignal("hindsight scope");

export const onHindsightScopeChanged = (cb: () => void) => hindsightScopeSignal.on(cb);

export { registerSettingsTestResetHook } from "./settings-instance";

export function resetSettingsForTest(): void {
	setSettingsInstance(null);
	setSettingsInstancePromise(null);
	configureProviderMaxInFlightRequests(undefined);
	for (const signal of SETTING_SIGNALS) signal.clear();
	runSettingsTestResetHooks();
}

export function settingSignalListenerCounts(): Record<string, number> {
	return Object.fromEntries(SETTING_SIGNALS.map(signal => [signal.name, signal.listenerCount]));
}

export { isSettingsInitialized, settings } from "./settings-instance";
