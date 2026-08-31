/**
 * The process-global settings slot, and the `settings` proxy that reads it.
 *
 * WHY THIS IS NOT IN `settings.ts`. The slot is a nullable variable and the proxy is twenty lines over it.
 * The module that FILLS the slot is `config/settings.ts`, 2,768 lines that read `config.yml`, open
 * `agent.db`, migrate legacy keys, hold the schema and every setting signal, and reach 94 modules. Reading
 * one boolean cost all of it: `internal-urls/vault-protocol.ts` asks whether the vault is enabled and paid
 * 32 marginal modules for the question, and `tui/hyperlink.ts` and `modes/theme/shimmer.ts` ask the same
 * kind of question. Splitting the slot out means asking costs one module, and filling it still costs what
 * filling it has always cost.
 *
 * WHY THIS CANNOT SILENTLY RETURN A DEFAULT. `settingsOrThrow` and the proxy THROW when the slot is empty,
 * naming `Settings.init()`, because an empty slot means the process never initialised settings and every
 * value a caller would read is a guess. A caller that genuinely has something to do without settings asks
 * `isSettingsInitialized()` first and supplies its own default from the schema, which is what
 * `vault-protocol.ts` does; that is a decision at the call site rather than a fallback hidden here.
 *
 * THERE IS STILL EXACTLY ONE SLOT. `settings.ts` does not keep its own copy: `Settings.init`,
 * `Settings.instance` and `resetSettingsForTest` all go through the setters below, so there is one variable
 * to write and one to read. `packages/coding-agent/test/config/settings-instance.test.ts` pins that.
 *
 * This module imports nothing at runtime. `Settings` is a type-only import, which is what keeps it a leaf:
 * `import type` is erased, while dropping the `type` keyword would pull the whole store back in and put the
 * 94 modules back on every consumer.
 */

import type { Settings } from "./settings";

/**
 * What a caller sees when the slot is empty.
 *
 * One string because two places raise it, the proxy and `Settings.instance`, and an operator who greps the
 * message should land on one definition rather than wonder which of two paths produced it.
 */
export const SETTINGS_NOT_INITIALIZED_MESSAGE = "Settings not initialized. Call Settings.init() first.";

let globalInstance: Settings | null = null;
let globalInstancePromise: Promise<Settings> | null = null;
let boundSettingsInstance: Settings | null = null;
let boundSettingsMethods = new Map<PropertyKey, unknown>();

/**
 * Drop the cache of methods bound to the previous instance.
 *
 * The proxy binds each method once so repeated `settings.get` calls do not allocate, and a cache keyed by
 * property name outlives the instance it was bound against. Calling this whenever the slot changes is what
 * stops a torn-down instance from being reachable through a bound method.
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
 * WHY A REGISTRY RATHER THAN DIRECT CALLS. The state a settings change lands in does not live in the
 * settings store: writing `symbolPreset` runs a hook in `modes/theme/theme.ts`, which stores the result in
 * ITS module scope, and that value is what a renderer reads afterwards. So resetting settings without
 * resetting the theme leaves the run holding whatever preset the last suite chose, and a later suite draws
 * ASCII box characters where it expected Unicode ones. Calling into the theme from the store would invert
 * the layering (settings is below the UI), so the theme registers instead, at import, and only if it was
 * imported at all.
 *
 * WHY IT LIVES HERE RATHER THAN IN `settings.ts`. Registering is what a UI module does, and the registrars
 * are cheap modules: `modes/theme/markdown-theme.ts` registers one hook and had to import the whole store
 * to reach the function, 95 modules for a `Set.add`. Running the hooks is what the store does, and it
 * already imports this module for the slot.
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
