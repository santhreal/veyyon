/**
 * The page theme store: one preference, resolved once, read by the whole page.
 *
 * WHY THIS SUITE EXISTS. Two browser bundles (the collab client and the stats dashboard)
 * each carried a byte-identical copy of this store, and NEITHER copy had a single test:
 * every one of its properties lived only in a browser nobody was checking. The copies also
 * disagreed about one thing, and the disagreement was a crash. The stats copy guarded
 * storage with `typeof localStorage === "undefined"`, which does not catch the getter
 * THROWING, as it does in Safari private browsing and wherever storage is blocked by
 * policy; the read ran at module scope, so for those readers the dashboard did not fail to
 * remember a preference, it failed to start.
 *
 * The store now takes its browser access through a {@link ThemeEnvironment}, which is what
 * makes all of this assertable without a DOM: a fake environment reports a system
 * preference, records what was written to the document, and fires the change event on
 * demand. The storage guard itself is asserted against the REAL environment, since a fake
 * would replace the very code that was wrong.
 */

import { describe, expect, it } from "bun:test";
import { moduleSpecifiersIn } from "../src/module-reach";
import { createThemeStore, type SystemTheme, type ThemeEnvironment } from "../src/theme-store";

interface FakeEnvironment extends ThemeEnvironment {
	/** Every theme handed to `apply`, in order. What the page actually rendered. */
	applied: SystemTheme[];
	/** What was persisted, or null when nothing was. */
	stored: string | null;
	/** Fire the browser's preference-changed event. */
	changeSystem(next: SystemTheme): void;
}

function fakeEnvironment(options: { stored?: string | null; system?: SystemTheme } = {}) {
	let system: SystemTheme = options.system ?? "light";
	let listener: (() => void) | undefined;
	const env: FakeEnvironment = {
		applied: [],
		stored: options.stored ?? null,
		readStored(): string | null {
			return env.stored;
		},
		writeStored(value: string): void {
			env.stored = value;
		},
		systemTheme: () => system,
		onSystemChange(next: () => void): void {
			listener = next;
		},
		apply(theme: SystemTheme): void {
			env.applied.push(theme);
		},
		changeSystem(next: SystemTheme): void {
			system = next;
			listener?.();
		},
	};
	return env;
}

describe("the preference the store starts from", () => {
	/** Nothing stored is the first visit, and following the browser is the right default. */
	it("follows the system when nothing is stored", () => {
		const env = fakeEnvironment({ stored: null, system: "light" });

		const store = createThemeStore({ storageKey: "k", environment: env });

		expect(store.getPreference()).toBe("system");
		expect(store.getResolved()).toBe("light");
	});

	it("restores each stored preference, and resolves an explicit one to itself", () => {
		for (const stored of ["light", "dark"] as const) {
			const env = fakeEnvironment({ stored, system: stored === "light" ? "dark" : "light" });

			const store = createThemeStore({ storageKey: "k", environment: env });

			expect(store.getPreference()).toBe(stored);
			expect(store.getResolved()).toBe(stored);
		}
	});

	it("restores a stored `system` and resolves it against the browser", () => {
		const env = fakeEnvironment({ stored: "system", system: "dark" });

		expect(createThemeStore({ storageKey: "k", environment: env }).getResolved()).toBe("dark");
	});

	/** A value from an older version, or one a person edited by hand, must not become the theme. */
	it("treats an unrecognised stored value as following the system", () => {
		const env = fakeEnvironment({ stored: "solarized", system: "light" });

		const store = createThemeStore({ storageKey: "k", environment: env });

		expect(store.getPreference()).toBe("system");
		expect(store.getResolved()).toBe("light");
	});

	/**
	 * The page is already on screen when the store is built, so the theme has to be written
	 * to the document immediately: waiting for the first render flashes the wrong theme.
	 */
	it("applies the resolved theme to the document as soon as it is created", () => {
		const env = fakeEnvironment({ stored: "dark" });

		createThemeStore({ storageKey: "k", environment: env });

		expect(env.applied).toEqual(["dark"]);
	});
});

describe("storage that cannot be reached", () => {
	/**
	 * THE stats bug, asserted against the REAL browser environment rather than a fake, because
	 * the bug was in exactly the code the fake would have replaced. `localStorage` does not
	 * merely go missing when storage is blocked: in Safari private browsing and under a
	 * blocked-storage policy the property THROWS on access. The stats copy guarded with
	 * `typeof localStorage === "undefined"` and read at module scope, so for those readers the
	 * dashboard did not forget a preference, it failed to start.
	 */
	function withThrowingStorage<T>(body: () => T): T {
		const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			get() {
				throw new Error("SecurityError: storage is blocked");
			},
		});
		try {
			return body();
		} finally {
			if (original) Object.defineProperty(globalThis, "localStorage", original);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
	}

	it("still builds a working store when touching storage throws", () => {
		withThrowingStorage(() => {
			const store = createThemeStore({ storageKey: "veyyon-test-theme" });

			expect(store.getPreference()).toBe("system");
			// No browser here, so the resolution falls back rather than throwing.
			expect(store.getResolved()).toBe("dark");
		});
	});

	/** And a choice still applies for the session, even though it cannot be remembered. */
	it("still applies and announces a preference it cannot persist", () => {
		withThrowingStorage(() => {
			const store = createThemeStore({ storageKey: "veyyon-test-theme" });
			let notified = 0;
			store.subscribe(() => {
				notified++;
			});

			store.setPreference("light");

			expect(store.getResolved()).toBe("light");
			expect(store.getPreference()).toBe("light");
			expect(notified).toBe(1);
		});
	});
});

