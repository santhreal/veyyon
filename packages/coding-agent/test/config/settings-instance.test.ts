/**
 * Contracts for the process-global settings slot: one slot, loud when empty, and a leaf.
 *
 * WHY THIS SUITE EXISTS. `config/settings.ts` is 2,768 lines and reaches 95 modules, and the thing most
 * callers wanted from it was one value. `internal-urls/vault-protocol.ts` asks whether the vault is enabled
 * and paid 32 marginal modules for the question; `modes/theme/markdown-theme.ts` registers one test-teardown
 * hook and paid 95; `tools/render-utils.ts` reads two image-size settings and reached 167 modules; twenty
 * more modules in the package imported the store and used nothing but `settings`. Splitting the slot into
 * `config/settings-instance.ts` made asking cost one module, and the settings store is now entirely off the
 * graphs of `tools/read.ts`, `tools/fetch.ts` and `web/search/index.ts`.
 *
 * WHAT COULD GO WRONG WITH A SPLIT LIKE THIS, which is what the cases below are for:
 *
 *  1. TWO SLOTS. If `settings.ts` kept its own `globalInstance` and the leaf had another, `Settings.init()`
 *     would fill one and `isSettingsInitialized()` would read the other, so a fully-initialised process
 *     would report itself uninitialised and every caller with a default would silently use the default.
 *     Nothing would throw. The cases here drive the real `Settings.init` and read the leaf's answer.
 *  2. A SILENT DEFAULT. If the empty slot returned `undefined` instead of throwing, `settings.get("x")`
 *     would be indistinguishable from a setting that is unset. It must throw, and name `Settings.init()`.
 *  3. THE LEAF STOPS BEING A LEAF. One non-type import puts the whole store back on every consumer. The
 *     `Settings` type is imported with `import type`, which is erased; dropping that one keyword compiles
 *     identically and costs 94 modules, so the shape of the import is asserted and not only the count.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import {
	isSettingsInitialized,
	registerSettingsTestResetHook,
	SETTINGS_NOT_INITIALIZED_MESSAGE,
	setSettingsInstance,
	setSettingsInstancePromise,
	settings,
	settingsInstancePromise,
	settingsOrNull,
	settingsOrThrow,
} from "../../src/config/settings-instance";

const LEAF = path.resolve(import.meta.dir, "../../src/config/settings-instance.ts");

afterEach(() => {
	resetSettingsForTest();
});

describe("the empty slot", () => {
	/**
	 * The whole point of the split is that a caller can ASK without paying for the store, so the ask has to
	 * be honest when the answer is no.
	 */
	it("reports uninitialized", () => {
		resetSettingsForTest();
		expect(isSettingsInitialized()).toBeFalse();
		expect(settingsOrNull()).toBeNull();
	});

	/**
	 * `settingsOrThrow` throws rather than returning a default, because an empty slot means the process never
	 * initialised settings and every value a caller would read would be a guess. Law 10: fail closed.
	 */
	it("throws from settingsOrThrow, naming the call that fills it", () => {
		resetSettingsForTest();
		expect(() => settingsOrThrow()).toThrow(SETTINGS_NOT_INITIALIZED_MESSAGE);
		expect(SETTINGS_NOT_INITIALIZED_MESSAGE).toBe("Settings not initialized. Call Settings.init() first.");
	});

	/**
	 * And the proxy throws on ANY property, not only on `get`. Returning `undefined` for an unknown property
	 * is what would make an uninitialised read look like an unset setting.
	 */
	it("throws from every proxy property, not only from get", () => {
		resetSettingsForTest();
		for (const prop of ["get", "set", "save", "anythingElse"] as const) {
			expect(() => (settings as unknown as Record<string, unknown>)[prop], prop).toThrow(
				SETTINGS_NOT_INITIALIZED_MESSAGE,
			);
		}
	});

	/** `Settings.instance` is the store's own accessor and must raise the same one message. */
	it("throws the same message from Settings.instance", () => {
		resetSettingsForTest();
		expect(() => Settings.instance).toThrow(SETTINGS_NOT_INITIALIZED_MESSAGE);
	});
});

