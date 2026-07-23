import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	captureRegistryForTests,
	defineCapability,
	disableProvider,
	enableProvider,
	getCapabilityInfo,
	getDisabledProviders,
	initializeWithSettings,
	isForeignConfigImportEnabled,
	isProviderEnabled,
	listCapabilities,
	loadCapability,
	type Provider,
	type RegistrySnapshot,
	registerProvider,
	restoreRegistryForTests,
	setDisabledProviders,
} from "@veyyon/coding-agent/capability";
import type { Settings } from "@veyyon/coding-agent/config/settings";

/**
 * Hermetic coverage for the capability registry via the snapshot/restore seam.
 *
 * The registry (capability/index.ts) keeps ALL state in module-level Maps/Sets
 * with no per-test instance, and defineCapability throws on re-definition, so
 * before this seam existed (BACKLOG FINDING-CAPABILITY-REGISTRY-NO-HERMETIC-TEST-
 * SEAM) its real logic — priority-ordered insertion, foreign+disabled gating, the
 * disabled round-trip + settings persistence, and load dedup/shadow/validate —
 * could not be tested without permanently polluting global state.
 *
 * captureRegistryForTests()/restoreRegistryForTests() save and restore every
 * module-level map plus the foreign flag and settings, WITHOUT clearing
 * production-registered capabilities. Every test here captures in beforeEach and
 * restores in afterEach, so it leaves the registry byte-identical for other suites
 * (the final test asserts exactly that invariant).
 */

interface TestItem {
	name: string;
	valid: boolean;
	_source: { provider: string; providerName: string; path: string; level: "project" };
}

function item(name: string, opts: { valid?: boolean; path?: string } = {}): TestItem {
	return {
		name,
		valid: opts.valid ?? true,
		_source: { provider: "?", providerName: "?", path: opts.path ?? `/x/${name}`, level: "project" },
	};
}

function makeProvider(id: string, priority: number, items: TestItem[]): Provider<TestItem> {
	return {
		id,
		displayName: `${id}-name`,
		description: `${id}-desc`,
		priority,
		load: async () => ({ items }),
	};
}

/** Minimal Settings stub exposing only get/set, recording every set for
 *  persistence assertions. `disabledProviders` defaults to [] so
 *  initializeWithSettings can iterate it. */
function mockSettings(initial: Record<string, unknown> = {}): {
	settings: Settings;
	store: Map<string, unknown>;
	sets: Array<[string, unknown]>;
} {
	const store = new Map<string, unknown>(Object.entries({ disabledProviders: [], ...initial }));
	const sets: Array<[string, unknown]> = [];
	const settings = {
		get: (key: string) => store.get(key),
		set: (key: string, value: unknown) => {
			store.set(key, value);
			sets.push([key, value]);
		},
	} as unknown as Settings;
	return { settings, store, sets };
}

const CAP_ID = "test-cap-hermetic";

function defineTestCapability(): void {
	defineCapability<TestItem>({
		id: CAP_ID,
		displayName: "Test Cap",
		description: "hermetic test capability",
		key: it => it.name,
		validate: it => (it.valid ? undefined : "item is invalid"),
	});
}

let baseline: RegistrySnapshot;

beforeEach(() => {
	baseline = captureRegistryForTests();
});

afterEach(() => {
	restoreRegistryForTests(baseline);
});

describe("capability registry: priority-ordered provider insertion", () => {
	it("keeps providers sorted highest-priority-first regardless of registration order", () => {
		defineTestCapability();
		registerProvider(CAP_ID, makeProvider("p-mid", 20, []));
		registerProvider(CAP_ID, makeProvider("p-low", 10, []));
		registerProvider(CAP_ID, makeProvider("p-high", 30, []));

		const info = getCapabilityInfo(CAP_ID);
		expect(info?.providers.map(p => p.id)).toEqual(["p-high", "p-mid", "p-low"]);
		expect(info?.providers.map(p => p.priority)).toEqual([30, 20, 10]);
	});

	it("inserts an equal-priority provider after the existing one (stable, not before)", () => {
		defineTestCapability();
		registerProvider(CAP_ID, makeProvider("first", 50, []));
		registerProvider(CAP_ID, makeProvider("second", 50, []));
		// findIndex looks for the first STRICTLY-lower priority; an equal one is not
		// lower, so the newcomer lands after all equal-or-higher entries.
		expect(getCapabilityInfo(CAP_ID)?.providers.map(p => p.id)).toEqual(["first", "second"]);
	});
});

describe("capability registry: foreign + disabled provider gating", () => {
	it("gates FOREIGN providers behind importForeignConfig, leaving native providers enabled", () => {
		initializeWithSettings(mockSettings({ "discovery.importForeignConfig": false }).settings);
		expect(isForeignConfigImportEnabled()).toBe(false);
		// "claude" is a foreign id; "native" is not.
		expect(isProviderEnabled("claude")).toBe(false);
		expect(isProviderEnabled("native")).toBe(true);

		initializeWithSettings(mockSettings({ "discovery.importForeignConfig": true }).settings);
		expect(isForeignConfigImportEnabled()).toBe(true);
		expect(isProviderEnabled("claude")).toBe(true);
	});

	it("an explicitly disabled provider stays disabled even when foreign import is ON", () => {
		initializeWithSettings(
			mockSettings({ "discovery.importForeignConfig": true, disabledProviders: ["claude"] }).settings,
		);
		// Foreign gate would allow it, but the explicit disabled set wins.
		expect(isProviderEnabled("claude")).toBe(false);
	});

	it("disableProvider / enableProvider flip a native provider's enabled state", () => {
		initializeWithSettings(mockSettings().settings);
		expect(isProviderEnabled("native")).toBe(true);
		disableProvider("native");
		expect(isProviderEnabled("native")).toBe(false);
		enableProvider("native");
		expect(isProviderEnabled("native")).toBe(true);
	});
});