describe("running where there is no browser", () => {
	/**
	 * The package compiles for a CLI as well, and a barrel import must not reach for `window`
	 * or `document`. Nothing here is a browser, so this whole file is that assertion: the
	 * store resolves to the fallback and applies to nothing, without throwing.
	 */
	it("resolves to dark and applies to nothing", () => {
		const store = createThemeStore({ storageKey: "veyyon-test-theme" });

		expect(store.getResolved()).toBe("dark");

		store.setPreference("light");

		expect(store.getResolved()).toBe("light");
	});
});

describe("choosing a preference", () => {
	it("persists it, applies it, and notifies every reader", () => {
		const env = fakeEnvironment({ system: "light" });
		const store = createThemeStore({ storageKey: "k", environment: env });
		const seen: string[] = [];
		store.subscribe(() => seen.push(store.getResolved()));

		store.setPreference("dark");

		expect(env.stored).toBe("dark");
		expect(store.getPreference()).toBe("dark");
		expect(store.getResolved()).toBe("dark");
		expect(env.applied.at(-1)).toBe("dark");
		expect(seen).toEqual(["dark"]);
	});

	/** Going back to `system` re-reads the browser rather than keeping the last explicit theme. */
	it("returns to the browser's preference when set back to system", () => {
		const env = fakeEnvironment({ stored: "light", system: "dark" });
		const store = createThemeStore({ storageKey: "k", environment: env });

		store.setPreference("system");

		expect(env.stored).toBe("system");
		expect(store.getResolved()).toBe("dark");
	});

	/**
	 * Every reader resolves through the ONE store. This is the property the store exists for:
	 * with a value per component, the toggle would move part of the page.
	 */
	it("gives every subscriber the same resolved theme", () => {
		const env = fakeEnvironment({ system: "light" });
		const store = createThemeStore({ storageKey: "k", environment: env });
		const reads: SystemTheme[] = [];
		for (let i = 0; i < 3; i++) store.subscribe(() => reads.push(store.getResolved()));

		store.setPreference("dark");

		expect(reads).toEqual(["dark", "dark", "dark"]);
	});
});

describe("the browser changing its preference", () => {
	/** While following the system, the desktop switching to dark must move the page. */
	it("moves the theme while the preference is system", () => {
		const env = fakeEnvironment({ stored: "system", system: "light" });
		const store = createThemeStore({ storageKey: "k", environment: env });
		let notified = 0;
		store.subscribe(() => {
			notified++;
		});

		env.changeSystem("dark");

		expect(store.getResolved()).toBe("dark");
		expect(env.applied.at(-1)).toBe("dark");
		expect(notified).toBe(1);
	});

	/**
	 * An explicit choice outranks the desktop. Someone who picked light on a dark desktop
	 * asked for light, and honouring the media query here would undo their choice with no
	 * way to see why.
	 */
	it("leaves an explicit preference alone", () => {
		const env = fakeEnvironment({ stored: "light", system: "light" });
		const store = createThemeStore({ storageKey: "k", environment: env });
		let notified = 0;
		store.subscribe(() => {
			notified++;
		});

		env.changeSystem("dark");

		expect(store.getResolved()).toBe("light");
		expect(notified).toBe(0);
	});

	/** A change that resolves to the same theme is not a render. */
	it("does not notify when the resolved theme did not move", () => {
		const env = fakeEnvironment({ stored: "system", system: "dark" });
		const store = createThemeStore({ storageKey: "k", environment: env });
		let notified = 0;
		store.subscribe(() => {
			notified++;
		});

		env.changeSystem("dark");

		expect(notified).toBe(0);
	});
});

describe("subscribing", () => {
	it("stops notifying after unsubscribe", () => {
		const env = fakeEnvironment();
		const store = createThemeStore({ storageKey: "k", environment: env });
		let notified = 0;
		const unsubscribe = store.subscribe(() => {
			notified++;
		});

		store.setPreference("dark");
		unsubscribe();
		store.setPreference("light");

		expect(notified).toBe(1);
	});

	/** Two stores are two pages. One must not answer for the other. */
	it("keeps two stores independent", () => {
		const first = createThemeStore({ storageKey: "a", environment: fakeEnvironment({ system: "light" }) });
		const second = createThemeStore({ storageKey: "b", environment: fakeEnvironment({ system: "light" }) });

		first.setPreference("dark");

		expect(second.getResolved()).toBe("light");
	});
});

describe("the two browser bundles", () => {
	/**
	 * The lock. Both had the whole store, ~90 lines each, differing only in a storage key and
	 * in the storage guard that was the bug. What stays local is the React binding, because
	 * `@veyyon/utils` carries no UI dependency, and the storage key, which is per app.
	 *
	 * Asserted as the parsed import EDGE. The consumers are React modules in other packages, so
	 * importing them here to compare function identity would pull a UI dependency into this
	 * package's tests; the edge is what is checkable from here. What this deliberately no longer
	 * does is scan for the absence of `function applyResolvedTheme(`, `localStorage.getItem` and
	 * four more literals: a private copy named `applyTheme` satisfied every one of them, while a
	 * consumer legitimately calling `addEventListener` for anything else turned them red. The edge
	 * is the claim the title actually makes.
	 */
	it("bind the shared store instead of defining their own", async () => {
		const packages = path("../..");
		for (const file of ["collab-web/src/lib/theme.ts", "stats/src/client/useSystemTheme.ts"]) {
			const text = await Bun.file(`${packages}/${file}`).text();

			expect(moduleSpecifiersIn(text), file).toContain("@veyyon/utils/theme-store");
		}
	});
});

/** Resolve a path relative to this test file. */
function path(relative: string): string {
	return new URL(relative, import.meta.url).pathname;
}
