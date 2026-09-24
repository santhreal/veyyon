/**
 * The product's settings: the kernel's layered store (`@veyyon/kernel/settings/store`) with the
 * hooks this product supplies — the machine-wide bindings, the migrations that read a config an
 * earlier release wrote, the legacy stores a first run folds in, the side effect each value has
 * on the process — plus the typed accessors and the process-wide signals.
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
// The caps' own module, not the streaming engine that reads them. `@veyyon/ai/stream` re-exports
// this setter and importing it there cost 285 modules for one function; ~530 test files import
// `Settings`, so this file's graph is the most leveraged one in the package.
import { configureProviderMaxInFlightRequests } from "@veyyon/ai/provider-inflight-limits";
import { clearSettingSignals } from "@veyyon/kernel/settings/signal";
import {
	deepMergeSettings,
	type GlobalSettingBinding,
	groupSettingPaths,
	type RawSettings,
	type SettingSource,
	type SettingsOptions,
	SettingsStore,
	type SettingsStoreHooks,
} from "@veyyon/kernel/settings/store";
import { getLastChangelogVersionPath, setWorktreesDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
// Owners, not the `@veyyon/utils` barrel, because that is this repository's rule and this is the module
// 528 test files reach. It bought NO modules, and that is worth stating so nobody re-measures it hoping:
// repointing a file removes the barrel edge only when that file was the LAST path to it, and this closure
// still reaches the barrel elsewhere, so `config/settings.ts` reads 136 before and after. The rule is
// still right -- the edge is gone from HERE, and the next file in the closure that stops naming the barrel
// gets the whole 82 rather than none of it. Naming `dirs` directly is safe: it applies the
// directory-location keys from `$HOME/.env` itself, which is what `packages/utils/src/dotenv-home.ts`
// exists for.
import * as logger from "@veyyon/utils/logger";
import { expandTilde } from "@veyyon/utils/path";
import * as procmgr from "@veyyon/utils/procmgr";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { JSONC } from "bun";
import { type EditMode, normalizeEditMode } from "../utils/edit-mode";
import { readLegacyAgentDbSettings } from "./legacy-agent-db-settings";
import type { ModelRole } from "./model-roles";
import { GLOBAL_SETTING_BINDINGS } from "./settings-domains/global";
// The slot, not a second copy of it: this module FILLS the slot that `./settings-instance.ts` owns, and
// that leaf is what a caller reads when it wants a value rather than the store. See its doc for the split.
import {
	runSettingsTestResetHooks,
	setSettingsInstance,
	setSettingsInstancePromise,
	settingsInstancePromise,
	settingsOrThrow,
} from "./settings-instance";
import { MAX_ASK_TIMEOUT_SECONDS, migrateRawSettings } from "./settings-migrations";
import type { BashInterceptorRule, GroupPrefix, GroupTypeMap, SettingPath, SettingValue } from "./settings-schema";
import {
	appendOnlyModeSignal,
	autoThemeMappingSignal,
	colorBlindModeSignal,
	hindsightScopeSignal,
	modelRolesSignal,
	statusLineSessionAccentSignal,
	symbolPresetSignal,
} from "./settings-signals";

export { settingSignalListenerCounts } from "@veyyon/kernel/settings/signal";
// The store's vocabulary — the raw tree, the options, the provenance, the one-shot migration stamp
// and its helpers — under the name every caller already imports.
export * from "@veyyon/kernel/settings/store";
// Re-export types that callers need
export * from "./settings-schema";

// ═══════════════════════════════════════════════════════════════════════════
// Product Helpers
// ═══════════════════════════════════════════════════════════════════════════

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

export { MAX_ASK_TIMEOUT_SECONDS } from "./settings-migrations";

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

function normalizeModelRoles(value: unknown): Record<string, string> {
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

// ═══════════════════════════════════════════════════════════════════════════
// Product Hooks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What this product knows about its settings that the kernel store does not, one object per
 * store instance.
 *
 * The rewrite reported once and the legacy value captured for the marker file are per-instance
 * state, so they live here rather than at module scope, and a fork or a clone constructs a fresh
 * set the way it constructs a fresh store.
 */
