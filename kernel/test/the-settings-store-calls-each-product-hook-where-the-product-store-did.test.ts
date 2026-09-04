/**
 * WHY: the layered settings store moved into the kernel and everything it knew about one product's
 * settings — the machine-wide bindings, the migrations, the legacy stores, the side effects, the
 * per-directory resolution — became a hook set the store takes at construction. The product's
 * behaviour is unchanged only if the store calls each hook at the point the product's own store ran
 * the same code, with the same arguments, and on the same instances: a migration that skips the
 * initial overrides, a side effect fired on a fork, or a cache the store forgets to drop is a
 * defect no product suite names, because every product suite drives the composed product and
 * reads the effect rather than the call. This suite drives the kernel store with a recording hook
 * set and pins the sequence.
 *
 * It also pins what the store does on its own: the three layers and their precedence, the
 * provenance of a value, a value read from one layer, the registry-driven path handling, and the
 * first-run fold of a legacy store into the profile file.
 *
 * What it does not catch: a product hook whose own body is wrong. That is the product's, and its
 * suites drive the composed store.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	declareSettings,
	resetDeclaredSettingsForTest,
	type SettingPath,
	type SettingsTable,
} from "@veyyon/kernel/settings/schema";
import {
	type GlobalSettingBinding,
	type RawSettings,
	type SettingsOptions,
	SettingsStore,
	type SettingsStoreHooks,
	stampOwnedConfigMigrations,
} from "@veyyon/kernel/settings/store";

const STORE_SETTINGS = {
	"store.flag": { type: "boolean", default: false },
	"store.name": { type: "string", default: "plain" },
	"store.list": { type: "array", default: [] as readonly string[] },
	"store.penalty": {
		type: "number",
		default: undefined,
		ui: {
			tab: "global",
			label: "Penalty",
			description: "An optional number.",
			options: [{ value: "default", label: "Default" }],
		},
	},
	"machine.version": { type: "number", default: 0 },
} as const satisfies SettingsTable;

type StoreSettings = typeof STORE_SETTINGS;

declare module "@veyyon/kernel/settings/schema" {
	interface DeclaredSettings extends StoreSettings {}
}

// From an empty registry, whichever sibling suite the runner loaded first in this process.
beforeAll(() => {
	resetDeclaredSettingsForTest();
	declareSettings(STORE_SETTINGS);
});

type Call =
	| ["migrate", RawSettings]
	| ["resolveForCwd", string, unknown, string]
	| ["applyHook", string, unknown, unknown]
	| ["applyAllHooks"]
	| ["notifyEffectiveChange", string]
	| ["mergedViewRebuilt"]
	| ["loadLegacySources", string]
	| ["afterOwnedConfigLoaded", string];

/** A hook set that records every call and otherwise does the least a product could. */
class RecordingHooks implements SettingsStoreHooks {
	readonly calls: Call[] = [];
	machine = 0;
	legacy: RawSettings | null = null;
	binding: GlobalSettingBinding = {
		read: () => this.machine,
		write: value => {
			this.machine = value as number;
		},
	};

	globalBinding(path: string): GlobalSettingBinding | undefined {
		return path === "machine.version" ? this.binding : undefined;
	}

	migrate(raw: RawSettings): RawSettings {
		this.calls.push(["migrate", structuredClone(raw)]);
		if (typeof raw.legacyName === "string") {
			raw.store = { ...(raw.store as RawSettings | undefined), name: raw.legacyName };
			delete raw.legacyName;
		}
		return raw;
	}

	async loadLegacySources(agentDir: string, migrate: (raw: RawSettings) => RawSettings): Promise<RawSettings | null> {
		this.calls.push(["loadLegacySources", agentDir]);
		return this.legacy ? migrate(this.legacy) : null;
	}

	async afterOwnedConfigLoaded(agentDir: string): Promise<void> {
		this.calls.push(["afterOwnedConfigLoaded", agentDir]);
	}

	resolveForCwd(path: SettingPath, value: unknown, cwd: string): unknown {
		this.calls.push(["resolveForCwd", path, value, cwd]);
		return path === "store.list" && Array.isArray(value) ? value.map(item => `${cwd}:${item}`) : undefined;
	}

