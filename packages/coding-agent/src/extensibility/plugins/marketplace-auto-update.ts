import { errorMessage, getProjectDir, logger } from "@veyyon/utils";

type MarketplaceAutoUpdateMode = "off" | "notify" | "auto";

export type MarketplaceAutoUpdateResult =
	| { kind: "disabled" }
	| { kind: "none" }
	| { kind: "available"; count: number }
	| { kind: "installed"; count: number }
	| { kind: "failed"; error: string };

export interface MarketplaceUpdateChecker {
	refreshStaleMarketplaces(): Promise<unknown>;
	checkForUpdates(): Promise<readonly unknown[]>;
	upgradeAllPlugins(): Promise<readonly unknown[]>;
}

interface MarketplaceAutoUpdateOptions {
	autoUpdate: MarketplaceAutoUpdateMode;
	resolveActiveProjectRegistryPath: (cwd: string) => Promise<string | null>;
	clearPluginRootsCache: () => void;
	onResult?: (result: MarketplaceAutoUpdateResult) => void;
	createChecker?: (options: MarketplaceAutoUpdateOptions) => Promise<MarketplaceUpdateChecker>;
}

async function createDefaultChecker(options: MarketplaceAutoUpdateOptions): Promise<MarketplaceUpdateChecker> {
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

export function scheduleMarketplaceAutoUpdate(options: MarketplaceAutoUpdateOptions): void {
	if (options.autoUpdate === "off") {
		return;
	}

	void runMarketplaceAutoUpdate(options).then(result => options.onResult?.(result));
}

export async function runMarketplaceAutoUpdate(
	options: MarketplaceAutoUpdateOptions,
): Promise<MarketplaceAutoUpdateResult> {
	if (options.autoUpdate === "off") return { kind: "disabled" };

	try {
		const mgr = await (options.createChecker ?? createDefaultChecker)(options);
		await mgr.refreshStaleMarketplaces();
		const updates = await mgr.checkForUpdates();
		if (updates.length === 0) return { kind: "none" };
		if (options.autoUpdate === "auto") {
			const installed = await mgr.upgradeAllPlugins();
			if (installed.length === 0) {
				return {
					kind: "failed",
					error: `none of the ${updates.length} available plugin updates could be installed`,
				};
			}
			return { kind: "installed", count: installed.length };
		}
		return { kind: "available", count: updates.length };
	} catch (error) {
		const message = errorMessage(error);
		logger.warn("Plugin update check failed", {
			error: message,
			fix: "Check network access to your marketplaces, or set marketplace.autoUpdate to off in /settings.",
		});
		return { kind: "failed", error: message };
	}
}
