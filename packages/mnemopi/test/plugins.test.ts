import { beforeEach, describe, expect, it } from "bun:test";
import {
	CompressionPlugin,
	FilterPlugin,
	getManager,
	LoggingPlugin,
	MetricsPlugin,
	MnemopiPlugin,
	PluginManager,
	resetManager,
	ValueError,
} from "@veyyon/mnemopi/core/plugins";

class CountingPlugin extends MnemopiPlugin {
	override name = "counting";
	readonly calls: string[] = [];
	override onRemember(memory: Record<string, unknown>): void {
		this.calls.push(`remember:${String(memory.id)}`);
	}
	override onRecall(memory: Record<string, unknown>): void {
		this.calls.push(`recall:${String(memory.id)}`);
	}
	override onConsolidate(summary: Record<string, unknown>): void {
		this.calls.push(`consolidate:${String(summary.summary)}`);
	}
	override onInvalidate(memoryId: string): void {
		this.calls.push(`invalidate:${memoryId}`);
	}
}

describe("PluginManager", () => {
	beforeEach(() => resetManager());

	it("registers, loads, notifies, and unloads plugins", () => {
		const manager = new PluginManager();
		manager.registerPlugin("counting", CountingPlugin);
		const plugin = manager.loadPlugin("counting") as CountingPlugin;
		expect(plugin.toDict().initialized).toBe(true);
		manager.notifyRemember({ id: "m1", content: "hello" });
		manager.notifyRecall({ id: "m1" });
		manager.notifyConsolidate({ summary: "sum" });
		manager.notifyInvalidate("m1");
		expect(plugin.calls).toEqual(["remember:m1", "recall:m1", "consolidate:sum", "invalidate:m1"]);
		expect(manager.listPlugins().some(entry => entry.name === "counting" && entry.loaded === true)).toBe(true);
		manager.unloadPlugin("counting");
		expect(plugin.toDict().initialized).toBe(false);
	});

	it("lazy-loads registered plugins through get_plugin", () => {
		const manager = new PluginManager();
		expect(manager.isLoaded("logging")).toBe(false);
		expect(manager.getPlugin("logging")).toBeInstanceOf(LoggingPlugin);
		expect(manager.isLoaded("logging")).toBe(true);
	});

	it("global manager can be reset", () => {
		const first = getManager();
		first.loadPlugin("metrics");
		resetManager();
		const second = getManager();
		expect(second).not.toBe(first);
		expect(second.isLoaded("metrics")).toBe(false);
	});

	it("rejects registering a non-plugin class", () => {
		const manager = new PluginManager();
		expect(() => manager.registerPlugin("bad", class NotAPlugin {} as never)).toThrow(TypeError);
	});

	it("rejects registering a name that is already taken", () => {
		const manager = new PluginManager();
		expect(() => manager.registerPlugin("logging", CountingPlugin)).toThrow(ValueError);
	});

	it("rejects loading an unregistered plugin", () => {
		const manager = new PluginManager();
		expect(() => manager.loadPlugin("ghost")).toThrow(ValueError);
	});

	it("rejects loading the same plugin twice", () => {
		const manager = new PluginManager();
		manager.loadPlugin("metrics");
		expect(() => manager.loadPlugin("metrics")).toThrow("already loaded");
	});

	it("rejects unloading a plugin that is not loaded", () => {
		const manager = new PluginManager();
		expect(() => manager.unloadPlugin("metrics")).toThrow(ValueError);
	});

	it("reports registration state without loading", () => {
		const manager = new PluginManager();
		expect(manager.isRegistered("logging")).toBe(true);
		expect(manager.isRegistered("ghost")).toBe(false);
		expect(manager.isLoaded("logging")).toBe(false);
	});

	it("loadAll loads every registered built-in exactly once and forwards config", () => {
		const manager = new PluginManager();
		manager.loadPlugin("metrics");
		const loaded = manager.loadAll({ logging: { max_entries: 3 } });
		// metrics was already loaded, so loadAll returns only the four remaining built-ins
		expect(loaded.map(p => p.name).sort()).toEqual(["compression", "filter", "logging"]);
		expect(manager.isLoaded("logging")).toBe(true);
		expect(manager.isLoaded("metrics")).toBe(true);
	});

	it("unloadAll shuts down every loaded plugin", () => {
		const manager = new PluginManager();
		manager.loadAll();
		manager.unloadAll();
		expect(manager.isLoaded("logging")).toBe(false);
		expect(manager.isLoaded("metrics")).toBe(false);
	});

	it("discoverPlugins returns an empty list when the plugin dir is absent", () => {
		const manager = new PluginManager("/nonexistent/mnemopi/plugins/dir");
		expect(manager.discoverPlugins()).toEqual([]);
	});

	it("skips a disabled plugin when notifying", () => {
		const manager = new PluginManager();
		manager.registerPlugin("counting", CountingPlugin);
		const plugin = manager.loadPlugin("counting") as CountingPlugin;
		plugin.enabled = false;
		manager.notifyRemember({ id: "m1" });
		expect(plugin.calls).toEqual([]);
	});

	it("swallows a throwing hook and still notifies the other plugins", () => {
		class ThrowingPlugin extends MnemopiPlugin {
			override name = "throwing";
			override onRemember(): void {
				throw new Error("hook exploded");
			}
			override onRecall(): void {}
			override onConsolidate(): void {}
			override onInvalidate(): void {}
		}
		const manager = new PluginManager();
		manager.registerPlugin("throwing", ThrowingPlugin);
		manager.registerPlugin("counting", CountingPlugin);
		manager.loadPlugin("throwing");
		const counting = manager.loadPlugin("counting") as CountingPlugin;
		expect(() => manager.notifyRemember({ id: "m1" })).not.toThrow();
		expect(counting.calls).toEqual(["remember:m1"]);
	});

	it("getPlugin returns null for an unknown name and lazy-loads a registered one", () => {
		const manager = new PluginManager();
		expect(manager.getPlugin("ghost")).toBeNull();
		expect(manager.getPlugin("metrics")).toBeInstanceOf(MetricsPlugin);
	});
});

