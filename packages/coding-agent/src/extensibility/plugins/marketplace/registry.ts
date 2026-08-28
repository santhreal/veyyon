/** Registry read/write operations for the marketplace plugin system. Two registries: */

import * as path from "node:path";

import { atomicWriteJson, getConfigRootDir, getPluginsDir, isEnoent, logger, tryParseJson } from "@veyyon/utils";

import type { MarketplaceRegistryEntry, MarketplacesRegistry } from "./types";

// ── Installed plugins registry (re-exported from the single owner) ────
export {
	addInstalledPlugin,
	collectReferencedPaths,
	getInstalledPlugin,
	getInstalledPluginsRegistryPath,
	getPluginsCacheDir,
	readInstalledPluginsRegistry,
	removeInstalledPlugin,
	writeInstalledPluginsRegistry,
} from "../installed-registry";

// ── Path helpers ─────────────────────────────────────────────────────

export function getMarketplacesRegistryPath(): string {
	return path.join(getConfigRootDir(), "marketplaces.json");
}

export function getMarketplacesCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "marketplaces");
}

// ── Marketplaces registry ────────────────────────────────────────────

function emptyMarketplacesRegistry(): MarketplacesRegistry {
	return { version: 1, marketplaces: [] };
}

export async function readMarketplacesRegistry(filePath: string): Promise<MarketplacesRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<MarketplacesRegistry>(content);
		if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.marketplaces)) {
			logger.warn("Invalid marketplaces registry, returning empty", { path: filePath });
			return emptyMarketplacesRegistry();
		}
		return data;
	} catch (err) {
		if (isEnoent(err)) return emptyMarketplacesRegistry();
		throw err;
	}
}

export async function writeMarketplacesRegistry(filePath: string, reg: MarketplacesRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

// ── Marketplace CRUD ─────────────────────────────────────────────────
// Pure functions that transform registry state. Caller is responsible for
// reading, mutating, and writing back.

export function addMarketplaceEntry(reg: MarketplacesRegistry, entry: MarketplaceRegistryEntry): MarketplacesRegistry {
	if (reg.marketplaces.some(m => m.name === entry.name)) {
		throw new Error(`Marketplace "${entry.name}" already exists`);
	}
	return { ...reg, marketplaces: reg.marketplaces.concat([entry]) };
}

export function removeMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplacesRegistry {
	const filtered = reg.marketplaces.filter(m => m.name !== name);
	if (filtered.length === reg.marketplaces.length) {
		throw new Error(`Marketplace "${name}" not found`);
	}
	return { ...reg, marketplaces: filtered };
}

export function getMarketplaceEntry(reg: MarketplacesRegistry, name: string): MarketplaceRegistryEntry | undefined {
	return reg.marketplaces.find(m => m.name === name);
}
