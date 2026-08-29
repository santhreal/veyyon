import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DAY_MS, errorMessage, isEnoent, logger, pathIsWithin, removeTempPath } from "@veyyon/utils";
import { normalizePluginRuntimeConfig } from "../runtime-config";
import type { PluginRuntimeConfig } from "../types";

import { cachePlugin } from "./cache";
import { classifySource, fetchMarketplace, parseMarketplaceCatalog, promoteCloneToCache } from "./fetcher";
import type { MarketplaceManagerOptions } from "./manager-helpers";
import { assertRuntimePackageName, marketplaceNotConfiguredMessage } from "./manager-helpers";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	collectReferencedPaths,
	getInstalledPlugin,
	getMarketplaceEntry,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "./registry";
import { resolvePluginSource } from "./source-resolver";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
	InstalledPluginsRegistry,
	MarketplaceCatalog,
	MarketplacePluginEntry,
	MarketplaceRegistryEntry,
} from "./types";
import { buildPluginId, parsePluginId } from "./types";

export class MarketplaceManager {
	#opts: MarketplaceManagerOptions;

	constructor(options: MarketplaceManagerOptions) {
		this.#opts = options;
	}

	#clearCache(): void {
		const extra = this.#opts.projectInstalledRegistryPath
			? ([this.#opts.projectInstalledRegistryPath] as readonly string[])
			: undefined;
		this.#opts.clearPluginRootsCache?.(extra);
	}

	async addMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existingNames = new Set(reg.marketplaces.map(m => m.name));

		const { catalog, clonePath } = await fetchMarketplace(source, this.#opts.marketplacesCacheDir);

		if (existingNames.has(catalog.name)) {
			if (clonePath) {
				await removeTempPath(clonePath, "marketplace-duplicate-name");
			}
			throw new Error(
				`A marketplace named "${catalog.name}" is already configured, so this one was not added. ` +
					`Fix: run \`veyyon plugin marketplace remove ${catalog.name}\` first if you want to replace it, ` +
					`or \`veyyon plugin marketplace update ${catalog.name}\` to refresh the one you already have.`,
			);
		}

		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		const sourceType = classifySource(source);
		const normalizedSource =
			sourceType === "local"
				? path.resolve(source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source)
				: source;

		const catalogPath = path.join(this.#opts.marketplacesCacheDir, catalog.name, "marketplace.json");

		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: normalizedSource,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};

		const updated = addMarketplaceEntry(reg, entry);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		logger.debug("Marketplace added", { name: catalog.name, sourceType });
		return entry;
	}

	async removeMarketplace(name: string): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updated = removeMarketplaceEntry(reg, name);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		await fs.rm(path.join(this.#opts.marketplacesCacheDir, name), {
			recursive: true,
			force: true,
		});

		logger.debug("Marketplace removed", { name });
	}

	async updateMarketplace(name: string): Promise<MarketplaceRegistryEntry> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const existing = getMarketplaceEntry(reg, name);
		if (!existing) {
			throw new Error(marketplaceNotConfiguredMessage(name));
		}

		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, this.#opts.marketplacesCacheDir);

