/**
 * Capability Registry
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, logger } from "@veyyon/utils";

import type { Settings } from "../config/settings";
import { clearCache as clearFsCache, findRepoRoot, cacheStats as fsCacheStats, invalidate as invalidateFs } from "./fs";
import type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";

// =============================================================================
// Registry State
// =============================================================================

/** Registry of all capabilities */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Disabled providers (by ID) */
const disabledProviders = new Set<string>();

/**
 * Providers that discover configuration authored for *other* AI tools — skills,
 * context files (CLAUDE.md/AGENTS.md), rules, and MCP servers found by scanning
 * another tool's conventions on disk. These are gated behind
 * `discovery.importForeignConfig` (default OFF: veyyon runs on its own three
 * instruction layers only — the compiled system prompt, the global
 * ~/.veyyon/AGENTS.md, and the active profile's AGENTS.md — and never ambiently
 * picks up a foreign CLAUDE.md/GEMINI.md or external skills. The user can opt in
 * to import them as a machine-wide base layer). veyyon's own providers (native,
 * veyyon-plugins, builtin, project/user commands, ssh/mcp standards) are never
 * gated by this.
 */
export const FOREIGN_PROVIDER_IDS: ReadonlySet<string> = new Set([
	"agents",
	"agents-md",
	"claude",
	"claude-plugins",
	"cline",
	"codex",
	"cursor",
	"gemini",
	"github",
	"opencode",
	"vscode",
	"windsurf",
]);

/** When false, FOREIGN_PROVIDER_IDS are treated as disabled. Matches the schema default (off). */
let importForeignConfig = false;

/** Settings manager for persistence (if set) */
let settings: Settings | null = null;

// =============================================================================
// Registration API
// =============================================================================

/**
 * Define a new capability.
 */
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

/**
 * Register a provider for a capability.
 */
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	// Store provider metadata (for cross-capability display)
	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	// Track which capabilities this provider is registered for
	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	// Insert in priority order (highest first)
	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

// =============================================================================
// Loading API
// =============================================================================

/**
 * Async loading logic shared by loadCapability().
 */
