/**
 * Installed plugin registry read/write (Claude Code-compatible shape).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getPluginsDir, isEnoent, logger, tryParseJson } from "@veyyon/pi-utils";

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

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	const tmpPath = `${filePath}.tmp`;
	await Bun.write(tmpPath, content);
	try {
		await fs.rename(tmpPath, filePath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			try {
				await fs.unlink(filePath);
			} catch {
				// ignore
			}
			await fs.rename(tmpPath, filePath);
		} else {
			try {
				await fs.unlink(tmpPath);
			} catch {
				// ignore
			}
			throw err;
		}
	}
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
