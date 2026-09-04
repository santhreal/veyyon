/**
 * The collab client's theme, bound to React.
 *
 * The store itself is `createThemeStore` in `@veyyon/utils/theme-store`, shared with the
 * stats dashboard: both pages resolve a preference against the browser's, write it onto
 * `<html>`, and notify their readers, and each used to carry its own copy of that. Only
 * the storage key and this React binding are local, and the binding stays here because
 * `@veyyon/utils` has no UI dependency.
 */

import { createThemeStore, type SystemTheme, type ThemePreference } from "@veyyon/utils/theme-store";
import { useSyncExternalStore } from "react";

export type { SystemTheme, ThemePreference };

const store = createThemeStore({ storageKey: "veyyon-collab-theme" });

/** Choose a preference. Applies it to the page and notifies every reader. */
export const setThemePreference = store.setPreference;

/** Reader for the active resolved theme. Reflects the system default and any override. */
export function useSystemTheme(): SystemTheme {
	return useSyncExternalStore(store.subscribe, store.getResolved, () => "dark" as SystemTheme);
}

/** Reader + writer for the theme preference (powers the toggle). */
export function useThemePreference(): {
	preference: ThemePreference;
	resolved: SystemTheme;
	setPreference: (next: ThemePreference) => void;
} {
	const preference = useSyncExternalStore(store.subscribe, store.getPreference, () => "system" as ThemePreference);
	const resolved = useSyncExternalStore(store.subscribe, store.getResolved, () => "dark" as SystemTheme);
	return { preference, resolved, setPreference: store.setPreference };
}