class CodingAgentSettingsHooks implements SettingsStoreHooks {
	/** Legacy `lastChangelogVersion` captured from config.yml during migration (now a marker file). */
	legacyLastChangelogVersion?: string;
	/** Set once `ask.timeout` has been reported as rewritten, so the warning does not repeat on every read. */
	#reportedAskTimeoutRewrite = false;
	/** The parsed `edit.modelVariants` table, dropped whenever the merged view is rebuilt. */
	editVariantCache: readonly EditVariantEntry[] | undefined;

	globalBinding(path: string): GlobalSettingBinding | undefined {
		return GLOBAL_SETTING_BINDINGS[path];
	}

	resolveForCwd(path: SettingPath, value: unknown, cwd: string): unknown {
		return resolvePathScopedStringArray(path, value, cwd);
	}

	applyHook(path: SettingPath, next: unknown, prev: unknown): void {
		const hook = SETTING_HOOKS[path];
		if (hook)
			(hook as SettingHook<SettingPath>)(next as SettingValue<SettingPath>, prev as SettingValue<SettingPath>);
	}

	applyAllHooks(store: SettingsStore): void {
		for (const key of Object.keys(SETTING_HOOKS) as SettingPath[]) {
			const hook = SETTING_HOOKS[key];
			if (hook) {
				const value = store.get(key);
				(hook as SettingHook<SettingPath>)(value, value);
			}
		}
	}

	notifyEffectiveChange(path: SettingPath): void {
		if (path === "statusLine.sessionAccent") {
			statusLineSessionAccentSignal.fire();
		}
		if (path === "modelRoles") {
			modelRolesSignal.fire();
		}
	}

	mergedViewRebuilt(): void {
		this.editVariantCache = undefined;
	}

