import * as fs from "node:fs";
import * as path from "node:path";
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

export interface RawSettings {
	[key: string]: unknown;
}

export type QuarantinedSettingsFile = QuarantinedFile;

export interface SettingsSaveFailure {
	path: string;
	reason: string;
	attempts: number;
}

const SAVE_FAILURE_REPORT_AFTER = 3;

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

export const SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY = 1;
export const SETTINGS_MIGRATION_VERSION = SETTINGS_MIGRATION_VERSION_UNSET_ABSENT_KEY;

class UnreadableConfig {
	constructor(readonly cause: unknown) {}
}

function appliedMigrationVersion(raw: RawSettings): number {
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
const LEGACY_UNSET_SENTINEL_PATHS: readonly (readonly string[])[] = (Object.keys(SETTINGS_SCHEMA) as SettingPath[])
	.filter(settingPath => isUnsetNumberPath(settingPath))
	.map(settingPath => settingPath.split("."));

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
	#global: RawSettings = {};
	#configOverlay: RawSettings = {};
	#overrides: RawSettings = {};
	#activateProcessHooks = true;
	#quarantined: QuarantinedSettingsFile[] = [];
	#saveFailure: { path: string; reason: string; attempts: number } | undefined;
	#reportedSaveFailure: SettingsSaveFailure | undefined;
	#saveFailureListeners = new Set<(failure: SettingsSaveFailure) => void>();
	#effectiveSettingListeners = new Set<(path: SettingPath, value: unknown, previous: unknown) => void>();
	#invalidValues: InvalidSettingValue[] = [];
	#merged: RawSettings = {};
	#resolvedCache = new Map<SettingPath, unknown>();
	#editVariantCache: readonly EditVariantEntry[] | undefined;

	#modified = new Set<string>();
	#pendingSentinelStrips: string[] = [];

	#legacyLastChangelogVersion?: string;
	#reportedAskTimeoutRewrite = false;
	#reportedDottedKeyProblems = new Set<string>();

	#saveTimer?: NodeJS.Timeout;
	#savePromise?: Promise<void>;

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

	static init(options: SettingsOptions = {}): Promise<Settings> {
		const inFlight = settingsInstancePromise();
		if (inFlight) return inFlight;

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

	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.#loadReadOnly();
	}

	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.#load();
	}

	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.#rebuildMerged();
		return instance;
	}

	static get instance(): Settings {
		return settingsOrThrow();
	}

	get<P extends SettingPath>(path: P): SettingValue<P> {
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

	get quarantinedFiles(): readonly QuarantinedSettingsFile[] {
		return this.#quarantined;
	}

	get saveFailure(): SettingsSaveFailure | undefined {
		if (!this.#saveFailure) return undefined;
		const { path: failedPath, reason, attempts } = this.#saveFailure;
		if (attempts < SAVE_FAILURE_REPORT_AFTER) return undefined;
		return { path: failedPath, reason, attempts };
	}

	get lastSaveError(): { path: string; reason: string } | undefined {
		if (!this.#saveFailure) return undefined;
		return { path: this.#saveFailure.path, reason: this.#saveFailure.reason };
	}

	onSaveFailure(listener: (failure: SettingsSaveFailure) => void): () => void {
		this.#saveFailureListeners.add(listener);
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

	get invalidValues(): readonly InvalidSettingValue[] {
		return this.#invalidValues;
	}

	isConfigured(path: SettingPath): boolean {
		if (GLOBAL_SETTING_BINDINGS[path]) {
			return !Object.is(this.get(path), getDefault(path));
		}
		return getByPath(this.#merged, SETTING_PATH_SEGMENTS[path] ?? path.split(".")) !== undefined;
	}

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

	set<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);

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

		this.#stampOwnedMigrationsFor(path);
		const segments = path.split(".");
		setByPath(this.#global, segments, value);
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();

		const hook = SETTING_HOOKS[path];
		if (hook) {
			hook(next, prev);
		}
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

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
		deleteByPath(this.#overrides, segments);
		this.#modified.add(path);
		this.#rebuildMerged();
		const next = this.get(path);
		this.#queueSave();
		SETTING_HOOKS[path]?.(next, prev);
		this.#fireEffectiveSettingChanged(path, next, prev);
	}

	#stampOwnedMigrationsFor(path: SettingPath): void {
		if (!isUnsetNumberPath(path)) return;
		for (const strippedPath of this.#pendingSentinelStrips) this.#modified.add(strippedPath);
		this.#pendingSentinelStrips = [];
		for (const changedPath of stampOwnedConfigMigrations(this.#global)) this.#modified.add(changedPath);
	}

	override<P extends SettingPath>(path: P, value: SettingValue<P>): void {
		const prev = this.get(path);
		const segments = path.split(".");
		setByPath(this.#overrides, segments, value);
		this.#rebuildMerged();
		this.#fireEffectiveSettingChanged(path, this.get(path), prev);
	}

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

	getShellConfig() {
		const shell = this.get("shellPath");
		return procmgr.getShellConfig(shell);
	}

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

	getEffectiveSnapshot(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const key of (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).sort()) {
			result[key] = this.get(key);
		}
		return result;
	}

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

	getPersistedModelRole(role: ModelRole | string): string | undefined {
		return this.#modelRoleFromLayer(this.#global, role);
	}

	getModelRoleSource(role: ModelRole | string): SettingSource {
		if (this.#modelRoleFromLayer(this.#overrides, role) !== undefined) return "runtime";
		if (this.#modelRoleFromLayer(this.#configOverlay, role) !== undefined) return "config-file";
		if (this.#modelRoleFromLayer(this.#global, role) !== undefined) return "profile";
		return "default";
	}

	setPersistedModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer(this.#global);
		if (modelId === undefined) delete current[role];
		else current[role] = modelId;
		this.set("modelRoles", current);
	}

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

	getModelRole(role: ModelRole | string): string | undefined {
		const roles: unknown = this.get("modelRoles");
		if (!isRecord(roles)) return undefined;
		return modelRoleValueFromUnknown(roles[role]);
	}

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

	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer(this.#overrides);
		for (const [role, modelId] of Object.entries(roles)) {
			if (modelId) {
				next[role] = modelId;
			}
		}
		this.override("modelRoles", next);
	}

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
			this.#pendingSentinelStrips = stripLegacyUnsetSentinels(this.#global);
		}

		this.#configOverlay = await this.#loadConfigOverlays();
		this.#collectInvalidValues(this.#global, this.#configPath ?? "");
		this.#reportShadowedConfigFiles();

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

	#reportShadowedConfigFiles(): void {
		for (const shadowed of findShadowedGlobalConfigFiles()) {
			logger.warn("Global config file is being ignored because a higher-precedence one exists", {
				ignored: shadowed.ignored,
				using: shadowed.using,
				fix: `merge ${path.basename(shadowed.ignored)} into ${path.basename(shadowed.using)} and delete it`,
			});
		}
	}

	#collectInvalidValues(tree: RawSettings, file: string): void {
		if (!file) return;
		for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const value = getByPath(tree, SETTING_PATH_SEGMENTS[path] ?? path.split("."));
			if (value === undefined) continue;
			const reason = describeSettingTypeMismatch(path, value);
			if (reason === undefined) continue;
			if (this.#invalidValues.some(entry => entry.path === path && entry.file === file)) continue;
			this.#invalidValues.push({ path, file, reason });
			logger.warn("Settings: configured value does not match its declared type", { file, reason });
		}
	}

	async #loadYaml(filePath: string): Promise<RawSettings> {
		const loaded = await this.#loadYamlIfPresent(filePath);
		if (loaded instanceof UnreadableConfig) return {};
		return loaded ?? {};
	}

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
			if (parsed === null || parsed === undefined) {
				return {};
			}
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

		const settingsJsonPath = path.join(this.#agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (isRecord(parsed)) {
				settings = this.#deepMerge(settings, this.#migrateRawSettings(parsed as RawSettings));
				migrated = true;
				try {
					fs.renameSync(settingsJsonPath, `${settingsJsonPath}.bak`);
				} catch (error) {
					logger.warn("Settings: could not archive legacy settings.json after migration", {
						path: settingsJsonPath,
						error: errorMessage(error),
					});
				}
			}
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Settings: legacy settings.json exists but could not be migrated", {
					path: settingsJsonPath,
					error: errorMessage(error),
				});
			}
		}

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
				logger.warn("Settings: migrated settings could not be written to config.yml", {
					path: this.#configPath,
					error: errorMessage(error),
				});
			}
		}
	}

	#expandDottedSettingKeys(raw: RawSettings): void {
		for (const key of Object.keys(raw)) {
			if (!key.includes(".")) continue;
			const segments = SETTING_PATH_SEGMENTS[key as SettingPath];
			if (segments === undefined) continue;

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
				this.#reportDottedKeyProblem(
					`Settings: "${key}" is set twice, flat and nested. The nested value is used and the flat key is dropped.`,
					{ key, used: nested, dropped: flat },
				);
				continue;
			}
			setByPath(raw, segments.slice(), flat);
		}
	}

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

	#migrateSubagentSettings(raw: RawSettings): void {
		const read = (segments: string[]): unknown => getByPath(raw, segments);
		const take = (segments: string[]): unknown => {
			const value = getByPath(raw, segments);
			if (value !== undefined) deleteByPath(raw, segments);
			return value;
		};
		const setNew = (key: string[], value: unknown): void => {
			if (value === undefined) return;
			if (read(["subagent", ...key]) !== undefined) return;
			setByPath(raw, ["subagent", ...key], value);
		};

		const eager = take(["task", "eager"]);
		if (typeof eager === "string") {
			const delegation = eager === "always" ? "required" : eager === "preferred" ? "preferred" : "allowed";
			setNew(["delegation"], delegation);
		}

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

		for (const key of ["mode", "merge", "commits"] as const) {
			setNew(["isolation", key], take(["task", "isolation", key]));
		}

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
		if (Object.keys(agents).length > 0) setNew(["agents"], agents);

		const legacyRoleModel = read(["modelRoles", "task"]);
		if (typeof legacyRoleModel === "string" && legacyRoleModel.trim()) {
			setNew(["model"], legacyRoleModel.trim());
			deleteByPath(raw, ["modelRoles", "task"]);
		}

		if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
		const isolation = getByPath(raw, ["task", "isolation"]);
		if (isRecord(isolation) && Object.keys(isolation).length === 0) {
			deleteByPath(raw, ["task", "isolation"]);
			if (isRecord(raw.task) && Object.keys(raw.task).length === 0) delete raw.task;
		}
	}

	#migrateRawSettings(raw: RawSettings): RawSettings {
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
		if ("queueMode" in raw && !("steeringMode" in raw)) {
			raw.steeringMode = raw.queueMode;
			delete raw.queueMode;
		}
	}

	#migrateLastChangelogVersion(raw: RawSettings): void {
		if (typeof raw.lastChangelogVersion === "string") {
			this.#legacyLastChangelogVersion ??= raw.lastChangelogVersion;
		}
		delete raw.lastChangelogVersion;
	}

	#migrateCollapseChangelog(raw: RawSettings): void {
		delete raw.collapseChangelog;
	}

	#migrateAskTimeout(raw: RawSettings): void {
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
		if (typeof raw.theme === "string") {
			const oldTheme = raw.theme;
			if (oldTheme === "light" || oldTheme === "dark") {
				delete raw.theme;
			} else {
				const slot = isLightTheme(oldTheme) ? "light" : "dark";
				raw.theme = { [slot]: oldTheme };
			}
		}
	}

	#migrateTaskIsolation(raw: RawSettings): void {
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
		const taskObj = raw.task as Record<string, unknown> | undefined;
		if (taskObj && "simple" in taskObj) {
			delete taskObj.simple;
		}
	}

	#migrateTaskEager(raw: RawSettings): void {
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
		const cycleOrder = raw.cycleOrder;
		if (Array.isArray(cycleOrder)) {
			raw.cycleOrder = cycleOrder.filter(role => role !== "default");
		}
	}

	#migrateSnapcompact(raw: RawSettings): void {
		delete raw.snapcompact;
		for (const key of Object.keys(raw)) {
			if (key.startsWith("snapcompact.")) delete raw[key];
		}
	}

	#migrateInlineToolDescriptors(raw: RawSettings): void {
		if (typeof raw.inlineToolDescriptors === "boolean") {
			raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
		}
	}

	#migrateStatusLinePlanMode(raw: RawSettings): void {
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
		const providersObj = raw.providers as Record<string, unknown> | undefined;
		if (providersObj && "parallelFetch" in providersObj) {
			delete providersObj.parallelFetch;
		}
		delete raw["providers.parallelFetch"];
	}

	#migrateCodexResetsAutoRedeem(raw: RawSettings): void {
		const codexResetsObj = raw.codexResets as Record<string, unknown> | undefined;
		if (codexResetsObj && typeof codexResetsObj.autoRedeem === "boolean") {
			codexResetsObj.autoRedeem = codexResetsObj.autoRedeem ? "yes" : "no";
		}
	}

	#migrateMemoryBackend(raw: RawSettings): void {
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
		delete raw.readHashLines;
	}

	#mapInheritTier(value: unknown): unknown {
		return value === "openai-only" || value === "claude-only" ? "priority" : value;
	}

	#migrateServiceTier(raw: RawSettings): void {
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
				const encode = isRecord(argotObj.encode) ? argotObj.encode : {};
				if (!(key in encode)) encode[key] = argotObj[key];
				argotObj.encode = encode;
				delete argotObj[key];
			}
		}
	}

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

	async #writeConfigPreservingText(configPath: string, settings: RawSettings): Promise<void> {
		let existing = "";
		try {
			existing = await Bun.file(configPath).text();
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		let text: string;
		try {
			text = syncYamlTextToSettings(existing, settings);
		} catch (error) {
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

	#recordSaveFailure(configPath: string, error: unknown): void {
		const reason = errorMessage(error);
		const attempts = (this.#saveFailure?.path === configPath ? this.#saveFailure.attempts : 0) + 1;
		this.#saveFailure = { path: configPath, reason, attempts };
		if (attempts !== SAVE_FAILURE_REPORT_AFTER) return;
		this.#announceSaveFailure({ path: configPath, reason, attempts });
	}

	#recordGlobalWriteFailure(error: unknown): void {
		const filePath = getGlobalConfigFilePath();
		const reason = errorMessage(error);
		const attempts = (this.#saveFailure?.path === filePath ? this.#saveFailure.attempts : 0) + 1;
		this.#saveFailure = { path: filePath, reason, attempts };
		if (attempts !== 1) return;
		this.#announceSaveFailure({ path: filePath, reason, attempts });
	}

	#clearGlobalWriteFailure(): void {
		// filesystem probes, and a pending PROFILE failure must survive untouched.
		if (!this.#saveFailure) return;
		if (this.#saveFailure.path !== getGlobalConfigFilePath()) return;
		this.#saveFailure = undefined;
		this.#reportedSaveFailure = undefined;
	}

	#announceSaveFailure(failure: SettingsSaveFailure): void {
		this.#reportedSaveFailure = failure;
		for (const listener of this.#saveFailureListeners) {
			this.#deliverSaveFailure(listener, failure);
		}
	}

	#deliverSaveFailure(listener: (failure: SettingsSaveFailure) => void, failure: SettingsSaveFailure): void {
		try {
			listener(failure);
		} catch (listenerError) {
			logger.warn("Settings: a save-failure listener threw", { error: errorMessage(listenerError) });
		}
	}

	#queueSave(): void {
		if (!this.#persist || !this.#configPath) return;

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
				const current = await this.#loadYamlForSave(configPath);

				for (const modPath of modifiedPaths) {
					const segments = modPath.split(".");
					const value = getByPath(this.#global, segments);
					setByPath(current, segments, value);
				}

				this.#global = current;
				await this.#writeConfigPreservingText(configPath, this.#global);
			});
			this.#saveFailure = undefined;
			this.#reportedSaveFailure = undefined;
		} catch (error) {
			logger.warn("Settings: save failed", { error: String(error) });
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

const SETTING_SIGNALS: SettingSignal<never[]>[] = [];

class SettingSignal<A extends unknown[] = []> {
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
		if (dir && !setWorktreesDir(dir)) {
			logger.warn("Settings: worktree.base must be an absolute or ~-relative path; ignoring", { value: dir });
		} else if (!dir) {
			setWorktreesDir(undefined);
		}
	},
};
const autoThemeMappingSignal = new SettingSignal<[slot: "dark" | "light", themeName: string]>("theme mapping");

export const onAutoThemeMappingChanged = (
	cb: (slot: "dark" | "light", themeName: string) => void,
	options?: { readonly permanent?: boolean },
) => autoThemeMappingSignal.on(cb, options);

const symbolPresetSignal = new SettingSignal<[preset: "unicode" | "nerd" | "ascii"]>("symbolPreset");

export const onSymbolPresetChanged = (
	cb: (preset: "unicode" | "nerd" | "ascii") => void,
	options?: { readonly permanent?: boolean },
) => symbolPresetSignal.on(cb, options);

const colorBlindModeSignal = new SettingSignal<[enabled: boolean]>("colorBlindMode");

export const onColorBlindModeChanged = (cb: (enabled: boolean) => void, options?: { readonly permanent?: boolean }) =>
	colorBlindModeSignal.on(cb, options);

const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

const modelRolesSignal = new SettingSignal("modelRoles");

export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

const hindsightScopeSignal = new SettingSignal("hindsight scope");

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
