export { buildPluginId, isValidNameSegment, parsePluginId } from "../plugin-id";

export interface MarketplaceCatalogOwner {
	name: string;
	email?: string;
}

export interface MarketplaceCatalogMetadata {
	description?: string;
	version?: string;
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

import type { InstalledPluginEntry, InstalledPluginsRegistry } from "../installed-registry";

export type { InstalledPluginEntry, InstalledPluginsRegistry };

export interface InstalledPluginSummary {
	id: string;
	scope: "user" | "project";
	entries: InstalledPluginEntry[];
	shadowedBy?: "project";
}
