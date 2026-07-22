import { errorMessage, getProjectDir, logger } from "@veyyon/utils";

type MarketplaceAutoUpdateMode = "off" | "notify" | "auto";

/**
 * What the startup check found, handed back to the caller so the UI decides how
 * to show it. Keeping the presentation out of here is what lets the same check
 * run under the TUI, a headless run, and a test.
 */
export type MarketplaceAutoUpdateResult =
	| { kind: "disabled" }
	| { kind: "none" }
	| { kind: "available"; count: number }
	| { kind: "installed"; count: number }
	| { kind: "failed"; error: string };

/**
 * The slice of the marketplace manager this check actually uses.
 *
 * Narrow on purpose. It is the seam tests substitute at, and a seam that names
 * three methods cannot drift into standing in for the whole manager.
 */
export interface MarketplaceUpdateChecker {
	refreshStaleMarketplaces(): Promise<unknown>;
	checkForUpdates(): Promise<readonly unknown[]>;
	upgradeAllPlugins(): Promise<readonly unknown[]>;
}

interface MarketplaceAutoUpdateOptions {
	autoUpdate: MarketplaceAutoUpdateMode;
	resolveActiveProjectRegistryPath: (cwd: string) => Promise<string | null>;
	clearPluginRootsCache: () => void;
	/** Called once with the outcome. Never called for `off`. */
	onResult?: (result: MarketplaceAutoUpdateResult) => void;
	/**
	 * Builds the checker. Defaults to the real marketplace manager, loaded lazily.
	 *
	 * Injected rather than mocked. Tests used to substitute the manager with
	 * `vi.mock` on the `./marketplace` specifier, which patches Bun's module
	 * registry for the WHOLE run: every later test file that imported the real
	 * module got the stub instead, and 69 unrelated marketplace and plugin tests
	 * failed with `manager.addMarketplace is not a function`. A parameter with a
	 * real default gives the same substitution with no global reach.
	 */
	createChecker?: (options: MarketplaceAutoUpdateOptions) => Promise<MarketplaceUpdateChecker>;
}

/** The real checker: the marketplace manager, wired to the on-disk registries. */
async function createDefaultChecker(options: MarketplaceAutoUpdateOptions): Promise<MarketplaceUpdateChecker> {
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

/**
 * Run the plugin update check in the background.
 *
 * Fire and forget by design: a slow marketplace must not hold up the first
 * paint. The result arrives through `onResult` whenever the network does.
 */
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
			// `upgradeAllPlugins` skips entries it could not install, so the count
			// that gets reported is what actually landed, not what was offered.
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
		// This used to be a bare `catch {}`. Offline is the common case and it is
		// not worth a transcript line, but it is worth a log line: a marketplace
		// that has been failing for weeks should be findable (Law 10).
		const message = errorMessage(error);
		logger.warn("Plugin update check failed", {
			error: message,
			fix: "Check network access to your marketplaces, or set marketplace.autoUpdate to off in /settings.",
		});
		return { kind: "failed", error: message };
	}
}
