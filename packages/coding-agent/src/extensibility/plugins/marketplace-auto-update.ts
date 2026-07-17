import { getProjectDir, logger } from "@veyyon/pi-utils";

type MarketplaceAutoUpdateMode = "off" | "notify" | "auto";

/** The slice of MarketplaceManager the auto-update path drives. */
export interface MarketplaceAutoUpdateManager {
	refreshStaleMarketplaces(): Promise<unknown>;
	checkForUpdates(): Promise<readonly unknown[]>;
	upgradeAllPlugins(): Promise<unknown>;
}

export interface MarketplaceAutoUpdateOptions {
	autoUpdate: MarketplaceAutoUpdateMode;
	resolveActiveProjectRegistryPath: (cwd: string) => Promise<string | null>;
	clearPluginRootsCache: () => void;
	/** Surface the outcome to the operator (e.g. the TUI status line). */
	notify: (message: string) => void;
	/** Override manager construction (embedding, tests). Default: real registries + caches. */
	createManager?: () => Promise<MarketplaceAutoUpdateManager>;
}

export function scheduleMarketplaceAutoUpdate(options: MarketplaceAutoUpdateOptions): Promise<void> {
	if (options.autoUpdate === "off") {
		return Promise.resolve();
	}

	return runMarketplaceAutoUpdate(options);
}

async function createDefaultManager(options: MarketplaceAutoUpdateOptions): Promise<MarketplaceAutoUpdateManager> {
	// Startup perf: marketplace manager pulls scraper/fetch/cache code; keep it out of the initial TUI graph.
	const {
		MarketplaceManager,
		getInstalledPluginsRegistryPath,
		getMarketplacesCacheDir,
		getMarketplacesRegistryPath,
		getPluginsCacheDir,
	} = await import("./marketplace");
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: (await options.resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: options.clearPluginRootsCache,
	});
}

async function runMarketplaceAutoUpdate(options: MarketplaceAutoUpdateOptions): Promise<void> {
	try {
		const mgr = await (options.createManager ?? (() => createDefaultManager(options)))();
		await mgr.refreshStaleMarketplaces();
		const updates = await mgr.checkForUpdates();
		if (updates.length === 0) return;
		if (options.autoUpdate === "auto") {
			await mgr.upgradeAllPlugins();
			options.notify(`Auto-upgraded ${updates.length} marketplace plugin(s)`);
		} else {
			options.notify(`${updates.length} marketplace plugin update(s) available — run /marketplace upgrade`);
		}
	} catch (err) {
		// Background convenience: an offline/failed check must not break startup,
		// but the failure is recorded, never swallowed.
		logger.warn(`Marketplace auto-update check failed: ${err}`);
	}
}
