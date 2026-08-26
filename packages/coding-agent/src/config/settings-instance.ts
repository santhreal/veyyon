/**
 * The process-global settings slot and the `settings` proxy. Split from `settings.ts` (2,768 lines,
 * 94 modules) so reading one boolean costs one module. `settingsOrThrow` and the proxy throw when the
 * slot is empty (call `isSettingsInitialized()` first for a default). One slot: `settings.ts` goes
 * through these setters. Type-only `Settings` import keeps this a leaf.
 */

import type { Settings } from "./settings";

/**
 * What a caller sees when the slot is empty.
 *
 * One string because two places raise it (proxy and `Settings.instance`); an operator who greps should
 * land on one definition.
 */
export const SETTINGS_NOT_INITIALIZED_MESSAGE = "Settings not initialized. Call Settings.init() first.";

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

/**
 * Drop the cache of methods bound to the previous instance.
 *
 * The proxy binds each method once so repeated `settings.get` calls do not allocate. The cache outlives
 * the instance; calling this when the slot changes stops a torn-down instance from being reachable.
 */
export function clearBoundSettingsMethods(): void {
	boundSettingsInstance = null;
	boundSettingsMethods = new Map<PropertyKey, unknown>();
}

/** Whether the process has initialised settings. Ask this before reading a value you have a default for. */
export function isSettingsInitialized(): boolean {
	return globalInstance !== null;
}

/** The initialised store, or `null`. For callers that carry their own default. */
export function settingsOrNull(): Settings | null {
	return globalInstance;
}

/** The initialised store, or a throw naming `Settings.init()`. Never a default. */
export function settingsOrThrow(): Settings {
	if (!globalInstance) throw new Error(SETTINGS_NOT_INITIALIZED_MESSAGE);
	return globalInstance;
}

/** Fill the slot. Called by `Settings.init` and by nothing else. */
export function setSettingsInstance(instance: Settings | null): void {
	globalInstance = instance;
	clearBoundSettingsMethods();
}

/** The in-flight or settled initialisation, so a second `init()` joins the first rather than racing it. */
export function settingsInstancePromise(): Promise<Settings> | null {
	return globalInstancePromise;
}

/** Record the in-flight initialisation. Called by `Settings.init` and by nothing else. */
export function setSettingsInstancePromise(promise: Promise<Settings> | null): void {
	globalInstancePromise = promise;
}

/**
 * Extra teardown a downstream module asks `resetSettingsForTest` to run.
 *
 * WHY A REGISTRY. Settings-change state doesn't live in the store: writing `symbolPreset` runs a hook in
 * `modes/theme/theme.ts` that stores the result in its own module scope. Resetting settings without
 * resetting the theme leaves the last suite's preset. The theme registers at import (not called from the
 * store, which would invert layering). Lives here not `settings.ts` because registrars are cheap modules.
 *
 * @internal
 */
const testResetHooks = new Set<() => void>();

/**
 * Register teardown that runs whenever `resetSettingsForTest` does.
 *
 * Call it once at module scope. The returned function unregisters, which only the suite testing this
 * mechanism uses.
 *
 * @internal
 */
export function registerSettingsTestResetHook(hook: () => void): () => void {
	testResetHooks.add(hook);
	return () => {
		testResetHooks.delete(hook);
	};
}

/**
 * Run every registered teardown. Called by `resetSettingsForTest` and by nothing else.
 *
 * @internal
 */
export function runSettingsTestResetHooks(): void {
	for (const hook of testResetHooks) hook();
}

/**
 * The global settings singleton, as a proxy over the slot.
 *
 * Must call `Settings.init()` before using. Reading any property before that throws rather than returning
 * `undefined`, because `settings.get("x") === undefined` is indistinguishable from a setting that is unset.
 */
export const settings = new Proxy({} as Settings, {
	get(_target, prop) {
		const instance = settingsOrThrow();
		if (boundSettingsInstance !== instance) {
			clearBoundSettingsMethods();
			boundSettingsInstance = instance;
		}
		const value = (instance as unknown as Record<PropertyKey, unknown>)[prop];
		if (typeof value === "function") {
			const cached = boundSettingsMethods.get(prop);
			if (cached) return cached;
			const bound = value.bind(instance);
			boundSettingsMethods.set(prop, bound);
			return bound;
		}
		return value;
	},
});