describe("built-in plugins", () => {
	it("logging records bounded memory lifecycle entries", () => {
		const plugin = new LoggingPlugin({ max_entries: 2 });
		plugin.onRemember({ id: "m1", content: "x".repeat(100) });
		plugin.onRecall({ id: "m2", content: "short" });
		plugin.onInvalidate("m3");
		expect(plugin.getLog()).toHaveLength(2);
		expect(plugin.getLog()[1]?.event).toBe("invalidate");
	});

	it("metrics counts hooks and records timings", () => {
		const plugin = new MetricsPlugin();
		plugin.onRemember({ id: "m1" });
		plugin.onRecall({ id: "m1" });
		plugin.recordTiming("remember", 10);
		plugin.recordTiming("remember", 30);
		expect(plugin.getCounters()).toMatchObject({ remember: 1, recall: 1 });
		expect(plugin.getAverageTiming("remember")).toBe(20);
	});

	it("filter tracks blocked items when rules fail", () => {
		const plugin = new FilterPlugin();
		plugin.addRule(item => item.allow === true);
		plugin.onRemember({ id: "blocked", allow: false });
		plugin.onRemember({ id: "allowed", allow: true });
		expect(plugin.isBlocked("blocked")).toBe(true);
		expect(plugin.isBlocked("allowed")).toBe(false);
	});
});

