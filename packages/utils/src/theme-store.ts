/**
 * The resolved light/dark theme of a browser page, as one store the whole page reads.
 *
 * A page has a theme toggle (the writer) and many readers (charts, panels, a transcript),
 * and they must not each decide for themselves: an explicit override and the system
 * default have to resolve through one value, or the toggle moves some of the page. The
 * store holds the preference the person chose (`system`, `light`, `dark`), resolves it to
 * an actual theme, writes it onto `<html>` so CSS can key off it, and notifies readers.
 *
 * Two browser bundles had a byte-identical copy of this, differing only in their storage
 * key and in HOW they reached storage, and the difference was a bug (see
 * {@link browserThemeEnvironment}). It lives here so there is one copy, and it takes its
 * browser access through {@link ThemeEnvironment} so the resolution logic can be tested
 * without a DOM.
 *
 * This module is React-free on purpose: `@veyyon/utils` has no UI dependency. Each app
 * binds the store to its framework, which for React is `useSyncExternalStore` over
 * {@link ThemeStore.subscribe}.
 *
 * @example
 * const themeStore = createThemeStore({ storageKey: "veyyon-stats-theme" });
 * export const useTheme = () => useSyncExternalStore(themeStore.subscribe, themeStore.getResolved, () => "dark");
 */

/** An actual theme. What CSS and a chart palette need. */
export type SystemTheme = "light" | "dark";

/** What the person chose. `system` means "keep following the browser". */
export type ThemePreference = "system" | "light" | "dark";

/** Everything the store touches outside itself, so a test can supply all of it. */
export interface ThemeEnvironment {
	/** The stored preference string, or null when there is none or storage is unreachable. */
	readStored(): string | null;
	/** Persist the preference. Best effort: a failure must not stop the theme from changing. */
	writeStored(value: string): void;
	/** What the browser currently prefers. */
	systemTheme(): SystemTheme;
	/** Call back when the browser's preference changes. */
	onSystemChange(listener: () => void): void;
	/** Reflect the resolved theme onto the document, for CSS and for form controls. */
	apply(theme: SystemTheme): void;
}

export interface ThemeStore {
	/** The stored preference, including `system`. What a three-way toggle renders. */
	getPreference(): ThemePreference;
	/** The theme in effect: the preference, or the browser's when following the system. */
	getResolved(): SystemTheme;
	/** Choose a preference, persist it, apply it, and notify every reader. */
	setPreference(next: ThemePreference): void;
	/** Watch for changes. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
}

/** The dark-theme media query, spelled once. */
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** Dark when nothing is known: a page that renders light-first flashes white on a dark desktop. */
const FALLBACK_THEME: SystemTheme = "dark";

function asPreference(value: string | null): ThemePreference {
	return value === "light" || value === "dark" || value === "system" ? value : "system";
}

/*
 * The browser surfaces are reached through `globalThis` and described by the two minimal
 * shapes below, rather than through the DOM typings: this package compiles without the
 * `dom` lib, because most of it runs in a CLI, and adding the lib for one module would
 * make `document` and `window` type-check everywhere else in the package, where they are
 * always undefined at runtime.
 */

interface DarkSchemeQuery {
	matches: boolean;
	addEventListener(type: "change", listener: () => void): void;
}

interface ThemedDocumentElement {
	dataset: { theme?: string };
	style: { colorScheme: string };
}

/** The dark-scheme media query, or undefined outside a browser. */
function darkSchemeQuery(): DarkSchemeQuery | undefined {
	const matchMedia = (globalThis as { matchMedia?: (query: string) => DarkSchemeQuery }).matchMedia;
	if (typeof matchMedia !== "function") return undefined;
	return matchMedia.call(globalThis, DARK_SCHEME_QUERY);
}

/** The `<html>` element, or undefined outside a browser. */
function documentElement(): ThemedDocumentElement | undefined {
	return (globalThis as { document?: { documentElement?: ThemedDocumentElement } }).document?.documentElement;
}

/**
 * The real browser environment for a given storage key.
 *
 * Every storage access is wrapped in try/catch, and that is the whole reason this is one
 * function rather than two: reading `localStorage` THROWS outright in Safari private
 * browsing and wherever storage is blocked by policy, and it is not merely undefined. One
 * of the two copies of this store guarded with `typeof localStorage === "undefined"`,
 * which does not catch a throwing getter, and it read storage at module scope, so the
 * whole bundle failed to start for anyone browsing with storage blocked. A person who
 * cannot persist a preference should still get a themed page for the session.
 */
export function browserThemeEnvironment(storageKey: string): ThemeEnvironment {
	return {
		readStored(): string | null {
			try {
				return globalThis.localStorage.getItem(storageKey);
			} catch {
				return null;
			}
		},
		writeStored(value: string): void {
			try {
				globalThis.localStorage.setItem(storageKey, value);
			} catch {
				// Persistence is best effort; the in-memory preference still applies.
			}
		},
		systemTheme(): SystemTheme {
			const query = darkSchemeQuery();
			return query ? (query.matches ? "dark" : "light") : FALLBACK_THEME;
		},
		onSystemChange(listener: () => void): void {
			darkSchemeQuery()?.addEventListener("change", listener);
		},
		apply(theme: SystemTheme): void {
			const root = documentElement();
			if (!root) return;
			root.dataset.theme = theme;
			// `color-scheme` is what themes the scrollbars and the native form controls, which
			// CSS variables cannot reach.
			root.style.colorScheme = theme;
		},
	};
}

/**
 * Build the page's theme store.
 *
 * Creating the store reads the stored preference and applies it immediately, because the
 * page is already on screen by then and a second paint would flash. It also starts
 * following the browser's preference, which moves the theme only while the preference is
 * `system`: an explicit choice is not overridden by the desktop changing.
 */
export function createThemeStore(options: { storageKey: string; environment?: ThemeEnvironment }): ThemeStore {
	const env = options.environment ?? browserThemeEnvironment(options.storageKey);
	const listeners = new Set<() => void>();
	let preference = asPreference(env.readStored());
	let resolved: SystemTheme = preference === "system" ? env.systemTheme() : preference;

	const resolve = (): void => {
		resolved = preference === "system" ? env.systemTheme() : preference;
		env.apply(resolved);
	};
	const emit = (): void => {
		for (const listener of listeners) listener();
	};

	resolve();
	env.onSystemChange(() => {
		// No preference check here on purpose: `resolve` already states the rule that an
		// explicit choice wins, so a browser change against `light` re-derives `light` and
		// stops at the comparison below. Repeating the rule here would be a second place to
		// keep in step, and it is redundant rather than defensive.
		const before = resolved;
		resolve();
		if (resolved !== before) emit();
	});

	return {
		getPreference: () => preference,
		getResolved: () => resolved,
		setPreference(next: ThemePreference): void {
			preference = next;
			env.writeStored(next);
			resolve();
			emit();
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
