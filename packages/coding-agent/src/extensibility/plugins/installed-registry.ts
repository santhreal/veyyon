/**
 * Installed plugin registry read/write (Claude Code-compatible shape).
 *
 * This is the single owner of the installed-plugins registry: the type, the
 * on-disk path/cache helpers, the read/write functions, and the pure CRUD
 * transforms. The marketplace layer (`marketplace/registry.ts`,
 * `marketplace/types.ts`) builds on top of this and re-exports it, so the
 * installed-registry shape lives in exactly one place.
 */

import * as path from "node:path";

import { atomicWriteJson, getPluginsDir, isEnoent, logger, tryParseJson } from "@veyyon/utils";

export interface InstalledPluginsRegistry {
	/** MUST be 2 — parseClaudePluginsRegistry rejects non-numeric version. */
	version: 2;
	plugins: Record<string, InstalledPluginEntry[]>;
}

export interface InstalledPluginEntry {
	scope: "user" | "project";
	/** Absolute path to cached plugin directory. */
	installPath: string;
	version: string;
	/** ISO 8601 date string. */
	installedAt: string;
	/** ISO 8601 date string. */
	lastUpdated: string;
	/** For git-sourced plugins. */
	gitCommitSha?: string;
	/** Veyyon extension — not in Claude Code's type. CLI/UI concern only in v1. */
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
		// Accept any numeric version — forward compatible reads
		return { ...data, version: 2 };
	} catch (err) {
		if (isEnoent(err)) return emptyInstalledPluginsRegistry();
		throw err;
	}
}

export async function writeInstalledPluginsRegistry(filePath: string, reg: InstalledPluginsRegistry): Promise<void> {
	await atomicWriteJson(filePath, reg);
}

// ── Installed plugin CRUD ────────────────────────────────────────────
// Pure functions that transform registry state. Caller is responsible for
// reading, mutating, and writing back.

export function addInstalledPlugin(
	reg: InstalledPluginsRegistry,
	id: string,
	entry: InstalledPluginEntry,
): InstalledPluginsRegistry {
	const existing = reg.plugins[id] ?? [];
	return {
		...reg,
		plugins: { ...reg.plugins, [id]: [...existing, entry] },
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

/**
 * Collect all installPath values referenced by any of the provided registries.
 * Use this before deleting a cached plugin directory to verify it is not still
 * referenced by another scope's registry.
 */
export function collectReferencedPaths(...registries: InstalledPluginsRegistry[]): Set<string> {
	return new Set(
		registries.flatMap(r =>
			Object.values(r.plugins)
				.flat()
				.map(e => e.installPath),
		),
	);
}