	applyHook(path: SettingPath, next: unknown, prev: unknown): void {
		this.calls.push(["applyHook", path, next, prev]);
	}

	applyAllHooks(): void {
		this.calls.push(["applyAllHooks"]);
	}

	notifyEffectiveChange(path: SettingPath): void {
		this.calls.push(["notifyEffectiveChange", path]);
	}

	mergedViewRebuilt(): void {
		this.calls.push(["mergedViewRebuilt"]);
	}

	names(): string[] {
		return this.calls.map(call => call[0]);
	}
}

function inMemory(overrides?: SettingsOptions["overrides"]): { store: SettingsStore; hooks: RecordingHooks } {
	const hooks = new RecordingHooks();
	const store = new SettingsStore({ inMemory: true, cwd: "/work", overrides }, hooks);
	store.rebuildMerged();
	return { store, hooks };
}

let agentDir: string;

beforeEach(async () => {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-kernel-store-"));
});

afterEach(async () => {
	await fs.rm(agentDir, { recursive: true, force: true });
});

describe("registered settings snapshots", () => {
	// A key-count cache can retain another table's paths after reset/redeclaration.
	// Exercise every declared fixture path, including undefined and array defaults.
	// Timing and application schema composition are covered outside this suite.
	it("invalidates the path index across empty, replacement, and growing registries", () => {
		const entries = Object.entries(STORE_SETTINGS);
		try {
			for (let index = 0; index < entries.length; index++) {
				const [firstPath, firstDef] = entries[index]!;
				const [nextPath, nextDef] = entries[(index + 1) % entries.length]!;
				resetDeclaredSettingsForTest();
				declareSettings({ [firstPath]: firstDef });
				const { store } = inMemory();
				expect(store.getEffectiveSnapshot()).toEqual({ [firstPath]: firstDef.default });

				resetDeclaredSettingsForTest();
				expect(() => store.getEffectiveSnapshot()).toThrow("No settings are declared");
				declareSettings({ [nextPath]: nextDef });
				const replaced = store.getEffectiveSnapshot();
				expect(Object.keys(replaced)).toEqual([nextPath]);
				expect(replaced).toEqual({ [nextPath]: nextDef.default });

				declareSettings({ [firstPath]: firstDef });
				expect(store.getEffectiveSnapshot()).toEqual({
					[firstPath]: firstDef.default,
					[nextPath]: nextDef.default,
				});
			}
		} finally {
			resetDeclaredSettingsForTest();
			declareSettings(STORE_SETTINGS);
		}
	});
});