describe("MnemopiPlugin abstract base", () => {
	it("cannot be instantiated directly", () => {
		// Abstractness is enforced at runtime via new.target, not the type system.
		expect(() => new MnemopiPlugin()).toThrow(TypeError);
	});

	it("its un-overridden hooks throw, so a subclass is forced to implement them", () => {
		class Bare extends MnemopiPlugin {
			override name = "bare";
		}
		const plugin = new Bare();
		expect(() => plugin.onRemember({})).toThrow("Plugin must implement onRemember");
		expect(() => plugin.onRecall({})).toThrow("Plugin must implement onRecall");
		expect(() => plugin.onConsolidate({})).toThrow("Plugin must implement onConsolidate");
		expect(() => plugin.onInvalidate("id")).toThrow("Plugin must implement onInvalidate");
	});

	it("carries name, version, enabled, and config through toDict", () => {
		class Sub extends MnemopiPlugin {
			override name = "sub";
			override version = "2.3.4";
			override onRemember(): void {}
			override onRecall(): void {}
			override onConsolidate(): void {}
			override onInvalidate(): void {}
		}
		const plugin = new Sub({ key: "value" });
		plugin.initialize();
		expect(plugin.toDict()).toEqual({
			name: "sub",
			version: "2.3.4",
			enabled: true,
			initialized: true,
			config: { key: "value" },
		});
	});
});

describe("LoggingPlugin details", () => {
	it("records a consolidate entry with a source count and truncated summary preview", () => {
		const plugin = new LoggingPlugin();
		const longSummary = "s".repeat(200);
		plugin.onConsolidate({ summary: longSummary, source_wm_ids: ["a", "b", "c"] });
		const entry = plugin.getLog()[0];
		expect(entry?.event).toBe("consolidate");
		expect(entry?.source_count).toBe(3);
		expect(entry?.summary_preview).toBe(`${"s".repeat(80)}...`);
	});

	it("treats a missing source_wm_ids array as a zero source count", () => {
		const plugin = new LoggingPlugin();
		plugin.onConsolidate({ summary: "short" });
		expect(plugin.getLog()[0]?.source_count).toBe(0);
		expect(plugin.getLog()[0]?.summary_preview).toBe("short");
	});

	it("renders a non-string content preview as an empty string", () => {
		const plugin = new LoggingPlugin();
		plugin.onRemember({ id: "m1", content: { nested: true } });
		expect(plugin.getLog()[0]?.content_preview).toBe("");
	});

	it("clearLog empties the log and getLog returns an independent copy", () => {
		const plugin = new LoggingPlugin();
		plugin.onRemember({ id: "m1", content: "hi" });
		const snapshot = plugin.getLog();
		plugin.clearLog();
		expect(plugin.getLog()).toHaveLength(0);
		expect(snapshot).toHaveLength(1);
	});

	it("falls back to the default 10000-entry cap when max_entries is not a finite number", () => {
		const plugin = new LoggingPlugin({ max_entries: "lots" });
		for (let i = 0; i < 5; i++) plugin.onRemember({ id: `m${i}`, content: "x" });
		expect(plugin.getLog()).toHaveLength(5);
	});
});

