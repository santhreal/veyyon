import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../../discovery/helpers";
import { MarketplaceManager } from "./manager";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
} from "./registry";

/**
 * Build a `MarketplaceManager` wired up with the active project's registry
 * paths and the shared plugin-root cache invalidator. The one construction
 * owner for the plugin CLI and the plugin-settings TUI; marketplace-auto-update
 * keeps injected dependencies so the marketplace graph stays out of the initial
 * TUI module graph.
 */
export async function createMarketplaceManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}
