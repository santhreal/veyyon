import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type MarketplaceAutoUpdateResult,
	runMarketplaceAutoUpdate,
	scheduleMarketplaceAutoUpdate,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace-auto-update";
import { logger } from "@veyyon/utils";

/**
 * `marketplace.autoUpdate` defaults to `notify` and its settings description
 * promises a startup check that tells you when plugin updates exist. Two things
 * were wrong:
 *
 * 1. `scheduleMarketplaceAutoUpdate` had no callers at all, so the setting was
 *    read by nothing and no check ever ran.
 * 2. Even if it had run, `notify` wrote `logger.debug`, which no user sees, and
 *    every failure went into a bare `catch {}`.
 *
 * These tests pin the outcome contract the startup path now depends on: each
 * mode produces a distinct, inspectable result, one mode never leaks into
 * another, and a failure is reported rather than swallowed.
 */
describe("marketplace auto-update", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	/** A manager stub standing in for the dynamic `./marketplace` import. */
	function stubManager(behavior: {
		updates?: Array<{ pluginId: string; scope: "user"; from: string; to: string }>;
		installed?: Array<{ pluginId: string; scope: "user"; from: string; to: string }>;
		throwOn?: "refresh" | "check" | "upgrade";
	}) {
		const calls: string[] = [];
		const manager = {
			async refreshStaleMarketplaces() {
				calls.push("refresh");
				if (behavior.throwOn === "refresh") throw new Error("marketplace unreachable");
			},
			async checkForUpdates() {
				calls.push("check");
				if (behavior.throwOn === "check") throw new Error("catalog is corrupt");
				return behavior.updates ?? [];
			},
			async upgradeAllPlugins() {
				calls.push("upgrade");
				if (behavior.throwOn === "upgrade") throw new Error("install failed");
				return behavior.installed ?? [];
			},
		};
		return { manager, calls };
	}

	const UPDATE = { pluginId: "a@mkt", scope: "user" as const, from: "1.0.0", to: "2.0.0" };
	const SECOND = { pluginId: "b@mkt", scope: "user" as const, from: "1.0.0", to: "1.1.0" };

	/**
	 * Run the real function against a stub checker, passed in through the
	 * `createChecker` seam.
	 *
	 * This used to call `vi.mock` on the `./marketplace` specifier. Bun's module
	 * mocking is process-wide and has no file scope, so the stub stayed installed
	 * for the rest of the run and every later file that imported the real module
	 * got a class with three methods on it. 69 unrelated marketplace and plugin
	 * tests failed with `manager.addMarketplace is not a function`, and only in
	 * the full-suite run, never when this file was run alone. Injecting the
	 * dependency substitutes exactly the same thing and reaches nothing outside
	 * this call.
	 */
	async function run(
		mode: "off" | "notify" | "auto",
		behavior: Parameters<typeof stubManager>[0],
	): Promise<{ result: MarketplaceAutoUpdateResult; calls: string[] }> {
		const { manager, calls } = stubManager(behavior);
		const result = await runMarketplaceAutoUpdate({
			autoUpdate: mode,
			resolveActiveProjectRegistryPath: async () => null,
			clearPluginRootsCache: () => {},
			createChecker: async () => manager,
		});
		return { result, calls };
	}

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("does nothing at all when the mode is off", async () => {
		// `off` must not touch the network or the registries. Reporting `disabled`
		// rather than `none` keeps the two distinguishable at the call site.
		const { result, calls } = await run("off", { updates: [UPDATE] });

		expect(result).toEqual({ kind: "disabled" });
		expect(calls).toEqual([]);
	});

	it("schedules nothing and calls back with nothing when the mode is off", () => {
		// The fire-and-forget entry point has the same contract.
		let called = false;
		scheduleMarketplaceAutoUpdate({
			autoUpdate: "off",
			resolveActiveProjectRegistryPath: async () => null,
			clearPluginRootsCache: () => {},
			onResult: () => {
				called = true;
			},
		});

		expect(called).toBe(false);
	});

	it("reports the exact number of available updates in notify mode", async () => {
		// REGRESSION: this produced a `logger.debug` line and nothing else. The
		// count matters because it is what the transcript line prints.
		const { result, calls } = await run("notify", { updates: [UPDATE, SECOND] });

		expect(result).toEqual({ kind: "available", count: 2 });
		expect(calls).toEqual(["refresh", "check"]);
	});

	it("never installs anything in notify mode", async () => {
		// The whole difference between the two modes. An accidental upgrade call
		// here would change plugins the user did not agree to change.
		const { calls } = await run("notify", { updates: [UPDATE] });

		expect(calls).not.toContain("upgrade");
	});

	it("installs in auto mode and reports what actually landed", async () => {
		// `upgradeAllPlugins` skips entries it could not install, so reporting the
		// available count here would overstate the result to the user.
		const { result, calls } = await run("auto", { updates: [UPDATE, SECOND], installed: [UPDATE] });

		expect(result).toEqual({ kind: "installed", count: 1 });
		expect(calls).toEqual(["refresh", "check", "upgrade"]);
	});

	it("reports a failure when auto mode installs none of the available updates", async () => {
		// Law: no silent fallbacks. Returning `installed: 0` would render as a
		// success line saying zero plugins updated, which reads as "all fine".
		const { result } = await run("auto", { updates: [UPDATE], installed: [] });

		expect(result.kind).toBe("failed");
		expect((result as { error: string }).error).toContain("1 available plugin updates");
	});

	it("says there is nothing to do rather than nothing at all when everything is current", async () => {
		const { result, calls } = await run("notify", { updates: [] });

		expect(result).toEqual({ kind: "none" });
		expect(calls).toEqual(["refresh", "check"]);
	});

	it("logs an unreachable marketplace instead of swallowing it", async () => {
		// REGRESSION: the old body was `catch {}`, so a marketplace that had been
		// failing for weeks left no trace anywhere.
		const { result } = await run("notify", { throwOn: "refresh" });

		expect(result).toEqual({ kind: "failed", error: "marketplace unreachable" });
		const [message, fields] = warnSpy.mock.calls[0] as [string, { error: string; fix: string }];
		expect(message).toBe("Plugin update check failed");
		expect(fields.error).toBe("marketplace unreachable");
		expect(fields.fix).toContain("marketplace.autoUpdate");
	});

	it("reports a corrupt catalog with the underlying reason", async () => {
		const { result } = await run("notify", { throwOn: "check" });

		expect(result).toEqual({ kind: "failed", error: "catalog is corrupt" });
	});

	it("reports an install failure rather than claiming an update landed", async () => {
		const { result } = await run("auto", { updates: [UPDATE], throwOn: "upgrade" });

		expect(result).toEqual({ kind: "failed", error: "install failed" });
	});
});
