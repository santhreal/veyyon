import { describe, expect, it } from "bun:test";
import type { MarketplaceAutoUpdateManager } from "../../src/extensibility/plugins/marketplace-auto-update";
import { scheduleMarketplaceAutoUpdate } from "../../src/extensibility/plugins/marketplace-auto-update";

interface StubCalls {
	refreshed: number;
	checked: number;
	upgraded: number;
}

function stubManager(updates: unknown[], calls: StubCalls): MarketplaceAutoUpdateManager {
	return {
		async refreshStaleMarketplaces() {
			calls.refreshed++;
		},
		async checkForUpdates() {
			calls.checked++;
			return updates;
		},
		async upgradeAllPlugins() {
			calls.upgraded++;
		},
	};
}

function baseOptions(mode: "off" | "notify" | "auto", manager: MarketplaceAutoUpdateManager, notified: string[]) {
	return {
		autoUpdate: mode,
		resolveActiveProjectRegistryPath: async () => null,
		clearPluginRootsCache: () => {},
		notify: (message: string) => notified.push(message),
		createManager: async () => manager,
	};
}

describe("scheduleMarketplaceAutoUpdate", () => {
	it("off mode never touches the manager and never notifies", async () => {
		const calls: StubCalls = { refreshed: 0, checked: 0, upgraded: 0 };
		const notified: string[] = [];
		await scheduleMarketplaceAutoUpdate(baseOptions("off", stubManager([{}], calls), notified));
		expect(calls).toEqual({ refreshed: 0, checked: 0, upgraded: 0 });
		expect(notified).toEqual([]);
	});

	it("notify mode surfaces the pending-update count without upgrading", async () => {
		const calls: StubCalls = { refreshed: 0, checked: 0, upgraded: 0 };
		const notified: string[] = [];
		await scheduleMarketplaceAutoUpdate(baseOptions("notify", stubManager([{}, {}], calls), notified));
		expect(calls).toEqual({ refreshed: 1, checked: 1, upgraded: 0 });
		expect(notified).toEqual(["2 marketplace plugin update(s) available — run /marketplace upgrade"]);
	});

	it("auto mode upgrades everything and reports the count", async () => {
		const calls: StubCalls = { refreshed: 0, checked: 0, upgraded: 0 };
		const notified: string[] = [];
		await scheduleMarketplaceAutoUpdate(baseOptions("auto", stubManager([{}, {}, {}], calls), notified));
		expect(calls).toEqual({ refreshed: 1, checked: 1, upgraded: 1 });
		expect(notified).toEqual(["Auto-upgraded 3 marketplace plugin(s)"]);
	});

	it("stays silent when there are no updates", async () => {
		const calls: StubCalls = { refreshed: 0, checked: 0, upgraded: 0 };
		const notified: string[] = [];
		await scheduleMarketplaceAutoUpdate(baseOptions("auto", stubManager([], calls), notified));
		expect(calls).toEqual({ refreshed: 1, checked: 1, upgraded: 0 });
		expect(notified).toEqual([]);
	});

	it("a failing manager is recorded, never thrown into startup", async () => {
		const notified: string[] = [];
		await expect(
			scheduleMarketplaceAutoUpdate({
				autoUpdate: "notify",
				resolveActiveProjectRegistryPath: async () => null,
				clearPluginRootsCache: () => {},
				notify: (message: string) => notified.push(message),
				createManager: async () => {
					throw new Error("offline");
				},
			}),
		).resolves.toBeUndefined();
		expect(notified).toEqual([]);
	});
});
