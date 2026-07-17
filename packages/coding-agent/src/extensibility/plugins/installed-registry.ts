/**
 * Installed plugin registry read/write (Claude Code-compatible shape).
 */

import * as path from "node:path";

import { atomicWriteJson, getPluginsDir, isEnoent, logger, tryParseJson } from "@veyyon/pi-utils";

// MUST match ClaudePluginsRegistry shape for parseClaudePluginsRegistry()
// compatibility: `version: number`, `plugins: Record<string, entry[]>`.
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
	/** OMP extension — not in Claude Code's type. CLI/UI concern only in v1. */
	enabled?: boolean;
}

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 64;

export function isValidNameSegment(s: string): boolean {
	return s.length > 0 && s.length <= MAX_NAME_LENGTH && NAME_RE.test(s);
}

/** Parse `"name@marketplace"` for legacy installed plugin IDs. */
export function parsePluginId(id: string): { name: string; marketplace: string } | null {
	const atIndex = id.lastIndexOf("@");
	if (atIndex <= 0 || atIndex === id.length - 1) return null;
	const name = id.slice(0, atIndex);
	const marketplace = id.slice(atIndex + 1);
	if (!isValidNameSegment(name) || !isValidNameSegment(marketplace)) return null;
	return { name, marketplace };
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

export function collectReferencedPaths(...registries: InstalledPluginsRegistry[]): Set<string> {
	return new Set(
		registries.flatMap(r =>
			Object.values(r.plugins)
				.flat()
				.map(e => e.installPath),
		),
	);
}
