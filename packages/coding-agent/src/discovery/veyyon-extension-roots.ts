/** Veyyon extension package roots. An "extension package root" is a directory configured via either */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger, tryParseJson } from "@veyyon/utils";
import { readDirEntries, readFile } from "../capability/fs";
import type { LoadContext } from "../capability/types";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import { expandTilde } from "../tools/path-utils";
import { listClaudePluginRoots, pluginsRootFor } from "./helpers";

/** A resolved extension package directory wired into the discovery surfaces. */
export interface VeyyonExtensionRoot {
	/** Absolute path to the package directory. */
	path: string;
	/** Stable display name (basename of the package directory). */
	name: string;
	/** Scope from which the path was sourced. */
	level: "user" | "project";
}

interface InjectedRoot {
	path: string;
	level: "user" | "project";
}

let injectedCliRoots: InjectedRoot[] = [];

/** Register CLI-provided extension package paths (e.g. from `--extension`/`-e`) so the sub-discovery providers can find their sibling `skills/`, `hooks/`, */
export function injectVeyyonExtensionCliRoots(paths: readonly string[], home: string, cwd: string): void {
	if (paths.length === 0) return;
	const expanded = paths.map(raw => {
		const tilde = expandTilde(raw, home);
		return path.isAbsolute(tilde) ? tilde : path.resolve(cwd, tilde);
	});
	const merged = new Map<string, InjectedRoot>();
	for (const root of injectedCliRoots) merged.set(root.path, root);
	for (const resolved of expanded) {
		// CLI scope mirrors how `--extension` is treated elsewhere — user-level overrides win.
		if (!merged.has(resolved)) merged.set(resolved, { path: resolved, level: "user" });
	}
	injectedCliRoots = Array.from(merged.values());
}

/** Drop every CLI-injected root. Tests use this between cases. */
export function clearVeyyonExtensionCliRoots(): void {
	injectedCliRoots = [];
}

/** Inspect currently-injected CLI roots (read-only). Exposed for diagnostics + tests. */
export function getInjectedVeyyonExtensionCliRoots(): readonly VeyyonExtensionRoot[] {
	return injectedCliRoots.map(({ path: p, level }) => ({ path: p, level, name: path.basename(p) }));
}

interface ScopeDirs {
	project: string;
	user: string;
}

/** WHICH profile supplies the user scope, and the project dir for `ctx.cwd`. `agentDir` used to be absent here and `user` was always `getAgentDir()`, so a caller */
function scopeDirs(ctx: LoadContext, agentDir: string): ScopeDirs {
	return {
		project: path.join(ctx.cwd, ".veyyon"),
		user: agentDir,
	};
}

async function readSettingsExtensions(settingsPath: string): Promise<string[]> {
	const content = await readFile(settingsPath);
	if (!content) return [];
	const parsed = tryParseJson<{ extensions?: unknown }>(content);
	const raw = parsed?.extensions;
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function resolveAgainst(raw: string, ctx: LoadContext): string {
	const tilde = expandTilde(raw, ctx.home);
	return path.isAbsolute(tilde) ? tilde : path.resolve(ctx.cwd, tilde);
}

async function isDirectory(p: string): Promise<boolean> {
	const entries = await readDirEntries(p);
	if (entries.length > 0) return true;
	// Empty directory still counts; cache returns [] for both empty and missing.
	// Disambiguate with a single stat — only hit when the cached listing is empty.
	try {
		const stat = await fs.stat(p);
		return stat.isDirectory();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/** Options for {@link listVeyyonExtensionRoots}. */
export interface ListVeyyonExtensionRootsOptions {
	/** WHICH profile supplies the user scope: its `settings.json#extensions` and its installed plugins. Default: {@link getAgentDir}, the process-active profile. */
	agentDir?: string;
}

/** Resolve every configured extension package directory for the given context. Sources, in order of precedence (later entries with the same absolute path */
export async function listVeyyonExtensionRoots(
	ctx: LoadContext,
	options: ListVeyyonExtensionRootsOptions = {},
): Promise<VeyyonExtensionRoot[]> {
	const agentDir = options.agentDir ?? getAgentDir();
	const { user } = scopeDirs(ctx, agentDir);
	const [userExtensions, installedPlugins] = await Promise.all([
		readSettingsExtensions(path.join(user, "settings.json")),
		listInstalledPluginRoots(ctx, pluginsRootFor(agentDir)),
	]);

	const candidates: InjectedRoot[] = [
		...injectedCliRoots,
		...userExtensions.map((raw): InjectedRoot => ({ path: resolveAgainst(raw, ctx), level: "user" })),
		...installedPlugins,
	];

	// First-seen-wins dedup preserves CLI > user-settings > installed precedence.
	const seen = new Set<string>();
	const unique: InjectedRoot[] = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		unique.push(candidate);
	}

	const directoryFlags = await Promise.all(unique.map(c => isDirectory(c.path)));
	const roots: VeyyonExtensionRoot[] = [];
	for (let i = 0; i < unique.length; i++) {
		if (!directoryFlags[i]) continue;
		const { path: p, level } = unique[i];
		roots.push({ path: p, level, name: path.basename(p) });
	}
	return roots;
}

/** Enumerate every enabled npm/link plugin's package directory so its conventional `skills/`, `hooks/`, `tools/`, `commands/`, `rules/`, `prompts/`, and */
async function realpathOrResolved(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch (err) {
		if (isEnoent(err)) return path.resolve(p);
		throw err;
	}
}

async function listInstalledPluginRoots(ctx: LoadContext, pluginsRoot: string | undefined): Promise<InjectedRoot[]> {
	try {
		const [plugins, marketplaceRoots] = await Promise.all([
			getEnabledPlugins(ctx.cwd, { home: ctx.home, pluginsRoot }),
			// Same profile on both sides: the exclusion set has to be THIS profile's marketplace installs, or a package the named profile installed by hand
			listClaudePluginRoots(ctx.home, ctx.cwd, pluginsRoot, ctx.agentDir),
		]);
		const marketplaceRealpaths = new Set(
			await Promise.all(marketplaceRoots.roots.map(root => realpathOrResolved(root.path))),
		);
		const installedRoots = await Promise.all(
			plugins.map(async plugin => ({
				path: plugin.path,
				scope: plugin.scope,
				realpath: await realpathOrResolved(plugin.path),
			})),
		);
		return installedRoots
			.filter(root => !marketplaceRealpaths.has(root.realpath))
			.map(({ path: p, scope }) => ({ path: p, level: scope }));
	} catch (err) {
		logger.debug("listInstalledPluginRoots: enumeration failed", { error: String(err) });
		return [];
	}
}