		if (catalog.name !== name) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(
				`Marketplace catalog name changed from "${name}" to "${catalog.name}". ` +
					`Remove and re-add the marketplace to update.`,
			);
		}

		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		await Bun.write(existing.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const updatedEntry: MarketplaceRegistryEntry = {
			...existing,
			updatedAt: new Date().toISOString(),
		};

		const updatedReg = {
			...reg,
			marketplaces: reg.marketplaces.map(m => (m.name === name ? updatedEntry : m)),
		};
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updatedReg);

		logger.debug("Marketplace updated", { name });
		return updatedEntry;
	}

	async updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const marketplaces = await this.listMarketplaces();
		const results: MarketplaceRegistryEntry[] = [];
		for (const m of marketplaces) {
			const updated = await this.updateMarketplace(m.name);
			results.push(updated);
		}
		return results;
	}

	async listMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		return reg.marketplaces;
	}

	async listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);

		if (marketplace !== undefined) {
			const entry = reg.marketplaces.find(m => m.name === marketplace);
			if (!entry) {
				throw new Error(marketplaceNotConfiguredMessage(marketplace));
			}
			const catalog = await this.#readCatalog(entry);
			return catalog.plugins;
		}

		const all: MarketplacePluginEntry[] = [];
		for (const entry of reg.marketplaces) {
			const catalog = await this.#readCatalog(entry);
			for (let pi = 0; pi < catalog.plugins.length; pi++) all.push(catalog.plugins[pi]!);
		}
		return all;
	}

	async getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null> {
		const plugins = await this.listAvailablePlugins(marketplace);
		return plugins.find(p => p.name === name) ?? null;
	}

	async installPlugin(
		name: string,
		marketplace: string,
		options?: { force?: boolean; scope?: "user" | "project" },
	): Promise<InstalledPluginEntry> {
		const force = options?.force ?? false;
		const scope = options?.scope ?? "user";
		const registryPath = this.#registryPath(scope);

		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const mktEntry = getMarketplaceEntry(mktReg, marketplace);
		if (!mktEntry) {
			throw new Error(marketplaceNotConfiguredMessage(marketplace));
		}

		const catalog = await this.#readCatalog(mktEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) {
			throw new Error(
				`Marketplace "${marketplace}" has no plugin named "${name}", so nothing was installed. ` +
					`Fix: run \`veyyon plugin discover ${marketplace}\` to list what it offers.`,
			);
		}

		const pluginId = buildPluginId(name, marketplace);

		const instReg = await readInstalledPluginsRegistry(registryPath);
		const existing = getInstalledPlugin(instReg, pluginId);
		if (existing && existing.length > 0 && !force) {
			throw new Error(
				`Plugin "${pluginId}" is already installed, so it was left alone. ` +
					`Fix: run \`veyyon plugin install ${name}@${marketplace} --force\` to reinstall it over the top, ` +
					`or \`veyyon plugin uninstall ${pluginId}\` first.`,
			);
		}

		const marketplaceClonePath = this.#resolveMarketplaceRoot(mktEntry);

		if (mktEntry.sourceType === "url" && typeof pluginEntry.source === "string") {
			throw new Error(
				`Plugin "${name}" uses a relative source path but marketplace "${marketplace}" was added via URL. ` +
					`Relative sources require a git or local marketplace. Re-add the marketplace using its git URL.`,
			);
		}

		const { dir: sourcePath, tempCloneRoot } = await resolvePluginSource(pluginEntry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
			tmpDir: os.tmpdir(),
		});

		let version!: string;
		let cachePath!: string;
		try {
			version = await this.#resolvePluginVersion(pluginEntry, sourcePath);
			cachePath = await cachePlugin(sourcePath, this.#opts.pluginsCacheDir, marketplace, name, version);
			await this.#writeEmbeddedLspConfig(pluginEntry, cachePath);
			await this.#writeEmbeddedDapConfig(pluginEntry, cachePath);
		} finally {
			if (tempCloneRoot) {
				await removeTempPath(tempCloneRoot, "marketplace-temp-clone-root");
			}
		}

		const packageName = await this.#resolvePluginPackageName(cachePath, name);
		const previousPackageNames = await this.#resolveInstalledPackageNames(existing ?? [], name);

		if (existing && existing.length > 0) {
			const prunedReg = removeInstalledPlugin(await readInstalledPluginsRegistry(registryPath), pluginId);
			await writeInstalledPluginsRegistry(registryPath, prunedReg);

			const [userReg, projectReg] = await Promise.all([
				readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
				this.#opts.projectInstalledRegistryPath
					? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
					: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
			]);
			const referenced = collectReferencedPaths(userReg, projectReg);

			for (const entry of existing) {
				if (entry.installPath !== cachePath && !referenced.has(entry.installPath)) {
					await fs.rm(entry.installPath, { recursive: true, force: true });
				}
			}
		}

		const now = new Date().toISOString();
		const wasDisabled = existing?.some(e => e.enabled === false);
		const installedEntry: InstalledPluginEntry = {
			scope,
			installPath: cachePath,
			version,
			installedAt: now,
			lastUpdated: now,
			...(wasDisabled ? { enabled: false } : {}),
		};

		const freshInstReg = await readInstalledPluginsRegistry(registryPath);
		const newInstReg = addInstalledPlugin(freshInstReg, pluginId, installedEntry);
		await writeInstalledPluginsRegistry(registryPath, newInstReg);

		for (const previousPackageName of previousPackageNames) {
			if (previousPackageName !== packageName) {
				await this.#removeRuntimePlugin(scope, previousPackageName);
			}
		}
		await this.#registerRuntimePlugin(scope, packageName, cachePath, version, wasDisabled ? false : undefined);

		this.#clearCache();

		logger.debug("Plugin installed", { pluginId, version, cachePath });
		return installedEntry;
	}

	async #writeEmbeddedLspConfig(entry: MarketplacePluginEntry, cachePath: string): Promise<void> {
		const lspServers = entry.lspServers;
		if (!lspServers) return;

		const targetPath = path.join(cachePath, ".lsp.json");
		if (typeof lspServers === "string") {
			const sourcePath = path.resolve(cachePath, lspServers);
			if (!pathIsWithin(cachePath, sourcePath)) {
				throw new Error(`Plugin "${entry.name}" lspServers path escapes the plugin directory`);
			}
			const content = await Bun.file(sourcePath).text();
			await Bun.write(targetPath, content);
			return;
		}

		await Bun.write(targetPath, `${JSON.stringify({ servers: lspServers }, null, 2)}\n`);
	}

	async #writeEmbeddedDapConfig(entry: MarketplacePluginEntry, cachePath: string): Promise<void> {
		const dapAdapters = entry.dapAdapters;
		if (!dapAdapters) return;

		if (typeof dapAdapters === "string") {
			const sourcePath = path.resolve(cachePath, dapAdapters);
			if (!pathIsWithin(cachePath, sourcePath)) {
				throw new Error(`Plugin "${entry.name}" dapAdapters path escapes the plugin directory`);
			}
			const extension = path.extname(sourcePath).toLowerCase();
			const targetFilename = extension === ".yaml" || extension === ".yml" ? `.dap${extension}` : ".dap.json";
			const targetPath = path.join(cachePath, targetFilename);
			const content = await Bun.file(sourcePath).text();
			await Bun.write(targetPath, content);
			return;
		}

		const targetPath = path.join(cachePath, ".dap.json");
		await Bun.write(targetPath, `${JSON.stringify({ adapters: dapAdapters }, null, 2)}\n`);
	}

	async #resolvePluginVersion(entry: MarketplacePluginEntry, sourcePath: string): Promise<string> {
		if (entry.version) return entry.version;

		for (const manifestPath of [
			path.join(sourcePath, ".claude-plugin", "plugin.json"),
			path.join(sourcePath, "package.json"),
		]) {
			try {
				const content = await Bun.file(manifestPath).json();
				if (typeof content?.version === "string" && content.version) {
					return content.version;
				}
			} catch {}
		}

		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha) {
			return entry.source.sha.slice(0, 7);
		}

		return "0.0.0";
	}

	async uninstallPlugin(pluginId: string, scope?: "user" | "project"): Promise<void> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID format: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to remove.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const targetEntries = targetScope === "project" ? projectEntries! : userEntries!;
		const targetReg = targetScope === "project" ? projectReg : userReg;
		const registryPath = this.#registryPath(targetScope);
		const packageNames = await this.#resolveInstalledPackageNames(targetEntries, parsed.name);

		const updatedReg = removeInstalledPlugin(targetReg, pluginId);
		await writeInstalledPluginsRegistry(registryPath, updatedReg);

		const [freshUserReg, freshProjectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(freshUserReg, freshProjectReg);

		for (const entry of targetEntries) {
			if (!referenced.has(entry.installPath)) {
				await fs.rm(entry.installPath, { recursive: true, force: true });
			}
		}

		for (const packageName of packageNames) {
			await this.#removeRuntimePlugin(targetScope, packageName);
		}

		this.#clearCache();

		logger.debug("Plugin uninstalled", { pluginId, scope: targetScope });
	}

	async listInstalledPlugins(): Promise<InstalledPluginSummary[]> {
		const userReg = await readInstalledPluginsRegistry(this.#opts.installedRegistryPath);
		const projectReg = this.#opts.projectInstalledRegistryPath
			? await readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
			: null;

		const activeProjectIds = new Set(
			projectReg
				? Object.entries(projectReg.plugins)
						.filter(([, entries]) => entries.length > 0 && entries[0].enabled !== false)
						.map(([id]) => id)
				: [],
		);
		const results: InstalledPluginSummary[] = [];

		if (projectReg) {
			for (const [id, entries] of Object.entries(projectReg.plugins)) {
				results.push({ id, scope: "project", entries });
			}
		}
		for (const [id, entries] of Object.entries(userReg.plugins)) {
			results.push({
				id,
				scope: "user",
				entries,
				...(activeProjectIds.has(id) ? { shadowedBy: "project" as const } : {}),
			});
		}
		return results;
	}

	async setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to modify.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const reg = targetScope === "project" ? projectReg : userReg;
		const entries = targetScope === "project" ? projectEntries! : userEntries!;
		const registryPath = this.#registryPath(targetScope);

		const updated = {
			...reg,
			plugins: {
				...reg.plugins,
				[pluginId]: entries.map(e => ({ ...e, enabled })),
			},
		};
		await writeInstalledPluginsRegistry(registryPath, updated);

		const fallbackName = parsePluginId(pluginId)?.name ?? pluginId;
		const packageNames = await this.#resolveInstalledPackageNames(entries, fallbackName);
		for (const packageName of packageNames) {
			await this.#setRuntimePluginEnabled(targetScope, packageName, enabled);
		}

		this.#clearCache();

		logger.debug("Plugin enabled state changed", { pluginId, enabled, scope: targetScope });
	}

	async refreshStaleMarketplaces(): Promise<void> {
		const reg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const staleMs = DAY_MS;
		for (const entry of reg.marketplaces) {
			if (Date.now() - Date.parse(entry.updatedAt) >= staleMs) {
				try {
					await this.updateMarketplace(entry.name);
				} catch (error) {
					logger.warn(
						`The catalog for marketplace ${entry.name} could not be refreshed, so plugin lookups keep using ` +
							`the stale copy: ${errorMessage(error)}. Fix: check network access, then run ` +
							`\`veyyon plugin marketplace update ${entry.name}\`.`,
						{
							marketplace: entry.name,
							error: errorMessage(error),
						},
					);
				}
			}
		}
	}

	async checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>> {
		const mktReg = await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath);
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];

		const registryEntries: Array<[string, "user" | "project"]> = [[this.#opts.installedRegistryPath, "user"]];
		if (this.#opts.projectInstalledRegistryPath) {
			registryEntries.push([this.#opts.projectInstalledRegistryPath, "project"]);
		}

		for (const [regPath, scope] of registryEntries) {
			const instReg = await readInstalledPluginsRegistry(regPath);
			for (const [pluginId, entries] of Object.entries(instReg.plugins)) {
				const parsed = parsePluginId(pluginId);
				if (!parsed) continue;
				const installed = entries[0];
				if (!installed) continue;

				const mktEntry = mktReg.marketplaces.find(m => m.name === parsed.marketplace);
				if (!mktEntry) continue;

				let catalogVersion: string | undefined;
				try {
					const catalog = await this.#readCatalog(mktEntry);
					catalogVersion = catalog.plugins.find(p => p.name === parsed.name)?.version;
				} catch {
					continue;
				}

				if (!catalogVersion || catalogVersion === installed.version) continue;

				let isNewer: boolean;
				try {
					isNewer = Bun.semver.order(catalogVersion, installed.version) > 0;
				} catch {
					isNewer = catalogVersion !== installed.version;
				}

				if (isNewer) {
					updates.push({ pluginId, scope, from: installed.version, to: catalogVersion });
				}
			}
		}

		return updates;
	}

	async upgradePlugin(pluginId: string, scope?: "user" | "project"): Promise<InstalledPluginEntry> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let resolvedScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to upgrade.`,
				);
			}
			resolvedScope = scope;
		} else if (inProject) {
			if (scope === "user") throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			resolvedScope = "project";
		} else {
			if (scope === "project") throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			resolvedScope = "user";
		}

		return this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: resolvedScope });
	}

	async upgradePluginAcrossScopes(pluginId: string): Promise<InstalledPluginEntry[]> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		const results: InstalledPluginEntry[] = [];

		if (inProject) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "project" });
			results.push(entry);
		}
		if (inUser) {
			const entry = await this.installPlugin(parsed.name, parsed.marketplace, { force: true, scope: "user" });
			results.push(entry);
		}

		return results;
	}

	async upgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const updates = await this.checkForUpdates();
		const results: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of updates) {
			try {
				const entry = await this.upgradePlugin(update.pluginId, update.scope);
				results.push({ pluginId: update.pluginId, scope: update.scope, from: update.from, to: entry.version });
			} catch (error) {
				logger.warn(
					`Plugin ${update.pluginId} could not be upgraded, so version ${update.from} stays installed. ` +
						`Fix: run \`veyyon plugin upgrade ${update.pluginId}\` to retry, or ` +
						`\`veyyon plugin uninstall ${update.pluginId}\` and install it again.`,
					{
						pluginId: update.pluginId,
						scope: update.scope,
						from: update.from,
						to: update.to,
						error: errorMessage(error),
					},
				);
			}
		}
		return results;
	}

	#runtimeRoot(scope: "user" | "project"): string {
		return path.dirname(this.#registryPath(scope));
	}

	#nodeModulesPath(scope: "user" | "project"): string {
		return path.join(this.#runtimeRoot(scope), "node_modules");
	}

	#runtimeLockPath(scope: "user" | "project"): string {
		return path.join(this.#runtimeRoot(scope), "veyyon-plugins.lock.json");
	}

	async #loadRuntimeConfig(scope: "user" | "project"): Promise<PluginRuntimeConfig> {
		try {
			return normalizePluginRuntimeConfig(await Bun.file(this.#runtimeLockPath(scope)).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn(
				`The marketplace plugin runtime config at ${this.#runtimeLockPath(scope)} could not be read ` +
					`(${errorMessage(err)}), so every marketplace plugin is treated as freshly installed with default ` +
					"settings. Fix: check that file's permissions, or delete it to have it rebuilt.",
				{
					path: this.#runtimeLockPath(scope),
					error: errorMessage(err),
				},
			);
			return normalizePluginRuntimeConfig({});
		}
	}

	async #writeRuntimeConfig(scope: "user" | "project", config: PluginRuntimeConfig): Promise<void> {
		await Bun.write(this.#runtimeLockPath(scope), JSON.stringify(config, null, 2));
	}

	async #resolvePluginPackageName(installPath: string, fallbackName: string): Promise<string> {
		try {
			const pkg: { name?: unknown } = await Bun.file(path.join(installPath, "package.json")).json();
			const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : fallbackName;
			return assertRuntimePackageName(name);
		} catch (err) {
			if (isEnoent(err)) return assertRuntimePackageName(fallbackName);
			throw err;
		}
	}

	#runtimePackagePath(scope: "user" | "project", packageName: string): string {
		const nodeModules = path.resolve(this.#nodeModulesPath(scope));
		const linkPath = path.resolve(nodeModules, assertRuntimePackageName(packageName));
		const relative = path.relative(nodeModules, linkPath);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Marketplace plugin package path escapes node_modules: ${JSON.stringify(packageName)}`);
		}
		return linkPath;
	}

	async #resolveInstalledPackageNames(
		entries: readonly InstalledPluginEntry[],
		fallbackName: string,
	): Promise<Set<string>> {
		const packageNames = new Set<string>();
		for (const entry of entries) {
			packageNames.add(await this.#resolvePluginPackageName(entry.installPath, fallbackName));
		}
		return packageNames;
	}

	async #registerRuntimePlugin(
		scope: "user" | "project",
		packageName: string,
		cachePath: string,
		version: string,
		enabled: boolean | undefined,
	): Promise<void> {
		const linkPath = this.#runtimePackagePath(scope, packageName);
		await fs.mkdir(path.dirname(linkPath), { recursive: true });
		await fs.rm(linkPath, { recursive: true, force: true });
		await fs.symlink(cachePath, linkPath, process.platform === "win32" ? "junction" : "dir");

		const config = await this.#loadRuntimeConfig(scope);
		const previous = config.plugins[packageName];
		config.plugins[packageName] = {
			version,
			enabledFeatures: previous?.enabledFeatures ?? null,
			enabled: enabled ?? previous?.enabled ?? true,
		};
		await this.#writeRuntimeConfig(scope, config);
	}

	async #removeRuntimePlugin(scope: "user" | "project", packageName: string): Promise<void> {
		await fs.rm(this.#runtimePackagePath(scope, packageName), { recursive: true, force: true });

		const config = await this.#loadRuntimeConfig(scope);
		delete config.plugins[packageName];
		delete config.settings[packageName];
		await this.#writeRuntimeConfig(scope, config);
	}

	async #setRuntimePluginEnabled(scope: "user" | "project", packageName: string, enabled: boolean): Promise<void> {
		const config = await this.#loadRuntimeConfig(scope);
		const previous = config.plugins[packageName];
		if (!previous) return;

		config.plugins[packageName] = { ...previous, enabled };
		await this.#writeRuntimeConfig(scope, config);
	}

	#registryPath(scope: "user" | "project"): string {
		if (scope === "project") {
			if (!this.#opts.projectInstalledRegistryPath) {
				throw new Error("project-scoped install requires running inside a project directory");
			}
			return this.#opts.projectInstalledRegistryPath;
		}
		return this.#opts.installedRegistryPath;
	}

	async #findInBothRegistries(pluginId: string): Promise<{
		userEntries: InstalledPluginEntry[] | undefined;
		projectEntries: InstalledPluginEntry[] | undefined;
		userReg: InstalledPluginsRegistry;
		projectReg: InstalledPluginsRegistry;
	}> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		return {
			userEntries: getInstalledPlugin(userReg, pluginId),
			projectEntries: getInstalledPlugin(projectReg, pluginId),
			userReg,
			projectReg,
		};
	}

	async #readCatalog(entry: MarketplaceRegistryEntry): Promise<MarketplaceCatalog> {
		try {
			const content = await Bun.file(entry.catalogPath).text();
			return parseMarketplaceCatalog(content, entry.catalogPath);
		} catch (err) {
			if (isEnoent(err)) {
				throw new Error(
					`The catalog for marketplace "${entry.name}" is not on disk at ${entry.catalogPath}, so none of ` +
						`its plugins can be resolved. Fix: run \`veyyon plugin marketplace update ${entry.name}\` to ` +
						"fetch it again.",
				);
			}
			throw err;
		}
	}

	#resolveMarketplaceRoot(entry: MarketplaceRegistryEntry): string {
		if (entry.sourceType === "local") {
			const expanded = entry.sourceUri.startsWith("~/")
				? path.join(os.homedir(), entry.sourceUri.slice(2))
				: entry.sourceUri;
			return path.resolve(expanded);
		}
		return path.dirname(entry.catalogPath);
	}
}