async function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean }> = [];
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];
	const disabledExtensionIds = options.includeDisabled
		? new Set<string>()
		: new Set<string>(options.disabledExtensions ?? settings?.get("disabledExtensions") ?? []);

	const results = await Promise.all(
		providers.map(async provider => {
			try {
				const result = await logger.time(
					`capability:${capability.id}:${provider.id}`,
					provider.load.bind(provider),
					ctx,
				);
				return { provider, result };
			} catch (error) {
				logger.debug(`capability:${capability.id}:${provider.id}:error`);
				return { provider, error };
			}
		}),
	);

	for (const entry of results) {
		const { provider } = entry;
		if ("error" in entry) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${entry.error}`);
			continue;
		}

		const result = entry.result;
		if (!result) continue;

		if (result.warnings) {
			allWarnings.push(...result.warnings.map(w => `[${provider.displayName}] ${w}`));
		}

		let contributedItemCount = 0;
		for (const item of result.items) {
			const itemWithSource = item as T & { _source: SourceMeta };
			if (!itemWithSource._source) {
				allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
				continue;
			}

			const extensionId = capability.toExtensionId?.(itemWithSource);
			if (extensionId && disabledExtensionIds.has(extensionId)) {
				continue;
			}

			itemWithSource._source.providerName = provider.displayName;
			allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
			contributedItemCount += 1;
		}

		if (contributedItemCount > 0) {
			contributingProviders.push(provider.id);
		}
	}

	// Deduplicate by key (first wins = highest priority)
	const seen = new Map<string, number>();
	const deduped: Array<T & { _source: SourceMeta }> = [];

	for (let i = 0; i < allItems.length; i++) {
		const item = allItems[i];
		const key = capability.key(item);

		if (key === undefined) {
			deduped.push(item);
		} else if (!seen.has(key)) {
			seen.set(key, i);
			deduped.push(item);
		} else {
			item._shadowed = true;
		}
	}

	// Validate items (only non-shadowed items)
	if (capability.validate && !options.includeInvalid) {
		for (let i = deduped.length - 1; i >= 0; i--) {
			const error = capability.validate(deduped[i]);
			if (error) {
				const source = deduped[i]._source;
				allWarnings.push(
					`[${source?.providerName ?? "unknown"}] Invalid item at ${source?.path ?? "unknown"}: ${error}`,
				);
				deduped.splice(i, 1);
			}
		}
	}

	return {
		items: deduped,
		all: allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 */
function filterProviders<T>(capability: Capability<T>, options: LoadOptions): Provider<T>[] {
	// isProviderEnabled folds in BOTH the explicit disabled set and the
	// foreign-config gate (FOREIGN_PROVIDER_IDS follow discovery.importForeignConfig).
	// The gate guards AMBIENT collection only: an explicit `options.providers`
	// allowlist names its sources deliberately, so it bypasses the foreign gate
	// (but never the user's explicit disabledProviders set).
	if (options.providers) {
		const allowed = new Set(options.providers);
		let providers = (capability.providers as Provider<T>[]).filter(
			p => allowed.has(p.id) && !disabledProviders.has(p.id),
		);
		if (options.excludeProviders) {
			const excluded = new Set(options.excludeProviders);
			providers = providers.filter(p => !excluded.has(p.id));
		}
		return providers;
	}

	let providers = (capability.providers as Provider<T>[]).filter(p => isProviderEnabled(p.id));
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter(p => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 */
export async function loadCapability<T>(capabilityId: string, options: LoadOptions = {}): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? getProjectDir();
	const home = options.home ?? os.homedir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = { cwd, home, repoRoot };
	const providers = filterProviders(capability, options);

	return await loadImpl(capability, providers, ctx, options);
}

// =============================================================================
// Provider Enable/Disable API
// =============================================================================

/**
 * Initialize capability system with settings manager for persistence.
 * Call this once on startup to enable persistent provider state.
 */
export function initializeWithSettings(activeSettings: Settings): void {
	settings = activeSettings;
	// Load disabled providers from settings.
	const disabled = settings.get("disabledProviders");
	disabledProviders.clear();
	for (const id of disabled) {
		disabledProviders.add(id);
	}
	// Foreign-config auto-import: on by default (schema), opt-out via settings.
	importForeignConfig = settings.get("discovery.importForeignConfig") === true;
}

/**
 * Persist current disabled providers to settings.
 */
function persistDisabledProviders(): void {
	if (settings) {
		settings.set("disabledProviders", Array.from(disabledProviders));
	}
}

/**
 * Disable a provider globally (across all capabilities).
 */
export function disableProvider(providerId: string): void {
	disabledProviders.add(providerId);
	persistDisabledProviders();
}

/**
 * Enable a previously disabled provider.
 */
export function enableProvider(providerId: string): void {
	disabledProviders.delete(providerId);
	persistDisabledProviders();
}

/**
 * Check if a provider is enabled.
 */
export function isProviderEnabled(providerId: string): boolean {
	// Foreign-tool config providers are off unless the user opts in.
	if (!importForeignConfig && FOREIGN_PROVIDER_IDS.has(providerId)) return false;
	return !disabledProviders.has(providerId);
}

/** Whether foreign-tool config auto-import is currently enabled. */
export function isForeignConfigImportEnabled(): boolean {
	return importForeignConfig;
}

/** The provider IDs gated behind `discovery.importForeignConfig`. */
export function getForeignProviderIds(): string[] {
	return Array.from(FOREIGN_PROVIDER_IDS);
}

/**
 * Get list of all disabled provider IDs.
 */
export function getDisabledProviders(): string[] {
	return Array.from(disabledProviders);
}

/**
 * Set disabled providers from a list (replaces current set).
 */
export function setDisabledProviders(providerIds: string[]): void {
	disabledProviders.clear();
	for (const id of providerIds) {
		disabledProviders.add(id);
	}
	persistDisabledProviders();
}

// =============================================================================
// Introspection API
// =============================================================================

/**
 * Get a capability definition (for introspection).
 */
export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

/**
 * List all registered capability IDs.
 */
export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

/**
 * Get capability info for UI display.
 */
export function getCapabilityInfo(capabilityId: string): CapabilityInfo | undefined {
	const capability = capabilities.get(capabilityId);
	if (!capability) return undefined;

	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: isProviderEnabled(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display.
 */
export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id)!);
}

/**
 * Get provider info for UI display.
 */
export function getProviderInfo(providerId: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;

	// Find priority from first capability's provider list
	let priority = 0;
	for (const capId of caps) {
		const cap = capabilities.get(capId);
		const provider = cap?.providers.find(p => p.id === providerId);
		if (provider) {
			priority = provider.priority;
			break;
		}
	}

	return {
		id: providerId,
		displayName: meta.displayName,
		description: meta.description,
		priority,
		capabilities: Array.from(caps),
		enabled: isProviderEnabled(providerId),
	};
}

/**
 * Get all providers info for UI display (deduplicated across capabilities).
 */
export function getAllProvidersInfo(): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId);
		if (info) {
			providers.push(info);
		}
	}

	// Sort by priority (highest first)
	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Reset all caches. Call after chdir or filesystem changes.
 */
export function reset(): void {
	clearFsCache();
}

/**
 * Invalidate cache for a specific path.
 * @param filePath - Absolute or relative path to invalidate
 */
export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

// =============================================================================
// Test Seam
// =============================================================================

/**
 * Opaque snapshot of the module-level registry state. Produced by
 * {@link captureRegistryForTests} and consumed by {@link restoreRegistryForTests}.
 * The fields are captured by deep copy so a test can mutate the live registry and
 * later restore it byte-identical.
 */
export interface RegistrySnapshot {
	/** capability id -> a copy of that capability's providers array at capture time. */
	readonly capabilityProviders: ReadonlyMap<string, readonly Provider<unknown>[]>;
	readonly providerCapabilities: ReadonlyMap<string, ReadonlySet<string>>;
	readonly providerMeta: ReadonlyMap<string, { displayName: string; description: string }>;
	readonly disabledProviders: ReadonlySet<string>;
	readonly importForeignConfig: boolean;
	readonly settings: Settings | null;
}

/**
 * Capture the entire module-level registry state so a test can restore it later.
 *
 * The registry keeps all state in module-level Maps/Sets that production code
 * registers into at import time; there is no per-test instance. A hermetic test
 * captures first, mutates freely (define capabilities, register providers, toggle
 * disabled/foreign/settings), then restores — leaving the production-registered
 * capabilities untouched for every other suite. Capability objects are restored by
 * IDENTITY (only their `providers` array is reset in place) because other modules
 * hold references to them.
 */
export function captureRegistryForTests(): RegistrySnapshot {
	return {
		capabilityProviders: new Map(Array.from(capabilities, ([id, cap]) => [id, [...cap.providers]])),
		providerCapabilities: new Map(Array.from(providerCapabilities, ([id, set]) => [id, new Set(set)])),
		providerMeta: new Map(Array.from(providerMeta, ([id, meta]) => [id, { ...meta }])),
		disabledProviders: new Set(disabledProviders),
		importForeignConfig,
		settings,
	};
}

/**
 * Restore the registry to a previously captured snapshot. Capabilities defined
 * after the snapshot are removed; surviving capabilities keep their object
 * identity with their `providers` array reset to the captured contents. All other
 * module-level state (provider indexes, disabled set, foreign flag, settings) is
 * replaced wholesale.
 */
export function restoreRegistryForTests(snapshot: RegistrySnapshot): void {
	for (const id of Array.from(capabilities.keys())) {
		const captured = snapshot.capabilityProviders.get(id);
		if (!captured) {
			capabilities.delete(id);
			continue;
		}
		const providers = capabilities.get(id)!.providers as Provider<unknown>[];
		providers.length = 0;
		providers.push(...captured);
	}

	providerCapabilities.clear();
	for (const [id, set] of snapshot.providerCapabilities) providerCapabilities.set(id, new Set(set));

	providerMeta.clear();
	for (const [id, meta] of snapshot.providerMeta) providerMeta.set(id, { ...meta });

	disabledProviders.clear();
	for (const id of snapshot.disabledProviders) disabledProviders.add(id);

	importForeignConfig = snapshot.importForeignConfig;
	settings = snapshot.settings;
}

// =============================================================================
// Re-exports
// =============================================================================

export type * from "./types";