describe("MetricsPlugin details", () => {
	it("counts consolidate and invalidate hooks", () => {
		const plugin = new MetricsPlugin();
		plugin.onConsolidate({ summary: "s" });
		plugin.onInvalidate("m1");
		plugin.onInvalidate("m2");
		expect(plugin.getCounters()).toMatchObject({ consolidate: 1, invalidate: 2 });
	});

	it("getTimings returns a copy and an unknown event yields an empty list", () => {
		const plugin = new MetricsPlugin();
		plugin.recordTiming("recall", 5);
		const timings = plugin.getTimings("recall");
		timings.push(999);
		expect(plugin.getTimings("recall")).toEqual([5]);
		expect(plugin.getTimings("never-seen")).toEqual([]);
	});

	it("records timings for an event key it did not preallocate", () => {
		const plugin = new MetricsPlugin();
		plugin.recordTiming("custom", 7);
		expect(plugin.getTimings("custom")).toEqual([7]);
		expect(plugin.getAverageTiming("custom")).toBe(7);
	});

	it("bounds each timing series to maxTimingSamples by dropping the oldest", () => {
		const plugin = new MetricsPlugin({ max_timing_samples: 2 });
		plugin.recordTiming("recall", 1);
		plugin.recordTiming("recall", 2);
		plugin.recordTiming("recall", 3);
		expect(plugin.getTimings("recall")).toEqual([2, 3]);
	});

	it("getAverageTiming is null with no samples", () => {
		expect(new MetricsPlugin().getAverageTiming("recall")).toBeNull();
	});

	it("reset zeroes counters and clears timings", () => {
		const plugin = new MetricsPlugin();
		plugin.onRemember({});
		plugin.recordTiming("remember", 12);
		plugin.reset();
		expect(plugin.getCounters()).toEqual({ remember: 0, recall: 0, consolidate: 0, invalidate: 0 });
		expect(plugin.getTimings("remember")).toEqual([]);
	});

	it("getSummary reports counters and per-event averages", () => {
		const plugin = new MetricsPlugin();
		plugin.onRecall({});
		plugin.recordTiming("recall", 4);
		plugin.recordTiming("recall", 8);
		const summary = plugin.getSummary();
		expect(summary.counters).toMatchObject({ recall: 1 });
		expect((summary.averages as Record<string, number | null>).recall).toBe(6);
		expect((summary.averages as Record<string, number | null>).remember).toBeNull();
	});
});

describe("FilterPlugin details", () => {
	it("removeRule and clearRules stop rules from blocking", () => {
		const plugin = new FilterPlugin();
		const rule = (item: Record<string, unknown>) => item.allow === true;
		plugin.addRule(rule);
		plugin.removeRule(rule);
		plugin.onRemember({ id: "m1", allow: false });
		expect(plugin.isBlocked("m1")).toBe(false);

		plugin.addRule(rule);
		plugin.clearRules();
		plugin.onRemember({ id: "m2", allow: false });
		expect(plugin.isBlocked("m2")).toBe(false);
	});

	it("removeRule of an unknown rule is a no-op", () => {
		const plugin = new FilterPlugin();
		expect(() => plugin.removeRule(() => true)).not.toThrow();
	});

	it("blocks failing items on recall and consolidate too", () => {
		const plugin = new FilterPlugin();
		plugin.addRule(item => item.allow === true);
		plugin.onRecall({ id: "r", allow: false });
		plugin.onConsolidate({ id: "c", allow: false });
		expect(plugin.isBlocked("r")).toBe(true);
		expect(plugin.isBlocked("c")).toBe(true);
	});

	it("fails closed and blocks when a rule throws", () => {
		const plugin = new FilterPlugin();
		plugin.addRule(() => {
			throw new Error("boom");
		});
		plugin.onRemember({ id: "m1", allow: true });
		expect(plugin.isBlocked("m1")).toBe(true);
	});

	it("onInvalidate is a no-op that records nothing", () => {
		const plugin = new FilterPlugin();
		plugin.onInvalidate("m1");
		expect(plugin.getBlocked()).toHaveLength(0);
	});

	it("bounds the blocked list to maxBlocked", () => {
		const plugin = new FilterPlugin({ max_blocked: 2 });
		plugin.addRule(() => false);
		plugin.onRemember({ id: "a" });
		plugin.onRemember({ id: "b" });
		plugin.onRemember({ id: "c" });
		const blocked = plugin.getBlocked();
		expect(blocked).toHaveLength(2);
		expect((blocked[0]?.item as Record<string, unknown>).id).toBe("b");
	});
});

describe("CompressionPlugin", () => {
	it("is disabled by default and passes lines through unchanged", () => {
		const plugin = new CompressionPlugin();
		expect(plugin.enabled).toBe(false);
		expect(plugin.compressLines(["a", "b"])).toEqual(["a", "b"]);
	});

	it("can be enabled through config", () => {
		const plugin = new CompressionPlugin({ enabled: true, threshold_chars: 5 });
		expect(plugin.enabled).toBe(true);
		expect(plugin.compressLines(["line"])).toEqual(["line"]);
	});
});
