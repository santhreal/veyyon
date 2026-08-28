import { createThemeStore, type SystemTheme, type ThemePreference } from "@veyyon/utils/theme-store";
import { useSyncExternalStore } from "react";

export type { SystemTheme, ThemePreference };

const store = createThemeStore({ storageKey: "veyyon-stats-theme" });

export const setThemePreference = store.setPreference;

export function useSystemTheme(): SystemTheme {
	return useSyncExternalStore(store.subscribe, store.getResolved, () => "dark" as SystemTheme);
}

export function useThemePreference(): {
	preference: ThemePreference;
	resolved: SystemTheme;
	setPreference: (next: ThemePreference) => void;
} {
	const preference = useSyncExternalStore(store.subscribe, store.getPreference, () => "system" as ThemePreference);
	const resolved = useSyncExternalStore(store.subscribe, store.getResolved, () => "dark" as SystemTheme);
	return { preference, resolved, setPreference: store.setPreference };
}
