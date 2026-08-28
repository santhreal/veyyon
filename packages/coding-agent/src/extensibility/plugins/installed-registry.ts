import * as path from "node:path";

import { atomicWriteJson, getPluginsDir, isEnoent, logger, tryParseJson } from "@veyyon/utils";

export interface InstalledPluginsRegistry {
	version: 2;
	plugins: Record<string, InstalledPluginEntry[]>;
}

export interface InstalledPluginEntry {
	scope: "user" | "project";
	installPath: string;
	version: string;
	installedAt: string;
	lastUpdated: string;
	gitCommitSha?: string;
	enabled?: boolean;
}

export function getInstalledPluginsRegistryPath(): string {
	return path.join(getPluginsDir(), "installed_plugins.json");
}

export function getPluginsCacheDir(): string {
	return path.join(getPluginsDir(), "cache", "plugins");
}

function emptyInstalledPluginsRegistry(): InstalledPluginsRegistry {
	return { version: 2, plugins: {} };
}

export async function readInstalledPluginsRegistry(filePath: string): Promise<InstalledPluginsRegistry> {
	try {
		const content = await Bun.file(filePath).text();
		const data = tryParseJson<InstalledPluginsRegistry>(content);
		if (
			!data ||
			typeof data !== "object" ||
			typeof data.version !== "number" ||
			!data.plugins ||
			typeof data.plugins !== "object" ||
			Array.isArray(data.plugins)
		) {
			logger.warn("Invalid installed plugins registry, returning empty", { path: filePath });
			return emptyInstalledPluginsRegistry();
		}
		return { ...data, version: 2 };
	} catch (err) {
		if (isEnoent(err)) return emptyInstalledPluginsRegistry();
		throw err;
	}
}

export async function writeInstalledPluginsRegistry(filePath: string, reg: InstalledPluginsRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

export function addInstalledPlugin(
	reg: InstalledPluginsRegistry,
	id: string,
	entry: InstalledPluginEntry,
): InstalledPluginsRegistry {
	const existing = reg.plugins[id] ?? [];
	return {
		...reg,
		plugins: { ...reg.plugins, [id]: existing.concat([entry]) },
	};
}

export function removeInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginsRegistry {
	if (!(id in reg.plugins)) {
		throw new Error(`Plugin "${id}" not found in registry`);
	}
	const { [id]: _, ...rest } = reg.plugins;
	return { ...reg, plugins: rest };
}

export function getInstalledPlugin(reg: InstalledPluginsRegistry, id: string): InstalledPluginEntry[] | undefined {
	return reg.plugins[id];
}

export function collectReferencedPaths(...registries: InstalledPluginsRegistry[]): Set<string> {
	return new Set(
		registries.flatMap(r =>
			Object.values(r.plugins)
				.flat()
				.map(e => e.installPath),
		),
	);
}
