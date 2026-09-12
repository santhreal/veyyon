/**
 * Veyyon extension package roots.
 *
 * An "extension package root" is a directory configured via either
 * `extensions:` in the profile's config.yml or the `--extension`/`-e` CLI flag
 * that points to a packaged extension on disk. The package's standard
 * sub-directories (`skills/`, `hooks/`, `tools/`, `commands/`, `rules/`,
 * `prompts/`, `.mcp.json`) are wired into discovery by `veyyon-plugins.ts`.
 *
 * CLI-provided paths are injected via {@link injectVeyyonExtensionCliRoots}
 * before discovery runs; the `extensions` setting is read from the settings
 * store in {@link listVeyyonExtensionRoots}, the same source the session's
 * extension-module loader reads (`settings.get("extensions")` in `sdk.ts`).
 *
 * @see ./veyyon-plugins.ts
 * @see ./builtin.ts `loadExtensionModules`
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@veyyon/utils";
import { settingsOrNull } from "../config/settings-instance";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import { expandTilde } from "../tools/core/path-utils";
import { readDirEntries } from "./capability/fs";
import type { LoadContext } from "./capability/types";
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

/**
 * Register CLI-provided extension package paths (e.g. from `--extension`/`-e`)
 * so the sub-discovery providers can find their sibling `skills/`, `hooks/`,
 * etc. Paths that do not resolve to a directory are silently dropped — file
 * entrypoints have no package sub-tree to scan.
 *
 * Call once during startup before any capability load. Repeated calls extend
 * the registered set; {@link clearVeyyonExtensionCliRoots} resets for tests.
 */
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

/**
 * The `extensions` setting, read from the settings store.
 *
 * This is the source `sdk.ts` reads to load the extension MODULES named by the setting
 * (`settings.get("extensions")`). Sub-discovery used to read `<agentDir>/settings.json`
 * instead — the legacy file `config/settings.ts` migrates away from — so a package named
 * in config.yml loaded its module and none of its `skills/`, `hooks/`, `commands/`.
 * One setting, one reader.
 */
function settingsExtensions(): string[] {
	const raw = settingsOrNull()?.get("extensions") ?? [];
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
	/**
	 * WHICH profile supplies the user scope: its installed plugins. Default:
	 * {@link getAgentDir}, the process-active profile.
	 */
	agentDir?: string;
}

/**
 * Resolve every configured extension package directory for the given context.
 *
 * Sources, in order of precedence (later entries with the same absolute path
 * are dropped):
 *
 * 1. CLI roots injected via {@link injectVeyyonExtensionCliRoots}
 * 2. The `extensions` setting (config.yml), read from the settings store
 * 3. Enabled npm/link plugins installed under `<plugins>/node_modules/` (for
 *    `veyyon install <pkg>` / `veyyon plugin install` / `veyyon plugin link`). Marketplace
 *    installs are loaded by the `claude-plugins` provider and are excluded here.
 * Only entries that resolve to a directory on disk are returned; file
 * entrypoints contribute zero sub-discovery surface and are filtered out.
 * Installed-plugin enumeration failures (missing lockfile, unreadable
 * `package.json`, etc.) are logged at `debug` and degrade gracefully, the
 * other sources still surface.
 *
 * `<cwd>/.veyyon/settings.json#extensions` used to sit above the user scope
 * here. It was the single worst instance of the repo-configures-the-agent
 * defect: a checked-in file naming arbitrary package roots whose `skills/`,
 * `commands/`, `rules/`, `prompts/`, `hooks/`, `tools/` and MCP were all then
 * scanned. It is gone, and so is the project settings layer that fed it.
 *
 * The installed-plugin source is PROFILE scoped, so `options.agentDir` selects
 * it. Without it it resolved the process-global active profile, which is why
 * a session rooted in another agent dir loaded that profile's plugin packages
 * instead of its own.
 */
export async function listVeyyonExtensionRoots(
	ctx: LoadContext,
	options: ListVeyyonExtensionRootsOptions = {},
): Promise<VeyyonExtensionRoot[]> {
	const agentDir = options.agentDir ?? getAgentDir();
	const userExtensions = settingsExtensions();
	const installedPlugins = await listInstalledPluginRoots(ctx, pluginsRootFor(agentDir));

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

/**
 * Enumerate every enabled npm/link plugin's package directory so its conventional
 * `skills/`, `hooks/`, `tools/`, `commands/`, `rules/`, `prompts/`, and
 * `.mcp.json` are wired into discovery — mirrors how `getAllPluginExtensionPaths`
 * already feeds the extension factory loader.
 *
 * Marketplace installs also create runtime symlinks for enable-state persistence,
 * but their resources are discovered through the `claude-plugins` provider.
 * Filtering them here prevents `/status` from showing the same plugin under both
 * "Claude Code Marketplace" and "Extension Packages".
 */
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
			// Same profile on both sides: the exclusion set has to be THIS profile's
			// marketplace installs, or a package the named profile installed by hand
			// gets dropped because the ACTIVE profile happens to have it from a
			// marketplace, and vice versa.
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
