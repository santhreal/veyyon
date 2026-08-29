import type { Settings } from "./settings";

export const SETTINGS_NOT_INITIALIZED_MESSAGE = "Settings not initialized. Call Settings.init() first.";

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

export function settingsOrNull(): Settings | null {
	return globalInstance;
}

export function settingsOrThrow(): Settings {
	if (!globalInstance) throw new Error(SETTINGS_NOT_INITIALIZED_MESSAGE);
	return globalInstance;
}

export function setSettingsInstance(instance: Settings | null): void {
	globalInstance = instance;
	clearBoundSettingsMethods();
}

export function settingsInstancePromise(): Promise<Settings> | null {
	return globalInstancePromise;
}

export function setSettingsInstancePromise(promise: Promise<Settings> | null): void {
	globalInstancePromise = promise;
}

const testResetHooks = new Set<() => void>();

export function registerSettingsTestResetHook(hook: () => void): () => void {
	testResetHooks.add(hook);
	return () => {
		testResetHooks.delete(hook);
	};
}

export function runSettingsTestResetHooks(): void {
	for (const hook of testResetHooks) hook();
}

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