describe("capability registry: disabled round-trip and settings persistence", () => {
	it("loads the disabled set from settings on initialize", () => {
		initializeWithSettings(mockSettings({ disabledProviders: ["alpha", "beta"] }).settings);
		expect(getDisabledProviders().sort()).toEqual(["alpha", "beta"]);
	});

	it("setDisabledProviders replaces the set and persists it to settings", () => {
		const mock = mockSettings({ disabledProviders: ["old"] });
		initializeWithSettings(mock.settings);
		setDisabledProviders(["x", "y"]);
		expect(getDisabledProviders().sort()).toEqual(["x", "y"]);
		// The last persisted write is exactly the new set.
		const lastWrite = mock.sets.at(-1);
		expect(lastWrite).toBeDefined();
		if (!lastWrite) throw new Error("expected a persisted write");
		expect(lastWrite[0]).toBe("disabledProviders");
		expect((lastWrite[1] as string[]).sort()).toEqual(["x", "y"]);
	});

	it("disableProvider/enableProvider persist incremental changes", () => {
		const mock = mockSettings({ disabledProviders: ["a"] });
		initializeWithSettings(mock.settings);
		disableProvider("b");
		expect((mock.store.get("disabledProviders") as string[]).sort()).toEqual(["a", "b"]);
		enableProvider("a");
		expect(mock.store.get("disabledProviders")).toEqual(["b"]);
	});
});

describe("capability registry: load dedup, shadow, and validate", () => {
	it("dedups by key with the highest-priority provider winning and marks the loser _shadowed", async () => {
		defineTestCapability();
		registerProvider(CAP_ID, makeProvider("hi", 50, [item("dup"), item("hi-only")]));
		registerProvider(CAP_ID, makeProvider("lo", 10, [item("dup"), item("lo-only")]));

		const result = await loadCapability<TestItem>(CAP_ID);

		// Deduped, priority order: the "dup" kept is the high-priority provider's.
		expect(result.items.map(i => i.name)).toEqual(["dup", "hi-only", "lo-only"]);
		const keptDup = result.items.find(i => i.name === "dup");
		expect(keptDup?._source.providerName).toBe("hi-name");

		// The low-priority duplicate survives in `all`, flagged shadowed.
		const shadowed = result.all.filter(i => (i as { _shadowed?: boolean })._shadowed);
		expect(shadowed).toHaveLength(1);
		expect(shadowed[0]!.name).toBe("dup");
		expect(shadowed[0]!._source.providerName).toBe("lo-name");
		expect(result.all).toHaveLength(4);

		// Both providers contributed.
		expect(result.providers.sort()).toEqual(["hi", "lo"]);
	});

	it("drops items that fail validate and records a warning naming the source", async () => {
		defineTestCapability();
		registerProvider(CAP_ID, makeProvider("p", 10, [item("good"), item("bad", { valid: false, path: "/x/bad" })]));

		const result = await loadCapability<TestItem>(CAP_ID);
		expect(result.items.map(i => i.name)).toEqual(["good"]);
		expect(result.warnings.some(w => w.includes("Invalid item") && w.includes("/x/bad"))).toBe(true);
	});

	it("includeInvalid keeps items that would otherwise fail validation", async () => {
		defineTestCapability();
		registerProvider(CAP_ID, makeProvider("p", 10, [item("good"), item("bad", { valid: false })]));

		const result = await loadCapability<TestItem>(CAP_ID, { includeInvalid: true });
		expect(result.items.map(i => i.name).sort()).toEqual(["bad", "good"]);
	});
});

describe("capability registry: the snapshot/restore seam leaves global state byte-identical", () => {
	it("restores capabilities, disabled set, and foreign flag exactly after heavy mutation", () => {
		const before = {
			caps: listCapabilities().sort(),
			disabled: getDisabledProviders().sort(),
			foreign: isForeignConfigImportEnabled(),
		};

		// Heavy mutation: new capability + providers, disabled set, foreign toggle.
		defineTestCapability();
		registerProvider(CAP_ID, makeProvider("a", 5, [item("x")]));
		initializeWithSettings(
			mockSettings({ "discovery.importForeignConfig": true, disabledProviders: ["z"] }).settings,
		);
		setDisabledProviders(["p", "q", "r"]);
		expect(listCapabilities()).toContain(CAP_ID); // proof the mutation took effect

		restoreRegistryForTests(baseline);

		const after = {
			caps: listCapabilities().sort(),
			disabled: getDisabledProviders().sort(),
			foreign: isForeignConfigImportEnabled(),
		};
		expect(after).toEqual(before);
		// The test capability is gone, so a later suite can define its own freely.
		expect(listCapabilities()).not.toContain(CAP_ID);
	});
});