	/**
	 * Fold the legacy stores — `settings.json`, then `agent.db` — into one raw config for a
	 * first run that has no `config.yml`. Returns `null` when neither existed.
	 */
	async loadLegacySources(agentDir: string, migrate: (raw: RawSettings) => RawSettings): Promise<RawSettings | null> {
		let settings: RawSettings = {};
		let migrated = false;

		// 1. Migrate from settings.json
		const settingsJsonPath = path.join(agentDir, "settings.json");
		try {
			const parsed: unknown = JSONC.parse(await Bun.file(settingsJsonPath).text());
			if (isRecord(parsed)) {
				settings = deepMergeSettings(settings, migrate(parsed as RawSettings));
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
			const dbSettings = readLegacyAgentDbSettings(agentDir);
			if (dbSettings) {
				settings = deepMergeSettings(settings, migrate(dbSettings as RawSettings));
				migrated = true;
			}
		} catch (error) {
			logger.warn("Settings: could not read legacy settings from agent.db during migration", {
				error: errorMessage(error),
			});
		}

		return migrated ? settings : null;
	}

	/**
	 * One-time migration: seed the last-changelog-version marker file from the
	 * legacy config.yml key. An existing marker always wins — it is the newer
	 * source of truth.
	 */
	async afterOwnedConfigLoaded(agentDir: string): Promise<void> {
		const legacy = this.legacyLastChangelogVersion;
		if (!legacy) return;
		const markerPath = getLastChangelogVersionPath(agentDir);
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

	/**
	 * Say once that `ask.timeout` was rewritten from milliseconds to seconds.
	 *
	 * The conversion is a guess (see the call site), so the one case it gets
	 * wrong is a user who genuinely wanted a timeout longer than
	 * {@link MAX_ASK_TIMEOUT_SECONDS}. Without this they would only find out by
	 * watching an ask auto-select in two seconds and having no idea why. Once per
	 * process, because the migration runs on every read of the file.
	 */
	reportAskTimeoutRewrite(from: number, to: number): void {
		if (this.#reportedAskTimeoutRewrite) return;
		this.#reportedAskTimeoutRewrite = true;
		logger.warn(
			`Settings: ask.timeout was ${from}, which is read as milliseconds from an older config and rewritten to ${to} seconds. ` +
				`If you meant ${from} seconds, set ask.timeout again; it is in seconds now.`,
			{ from, to, maxSeconds: MAX_ASK_TIMEOUT_SECONDS },
		);
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
	migrate(raw: RawSettings): RawSettings {
		return migrateRawSettings(raw, this);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings Class
// ═══════════════════════════════════════════════════════════════════════════

export class Settings extends SettingsStore {
	readonly #hooks: CodingAgentSettingsHooks;

	private constructor(options: SettingsOptions = {}) {
		const hooks = new CodingAgentSettingsHooks();
		super(options, hooks);
		this.#hooks = hooks;
	}

	/** A fork or a clone of a product store is a product store. */
	override newInstance(options: SettingsOptions): this {
		return new Settings(options) as this;
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Factory Methods
	// ─────────────────────────────────────────────────────────────────────────

	/**
	 * Initialize the global singleton.
	 * Call once at startup before accessing `settings`.
	 */
	static init(options: SettingsOptions = {}): Promise<Settings> {
		const inFlight = settingsInstancePromise();
		if (inFlight) return inFlight;

		// The promise recorded in the slot is the one that FILLS the slot, not the bare load. They are not
		// interchangeable: the bare load settles first, so a second caller awaiting it could resume before
		// `globalInstance` was set and see `isSettingsInitialized()` return false straight after `await
		// Settings.init()`. Recording the derived promise also makes `init()` return the same object every
		// time, which is what makes "a second init joins the first" checkable rather than merely likely.
		const instance = new Settings(options);
		const ready = instance.load().then(
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

	/**
	 * Load effective settings from config.yml and project providers without
	 * opening agent.db, migrating legacy settings, or writing marker files.
	 */
	static loadReadOnly(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings({ ...options, readOnly: true });
		return instance.loadReadOnly();
	}

	/**
	 * Load a persisted settings instance without touching the global singleton.
	 */
	static loadIsolated(options: SettingsOptions = {}): Promise<Settings> {
		const instance = new Settings(options);
		return instance.load();
	}

	/**
	 * Create an isolated instance for testing.
	 * Does not affect the global singleton.
	 */
	static isolated(overrides: Partial<Record<SettingPath, unknown>> = {}): Settings {
		const instance = new Settings({ inMemory: true, overrides });
		instance.rebuildMerged();
		return instance;
	}

	/**
	 * Get the global singleton.
	 * Throws if not initialized.
	 */
	static get instance(): Settings {
		return settingsOrThrow();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Accessors
	// ─────────────────────────────────────────────────────────────────────────

	getPlansDirectory(): string {
		return path.join(this.getAgentDir(), "plans");
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
		for (const key of groupSettingPaths(prefix)) {
			result[key.slice(prefix.length + 1)] = this.get(key);
		}
		return result as unknown as GroupTypeMap[G];
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
		if (this.#hooks.editVariantCache !== undefined) return this.#hooks.editVariantCache;

		const value = this.get("edit.modelVariants");
		if (!isRecord(value)) {
			this.#hooks.editVariantCache = [];
			return this.#hooks.editVariantCache;
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

		this.#hooks.editVariantCache = variants;
		return variants;
	}

	/**
	 * Get bash interceptor rules (typed accessor for complex array config).
	 */
	getBashInterceptorRules(): BashInterceptorRule[] {
		return this.get("bashInterceptor.patterns");
	}

	#modelRoleFromLayer(layer: "profile" | "config-file" | "runtime", role: ModelRole | string): string | undefined {
		const value = this.layerValue(layer, ["modelRoles"]);
		if (!isRecord(value)) return undefined;
		return modelRoleValueFromUnknown(value[role]);
	}

	#modelRolesFromLayer(layer: "profile" | "config-file" | "runtime"): Record<string, string> {
		return normalizeModelRoles(this.layerValue(layer, ["modelRoles"]));
	}

	/** Return one role from the profile layer, excluding project and runtime overrides. */
	getPersistedModelRole(role: ModelRole | string): string | undefined {
		return this.#modelRoleFromLayer("profile", role);
	}

	/** Identify the layer that supplies one effective model-role slot. */
	getModelRoleSource(role: ModelRole | string): SettingSource {
		if (this.#modelRoleFromLayer("runtime", role) !== undefined) return "runtime";
		if (this.#modelRoleFromLayer("config-file", role) !== undefined) return "config-file";
		if (this.#modelRoleFromLayer("profile", role) !== undefined) return "profile";
		return "default";
	}

	/**
	 * Persist one profile role without rewriting a higher-precedence override.
	 *
	 * This is the storage contract for profile-default controls. Interactive
	 * session model switches continue to use {@link setModelRole}.
	 */
	setPersistedModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer("profile");
		if (modelId === undefined) delete current[role];
		else current[role] = modelId;
		this.set("modelRoles", current);
	}

	/**
	 * Set a model role (helper for modelRoles record). Passing `undefined`
	 * clears the role from the persisted record and any runtime override.
	 */
	setModelRole(role: ModelRole | string, modelId: string | undefined): void {
		const current = this.#modelRolesFromLayer("profile");
		const runtimeOverrides = this.layerValue("runtime", ["modelRoles"]);
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
			const nextRuntimeOverride = this.#modelRolesFromLayer("runtime");
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
		return normalizeModelRoles(this.get("modelRoles"));
	}

	/*
	 * Override model roles (helper for modelRoles record).
	 */
	overrideModelRoles(roles: ReadOnlyDict<string>): void {
		const next = this.#modelRolesFromLayer("runtime");
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Setting Hooks
// ═══════════════════════════════════════════════════════════════════════════

type SettingHook<P extends SettingPath> = (value: SettingValue<P>, prev: SettingValue<P>) => void;

/** The `theme.<slot>` hook: a string value republishes the slot's theme mapping. */
function themeSlotHook(slot: "dark" | "light"): SettingHook<"theme.dark" | "theme.light"> {
	return value => {
		if (typeof value === "string") {
			autoThemeMappingSignal.fire(slot, value);
		}
	};
}

const SETTING_HOOKS: { [P in SettingPath]?: SettingHook<P> } = {
	"theme.dark": themeSlotHook("dark"),
	"theme.light": themeSlotHook("light"),
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

// ═══════════════════════════════════════════════════════════════════════════
// Global Singleton
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Teardown a downstream module asks `resetSettingsForTest` to run.
 *
 * The registry lives in `./settings-instance.ts` with the slot, and is re-exported here because this is
 * the name callers import. A module that only REGISTERS should import the leaf: `theme/markdown-theme.ts`
 * registers one hook and paid 95 modules of settings store for the privilege.
 *
 * @internal
 */
export { registerSettingsTestResetHook } from "./settings-instance";

/**
 * Reset the global singleton for testing.
 *
 * The signal listeners go too, and that is the point rather than a detail. A `SettingSignal`
 * subscription lives at module scope, so it outlives the `Settings` instance it was made against
 * and outlives the test file that made it. Anything that subscribed and did not unsubscribe stayed
 * attached for the rest of the process, and the next write to that setting called it -- a callback
 * closed over a torn-down instance, still free to write to the theme, the symbol preset or the
 * colour-blind flag, all of which are module-scope state of their own.
 *
 * That is cumulative rather than order-dependent, which is why it looked like nothing: a suite
 * passes alone and passes after two hundred predecessors, then fails somewhere past a thousand,
 * with a different case each run. The mermaid renderer producing NO output at all in a large run is
 * the recognisable shape of it, since what it renders depends on exactly this state.
 *
 * A listener that outlives its owner is a leak in a long session too, not only under a test runner;
 * `settingSignalListenerCounts` exists so a guard test can prove the set returns to empty.
 *
 * @internal
 */
export function resetSettingsForTest(): void {
	setSettingsInstance(null);
	setSettingsInstancePromise(null);
	configureProviderMaxInFlightRequests(undefined);
	clearSettingSignals();
	runSettingsTestResetHooks();
}

/**
 * The global settings singleton and the check for whether it exists yet.
 *
 * Both live in `./settings-instance.ts`, which owns the slot and imports nothing at runtime, and are
 * re-exported here because this is the name every caller already imports. A caller that needs only the
 * value should import the leaf directly: reaching it through this module costs 94 modules of store.
 */
export { isSettingsInitialized, settings } from "./settings-instance";
