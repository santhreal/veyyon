export type SystemTheme = "light" | "dark";

export type ThemePreference = "system" | "light" | "dark";

export interface ThemeEnvironment {
	readStored(): string | null;
	writeStored(value: string): void;
	systemTheme(): SystemTheme;
	onSystemChange(listener: () => void): void;
	apply(theme: SystemTheme): void;
}

export interface ThemeStore {
	getPreference(): ThemePreference;
	getResolved(): SystemTheme;
	setPreference(next: ThemePreference): void;
	subscribe(listener: () => void): () => void;
}

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

const FALLBACK_THEME: SystemTheme = "dark";

function asPreference(value: string | null): ThemePreference {
	return value === "light" || value === "dark" || value === "system" ? value : "system";
}

interface DarkSchemeQuery {
	matches: boolean;
	addEventListener(type: "change", listener: () => void): void;
}

interface ThemedDocumentElement {
	dataset: { theme?: string };
	style: { colorScheme: string };
}

function darkSchemeQuery(): DarkSchemeQuery | undefined {
	const matchMedia = (globalThis as { matchMedia?: (query: string) => DarkSchemeQuery }).matchMedia;
	if (typeof matchMedia !== "function") return undefined;
	return matchMedia.call(globalThis, DARK_SCHEME_QUERY);
}

function documentElement(): ThemedDocumentElement | undefined {
	return (globalThis as { document?: { documentElement?: ThemedDocumentElement } }).document?.documentElement;
}

function browserThemeEnvironment(storageKey: string): ThemeEnvironment {
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
			} catch {}
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
			root.style.colorScheme = theme;
		},
	};
}

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