describe("the sources a migration sees", () => {
	it("migrates the initial overrides at construction, after the dotted-key expansion", () => {
		const { store, hooks } = inMemory({ "store.flag": true, legacyName: "old" } as SettingsOptions["overrides"]);

		expect(hooks.calls[0]).toEqual(["migrate", { store: { flag: true }, legacyName: "old" }]);
		expect(store.get("store.name")).toBe("old");
	});

	it("migrates the profile file and each overlay, and folds a first run's legacy store into the file", async () => {
		const hooks = new RecordingHooks();
		hooks.legacy = { legacyName: "from-legacy", store: { flag: true } };
		const overlay = path.join(agentDir, "overlay.yml");
		await fs.writeFile(overlay, "legacyName: from-overlay\n");
		const store = await new SettingsStore({ agentDir, cwd: "/work", configFiles: [overlay] }, hooks).load();

		expect(hooks.names()).toEqual([
			"loadLegacySources",
			"migrate",
			"migrate",
			"afterOwnedConfigLoaded",
			"migrate",
			"mergedViewRebuilt",
			"applyAllHooks",
		]);
		expect(hooks.calls[0]).toEqual(["loadLegacySources", agentDir]);
		expect(hooks.calls[3]).toEqual(["afterOwnedConfigLoaded", agentDir]);
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toContain("from-legacy");
		expect(store.get("store.name")).toBe("from-overlay");
		expect(store.getSource("store.name")).toBe("config-file");
		expect(store.get("store.flag")).toBe(true);
		expect(store.getSource("store.flag")).toBe("profile");
	});

	it("skips the legacy fold, the marker step and the side effects on a read-only load", async () => {
		const hooks = new RecordingHooks();
		hooks.legacy = { legacyName: "from-legacy" };
		const store = await new SettingsStore({ agentDir, cwd: "/work" }, hooks).loadReadOnly();

		expect(hooks.names()).toEqual(["mergedViewRebuilt"]);
		expect(store.get("store.name")).toBe("plain");
		await expect(fs.stat(path.join(agentDir, "config.yml"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("the side effect of a write", () => {
	it("applies the hook after the value is stored, with the next and the previous value, then notifies", () => {
		const { store, hooks } = inMemory();
		hooks.calls.length = 0;

		store.set("store.name", "next");

		expect(hooks.calls).toEqual([
			["mergedViewRebuilt"],
			["resolveForCwd", "store.name", "next", "/work"],
			["applyHook", "store.name", "next", "plain"],
			["notifyEffectiveChange", "store.name"],
		]);
	});

	it("applies the hook on an unset with the default as the next value", () => {
		const { store, hooks } = inMemory({ "store.name": "set" });
		hooks.calls.length = 0;

		store.unset("store.name");

		expect(hooks.calls.filter(call => call[0] === "applyHook")).toEqual([
			["applyHook", "store.name", "plain", "set"],
		]);
		expect(store.getSource("store.name")).toBe("default");
	});

	it("writes a bound setting through its binding on a persisting store, never the profile tree, and still applies the hook", async () => {
		const hooks = new RecordingHooks();
		const store = await new SettingsStore({ agentDir, cwd: "/work" }, hooks).load();
		hooks.calls.length = 0;

		store.set("machine.version", 3);
		await store.flush();

		expect(hooks.machine).toBe(3);
		expect(store.get("machine.version")).toBe(3);
		expect(store.getSource("machine.version")).toBe("global");
		expect(store.layerValue("profile", ["machine", "version"])).toBeUndefined();
		await expect(fs.stat(path.join(agentDir, "config.yml"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(hooks.calls).toEqual([
			["applyHook", "machine.version", 3, 0],
			["notifyEffectiveChange", "machine.version"],
		]);
	});

	it("keeps a bound write as a runtime override on an in-memory store, so the machine config is never touched", () => {
		const { store, hooks } = inMemory();
		hooks.calls.length = 0;

		store.set("machine.version", 3);

		expect(hooks.machine).toBe(0);
		expect(store.get("machine.version")).toBe(3);
		expect(store.getSource("machine.version")).toBe("runtime");
		expect(hooks.calls).toEqual([
			["mergedViewRebuilt"],
			["applyHook", "machine.version", 3, 0],
			["notifyEffectiveChange", "machine.version"],
		]);
	});

	it("does not notify when the effective value did not change, and never notifies from a fork", () => {
		const { store, hooks } = inMemory();
		store.set("store.name", "same");
		hooks.calls.length = 0;

		store.set("store.name", "same");
		expect(hooks.names()).not.toContain("notifyEffectiveChange");

		const fork = store.forkWithRuntimeOverrides({ "store.flag": true });
		hooks.calls.length = 0;
		fork.set("store.name", "forked");
		expect(fork.get("store.name")).toBe("forked");
		// The previous value is read first, which resolves it on the fork's own fresh cache.
		expect(hooks.names()).toEqual(["resolveForCwd", "mergedViewRebuilt", "resolveForCwd", "applyHook"]);
	});
});

describe("the merged view and what is derived from it", () => {
	it("resolves a value against the working directory once, until the view is rebuilt", () => {
		const { store, hooks } = inMemory({ "store.list": ["a"] });
		hooks.calls.length = 0;

		expect(store.get("store.list")).toEqual(["/work:a"]);
		expect(store.get("store.list")).toEqual(["/work:a"]);
		expect(hooks.calls).toEqual([["resolveForCwd", "store.list", ["a"], "/work"]]);

		store.override("store.flag", true);
		hooks.calls.length = 0;
		expect(store.get("store.list")).toEqual(["/work:a"]);
		expect(hooks.calls).toEqual([["resolveForCwd", "store.list", ["a"], "/work"]]);
	});

	it("re-resolves against a new working directory in place and re-applies every side effect", async () => {
		const { store, hooks } = inMemory({ "store.list": ["a"] });
		hooks.calls.length = 0;

		await store.reloadForCwd("/elsewhere");

		expect(store.getCwd()).toBe(path.normalize("/elsewhere"));
		expect(store.get("store.list")).toEqual(["/elsewhere:a"]);
		expect(hooks.calls.filter(call => call[0] === "notifyEffectiveChange")).toEqual([
			["notifyEffectiveChange", "store.list"],
		]);
		expect(hooks.names().at(-1)).toBe("applyAllHooks");
	});

	it("layers runtime over overlay over profile, and reports the layer that answers", () => {
		const { store } = inMemory();
		store.set("store.name", "profile");
		expect(store.getSource("store.name")).toBe("profile");

		store.override("store.name", "runtime");
		expect(store.get("store.name")).toBe("runtime");
		expect(store.getSource("store.name")).toBe("runtime");
		expect(store.layerValue("profile", ["store", "name"])).toBe("profile");
		expect(store.layerValue("runtime", ["store", "name"])).toBe("runtime");
		expect(store.layerValue("config-file", ["store", "name"])).toBeUndefined();

		store.clearOverride("store.name");
		expect(store.get("store.name")).toBe("profile");
	});

	it("reads an unregistered dotted path from the tree without a default rather than throwing", () => {
		const { store } = inMemory({ "future.knob": 7 } as SettingsOptions["overrides"]);

		expect(store.get("future.knob" as SettingPath)).toBe(7);
		expect(store.get("future.other" as SettingPath)).toBeUndefined();
		expect(store.isConfigured("future.knob" as SettingPath)).toBe(true);
	});

	it("snapshots every registered path, sorted, at its effective value", () => {
		const { store } = inMemory({ "store.flag": true });

		const snapshot = store.getEffectiveSnapshot();

		expect(Object.keys(snapshot)).toEqual(Object.keys(snapshot).slice().sort());
		expect(snapshot["store.flag"]).toBe(true);
		expect(snapshot["store.name"]).toBe("plain");
		expect(snapshot["machine.version"]).toBe(0);
	});
});

describe("a fork and a clone", () => {
	it("keeps every layer's provenance in a fork and adds the overrides through the migration", () => {
		const { store, hooks } = inMemory();
		store.set("store.name", "profile");
		hooks.calls.length = 0;

		const fork = store.forkWithRuntimeOverrides({ legacyName: "forked" } as SettingsOptions["overrides"]);

		expect(fork).toBeInstanceOf(SettingsStore);
		expect(fork.get("store.name")).toBe("forked");
		expect(fork.getSource("store.name")).toBe("runtime");
		expect(fork.layerValue("profile", ["store", "name"])).toBe("profile");
		expect(hooks.calls[0]?.[0]).toBe("migrate");
	});

	it("re-applies every side effect on a clone and not on a fork", async () => {
		const { store, hooks } = inMemory();
		hooks.calls.length = 0;

		store.forkWithRuntimeOverrides();
		expect(hooks.names()).not.toContain("applyAllHooks");

		const clone = await store.cloneForCwd("/other");
		expect(clone.getCwd()).toBe(path.normalize("/other"));
		expect(hooks.names().at(-1)).toBe("applyAllHooks");
	});
});

describe("the one-shot migration stamp", () => {
	it("strips a legacy unset sentinel from the owned config and stamps it on the first write to such a path", async () => {
		const hooks = new RecordingHooks();
		await fs.writeFile(path.join(agentDir, "config.yml"), "store:\n  penalty: -1\n  flag: true\n");
		const store = await new SettingsStore({ agentDir, cwd: "/work" }, hooks).load();

		expect(store.get("store.penalty")).toBeUndefined();
		store.set("store.penalty", -1);
		await store.flush();

		const written = await fs.readFile(path.join(agentDir, "config.yml"), "utf8");
		expect(written).toContain("settingsMigrationVersion: 1");
		expect(written).toContain("penalty: -1");
		expect(written).toContain("flag: true");
		expect(stampOwnedConfigMigrations({ store: { penalty: -1 }, settingsMigrationVersion: 1 })).toEqual([]);
	});
});
