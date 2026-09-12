import { SettingSignal } from "@veyyon/kernel/settings/signal";

export const autoThemeMappingSignal = new SettingSignal<[slot: "dark" | "light", themeName: string]>("theme mapping");

/**
 * Subscribe to `theme.dark` / `theme.light` changes. Returns an unsubscribe
 * function. `theme/theme` subscribes at its own import.
 */
export const onAutoThemeMappingChanged = (
	cb: (slot: "dark" | "light", themeName: string) => void,
	options?: { readonly permanent?: boolean },
) => autoThemeMappingSignal.on(cb, options);

/** Fires when `symbolPreset` changes at runtime. */
export const symbolPresetSignal = new SettingSignal<[preset: "unicode" | "nerd" | "ascii"]>("symbolPreset");

/** Subscribe to `symbolPreset` changes. Returns an unsubscribe function. */
export const onSymbolPresetChanged = (
	cb: (preset: "unicode" | "nerd" | "ascii") => void,
	options?: { readonly permanent?: boolean },
) => symbolPresetSignal.on(cb, options);

/** Fires when `colorBlindMode` changes at runtime. */
export const colorBlindModeSignal = new SettingSignal<[enabled: boolean]>("colorBlindMode");

/** Subscribe to `colorBlindMode` changes. Returns an unsubscribe function. */
export const onColorBlindModeChanged = (cb: (enabled: boolean) => void, options?: { readonly permanent?: boolean }) =>
	colorBlindModeSignal.on(cb, options);

/** Fires when `provider.appendOnlyContext` changes at runtime. */
export const appendOnlyModeSignal = new SettingSignal<[value: string]>("provider.appendOnlyContext");

/**
 * Subscribe to append-only mode setting changes.
 * Returns an unsubscribe function. Multiple sessions (main + spawned agents)
 * can register independently without overwriting each other.
 */
export const onAppendOnlyModeChanged = (cb: (value: string) => void) => appendOnlyModeSignal.on(cb);

/** Fires when any model role changes at runtime. */
export const modelRolesSignal = new SettingSignal("modelRoles");

/** Subscribe to model role changes. Returns an unsubscribe function. */
export const onModelRolesChanged: (cb: () => void) => () => void = modelRolesSignal.on.bind(modelRolesSignal);

/** Fires when `statusLine.sessionAccent` changes at runtime. */
export const statusLineSessionAccentSignal = new SettingSignal("statusLine.sessionAccent");

/**
 * Subscribe to session-accent setting changes.
 * Returns an unsubscribe function. Callers should re-read settings in the callback.
 */
export const onStatusLineSessionAccentChanged = (cb: () => void) => statusLineSessionAccentSignal.on(cb);

/** Fires when any `hindsight.bankId` / `bankIdPrefix` / `scoping` value changes. */
export const hindsightScopeSignal = new SettingSignal("hindsight scope");

/**
 * Subscribe to changes in the Hindsight bank-scoping settings. Lets the
 * Hindsight backend rebuild the active `HindsightSessionState` when the
 * operator switches `hindsight.bankId`, `hindsight.bankIdPrefix`, or
 * `hindsight.scoping` mid-session so subsequent retain/recall calls land in
 * the new bank instead of the one selected at session start.
 *
 * Returns an unsubscribe function. The callback receives no arguments — the
 * caller is expected to re-read the relevant settings via `Settings.get`.
 */
export const onHindsightScopeChanged = (cb: () => void) => hindsightScopeSignal.on(cb);
