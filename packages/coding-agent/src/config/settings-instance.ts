/** The process-global settings slot, and the `settings` proxy that reads it. The module that FILLS the slot is `config/settings.ts`, 2,768 lines that read `config.yml`, open */

import type { Settings } from "./settings";

/** What a caller sees when the slot is empty. One string because two places raise it, the proxy and `Settings.instance`, and an operator who greps the */
export const SETTINGS_NOT_INITIALIZED_MESSAGE = "Settings not initialized. Call Settings.init() first.";

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

/** Drop the cache of methods bound to the previous instance. The proxy binds each method once so repeated `settings.get` calls do not allocate, and a cache keyed by */
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

/** Extra teardown a downstream module asks `resetSettingsForTest` to run. settings store: writing `symbolPreset` runs a hook in `modes/theme/theme.ts`, which stores the result in */
const testResetHooks = new Set<() => void>();

/** Register teardown that runs whenever `resetSettingsForTest` does. Call it once at module scope. The returned function unregisters, which only the suite testing this */
export function registerSettingsTestResetHook(hook: () => void): () => void {
	testResetHooks.add(hook);
	return () => {
		testResetHooks.delete(hook);
	};
}

/** Run every registered teardown. Called by `resetSettingsForTest` and by nothing else. */
export function runSettingsTestResetHooks(): void {
	for (const hook of testResetHooks) hook();
}

/** The global settings singleton, as a proxy over the slot. Must call `Settings.init()` before using. Reading any property before that throws rather than returning */
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