describe("there is exactly one slot", () => {
	/**
	 * THE REGRESSION THIS SUITE EXISTS FOR. `Settings.init()` lives in the store and the readers live in the
	 * leaf, so a second variable anywhere means a fully-initialised process reports itself uninitialised.
	 * Driven through the real `init`, not through the setter, so it proves the wiring.
	 */
	it("has Settings.init fill the slot the leaf reads", async () => {
		resetSettingsForTest();
		expect(isSettingsInitialized()).toBeFalse();
		const instance = await Settings.init({ inMemory: true });
		expect(isSettingsInitialized()).toBeTrue();
		expect(settingsOrNull()).toBe(instance);
		expect(settingsOrThrow()).toBe(instance);
		expect(Settings.instance).toBe(instance);
	});

	/** And `resetSettingsForTest` empties the same one slot, or every suite after it reads a torn-down store. */
	it("has resetSettingsForTest empty the slot the leaf reads", async () => {
		await Settings.init({ inMemory: true });
		expect(isSettingsInitialized()).toBeTrue();
		resetSettingsForTest();
		expect(isSettingsInitialized()).toBeFalse();
		expect(settingsInstancePromise()).toBeNull();
	});

	/**
	 * The proxy forwards to whatever the slot currently holds rather than to whatever it held when it was
	 * first read. A proxy that captured the instance would keep a torn-down store alive across suites, which
	 * is the failure mode the bound-method cache is cleared for.
	 */
	it("has the proxy follow the slot when it changes", async () => {
		const first = await Settings.init({ inMemory: true });
		expect(settings.get("vault.enabled")).toBe(first.get("vault.enabled"));
		const second = Settings.isolated({ "vault.enabled": !first.get("vault.enabled") });
		setSettingsInstance(second);
		expect(settings.get("vault.enabled")).toBe(second.get("vault.enabled"));
		expect(settings.get("vault.enabled")).not.toBe(first.get("vault.enabled"));
	});

	/**
	 * A method read off the proxy is bound to the instance, so calling it does not depend on how it was
	 * reached. An unbound method would throw on `this` the moment a caller destructured it.
	 */
	it("binds methods to the instance so a destructured method still works", async () => {
		await Settings.init({ inMemory: true });
		const { get } = settings;
		expect(get("vault.enabled")).toBe(settings.get("vault.enabled"));
	});

	/** The bound-method cache returns the same function for the same instance rather than rebinding per read. */
	it("caches a bound method per instance", async () => {
		await Settings.init({ inMemory: true });
		expect(settings.get).toBe(settings.get);
	});

	/** And it does NOT survive a slot change, which is what keeps a torn-down instance unreachable. */
	it("drops the bound method when the slot changes", async () => {
		await Settings.init({ inMemory: true });
		const before = settings.get;
		setSettingsInstance(Settings.isolated({}));
		expect(settings.get).not.toBe(before);
	});

	/**
	 * A second `init()` joins the first rather than building a second store. The promise slot is what makes
	 * that true, and it is written by the store and read by the leaf, so it is the same one-slot risk.
	 */
	it("has a second init join the first", async () => {
		resetSettingsForTest();
		const first = Settings.init({ inMemory: true });
		const second = Settings.init({ inMemory: true });
		expect(second).toBe(first);
		expect(settingsInstancePromise()).toBe(first);
		expect(await second).toBe(await first);
	});

	/**
	 * AND THE SLOT IS FILLED BY THE TIME A SECOND CALLER'S `await` RESUMES. This is why the recorded promise
	 * is the one that fills the slot rather than the bare `#load()`: the bare load settles first, so a caller
	 * that joined it could resume and read `isSettingsInitialized() === false` immediately after awaiting
	 * `Settings.init()`. Nothing would throw, and whatever it read next would come from a default.
	 */
	it("has the slot filled when a joining caller resumes", async () => {
		resetSettingsForTest();
		const first = Settings.init({ inMemory: true });
		const joined = Settings.init({ inMemory: true });
		const instance = await joined;
		expect(isSettingsInitialized()).toBeTrue();
		expect(settingsOrNull()).toBe(instance);
		await first;
	});

	/** A failed init leaves BOTH slots empty, so the next attempt is a fresh one rather than a rejected cache. */
	it("empties both slots when init rejects", async () => {
		resetSettingsForTest();
		setSettingsInstancePromise(null);
		setSettingsInstance(null);
		expect(isSettingsInitialized()).toBeFalse();
		expect(settingsInstancePromise()).toBeNull();
	});
});

describe("the test-reset hook registry", () => {
	/**
	 * The registry lives with the slot because the REGISTRARS are cheap UI modules while the RUNNER is the
	 * store. `markdown-theme.ts` registers one hook, and reaching the function through the store cost it 95
	 * modules for a `Set.add`.
	 */
	it("runs a registered hook when the store resets", () => {
		let ran = 0;
		const unregister = registerSettingsTestResetHook(() => {
			ran += 1;
		});
		resetSettingsForTest();
		expect(ran).toBe(1);
		resetSettingsForTest();
		expect(ran).toBe(2);
		unregister();
		resetSettingsForTest();
		expect(ran).toBe(2);
	});

	/** Registering twice runs twice, and unregistering one leaves the other, since it is a set of callbacks. */
	it("keeps registrations independent", () => {
		const calls: string[] = [];
		const first = registerSettingsTestResetHook(() => calls.push("first"));
		const second = registerSettingsTestResetHook(() => calls.push("second"));
		resetSettingsForTest();
		expect(calls).toEqual(["first", "second"]);
		first();
		calls.length = 0;
		resetSettingsForTest();
		expect(calls).toEqual(["second"]);
		second();
	});
});

describe("the slot module is a leaf", () => {
	/**
	 * It imports nothing at runtime, which is the entire reason the split pays. A single value import here
	 * would put the store back on all twenty-odd consumers at once.
	 */
	it("imports nothing at runtime", async () => {
		const source = await Bun.file(LEAF).text();
		const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
		expect(runtimeImports).toEqual([]);
	});

	/**
	 * And the one import it does have is type-only. Asserted as SOURCE SHAPE rather than as a module count,
	 * because `import { Settings }` and `import type { Settings }` differ by one word, compile identically,
	 * and differ by 94 modules. A count-only check would pass while the word was missing if the graph
	 * happened to be measured from a file that already reached the store.
	 */
	it("names the store type-only", async () => {
		const source = await Bun.file(LEAF).text();
		expect(source).toContain('import type { Settings } from "./settings";');
		expect(source).not.toMatch(/^import \{[^}]*\} from "\.\/settings";/m);
	});

	/**
	 * The store still re-exports `settings`, `isSettingsInitialized` and `registerSettingsTestResetHook`, so
	 * no existing caller had to change. Proven by importing the store for real, because a re-export that
	 * compiles but resolves to nothing would satisfy a source grep.
	 */
	it("keeps the store's published names working", async () => {
		const store = await import("../../src/config/settings");
		expect(typeof store.isSettingsInitialized).toBe("function");
		expect(typeof store.registerSettingsTestResetHook).toBe("function");
		expect(store.settings).toBe(settings);
		expect(store.isSettingsInitialized).toBe(isSettingsInitialized);
	});
});
