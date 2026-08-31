/**
 * Marketplace plugin system types.
 *
 * Two registries:
 *   - MarketplacesRegistry: which marketplace catalogs the user has added (config)
 *   - InstalledPluginsRegistry: which plugins are installed (data, Claude Code-compatible)
 *
 * The installed registry MUST pass `parseClaudePluginsRegistry()` validation —
 * it uses `version: 2` (numeric) and `plugins: Record<string, ...[]>`.
 */

// ── Plugin ID helpers ────────────────────────────────────────────────
// Re-exported from the single owner so `./types` importers (cache, fetcher,
// marketplace/manager) keep their import paths while the validation grammar
// lives in exactly one place shared with the installed registry.
export { buildPluginId, isValidNameSegment, parsePluginId } from "../plugin-id";

// ── Marketplace catalog (from marketplace.json in a marketplace repo) ─

export interface MarketplaceCatalogOwner {
	name: string;
	email?: string;
}

export interface MarketplaceCatalogMetadata {
	description?: string;
	version?: string;
	/** If set, prepended to relative plugin source paths. */
	pluginRoot?: string;
}

export interface MarketplaceCatalog {
	name: string;
	owner: MarketplaceCatalogOwner;
	metadata?: MarketplaceCatalogMetadata;
	plugins: MarketplacePluginEntry[];
}

export interface MarketplacePluginAuthor {
	name: string;
	email?: string;
}

export interface MarketplacePluginEntry {
	name: string;
	source: PluginSource;
	description?: string;
	version?: string;
	author?: MarketplacePluginAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	strict?: boolean;
	commands?: string | string[];
	agents?: string | string[];
	hooks?: string | Record<string, unknown>;
	mcpServers?: string | Record<string, unknown>;
	lspServers?: string | Record<string, unknown>;
	dapAdapters?: string | Record<string, unknown>;
}

// ── Plugin source variants ───────────────────────────────────────────

export type PluginSource =
	| string // relative path "./plugins/foo"
	| PluginSourceGitHub
	| PluginSourceUrl
	| PluginSourceGitSubdir
	| PluginSourceNpm;

export interface PluginSourceGitHub {
	source: "github";
	repo: string;
	ref?: string;
	sha?: string;
}

export interface PluginSourceUrl {
	source: "url";
	url: string;
	ref?: string;
	sha?: string;
}

export interface PluginSourceGitSubdir {
	source: "git-subdir";
	url: string;
	path: string;
	ref?: string;
	sha?: string;
}

export interface PluginSourceNpm {
	source: "npm";
	package: string;
	version?: string;
	registry?: string;
}

// ── Marketplaces registry (stored in <configRoot>/marketplaces.json) ─

export interface MarketplacesRegistry {
	version: 1;
	marketplaces: MarketplaceRegistryEntry[];
}

export type MarketplaceSourceType = "github" | "git" | "url" | "local";

export interface MarketplaceRegistryEntry {
	name: string;
	sourceType: MarketplaceSourceType;
	sourceUri: string;
	catalogPath: string;
	addedAt: string;
	updatedAt: string;
}

// ── Installed plugins registry ───────────────────────────────────────
// The installed-plugins registry (Claude Code-compatible shape) is owned by
// `../installed-registry`. Imported for use in InstalledPluginSummary below and
// re-exported so marketplace consumers that already import from `./types` keep
// their import path while the type lives in exactly one place.
import type { InstalledPluginEntry, InstalledPluginsRegistry } from "../installed-registry";

export type { InstalledPluginEntry, InstalledPluginsRegistry };

/**
 * A merged view of an installed plugin, combining entries from both the user and
 * project registries. Returned by MarketplaceManager.listInstalledPlugins().
 *
 * `shadowedBy` is set on user-scoped summaries when the same plugin ID also exists
 * in the project registry — the project entry takes precedence for capability loading.
 */
export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	entries: InstalledPluginEntry[];
	/** Set when a user-scoped plugin is overridden by a project-scoped install. */
	shadowedBy?: "project";
}
