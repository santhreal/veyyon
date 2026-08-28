import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getProjectDir } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";

import type { Settings } from "../config/settings";
import { settingsOrNull } from "../config/settings-instance";
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

const capabilities = new Map<string, Capability<unknown>>();

const providerCapabilities = new Map<string, Set<string>>();

const providerMeta = new Map<string, { displayName: string; description: string }>();

const disabledProviders = new Set<string>();

export const FOREIGN_PROVIDER_IDS: ReadonlySet<string> = new Set([
	"agents",
	"agents-md",
	"claude",
	"claude-plugins",
	"codex",
	"cursor",
	"gemini",
	"github",
	"opencode",
	"windsurf",
]);

let importForeignConfig = false;

let settings: Settings | null = null;

export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

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
		: new Set<string>(options.disabledExtensions ?? settingsOrNull()?.get("disabledExtensions") ?? []);

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
			const mapped = result.warnings.map(w => `[${provider.displayName}] ${w}`);
			for (let wi = 0; wi < mapped.length; wi++) allWarnings.push(mapped[wi]!);
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

function filterProviders<T>(capability: Capability<T>, options: LoadOptions): Provider<T>[] {
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

export async function loadCapability<T>(capabilityId: string, options: LoadOptions = {}): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? getProjectDir();
	const home = options.home ?? os.homedir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = { cwd, home, repoRoot, agentDir: options.agentDir ?? getAgentDir() };
	const providers = filterProviders(capability, options);

	return await loadImpl(capability, providers, ctx, options);
}

export function initializeWithSettings(activeSettings: Settings): void {
	settings = activeSettings;
	const disabled = settings.get("disabledProviders");
	disabledProviders.clear();
	for (const id of disabled) {
		disabledProviders.add(id);
	}
	importForeignConfig = settings.get("discovery.importForeignConfig") === true;
}

function persistDisabledProviders(): void {
	if (settings) {
		settings.set("disabledProviders", Array.from(disabledProviders));
	}
}

export function disableProvider(providerId: string): void {
	disabledProviders.add(providerId);
	persistDisabledProviders();
}

export function enableProvider(providerId: string): void {
	disabledProviders.delete(providerId);
	persistDisabledProviders();
}

export function isProviderEnabled(providerId: string): boolean {
	if (!importForeignConfig && FOREIGN_PROVIDER_IDS.has(providerId)) return false;
	return !disabledProviders.has(providerId);
}

export function isForeignConfigImportEnabled(): boolean {
	return importForeignConfig;
}

export function getForeignProviderIds(): string[] {
	return Array.from(FOREIGN_PROVIDER_IDS);
}

export function getDisabledProviders(): string[] {
	return Array.from(disabledProviders);
}

export function setDisabledProviders(providerIds: string[]): void {
	disabledProviders.clear();
	for (const id of providerIds) {
		disabledProviders.add(id);
	}
	persistDisabledProviders();
}

export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

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

export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id)!);
}

export function getProviderInfo(providerId: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;

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

export function getAllProvidersInfo(): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId);
		if (info) {
			providers.push(info);
		}
	}

	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

export function reset(): void {
	clearFsCache();
}

export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

export interface RegistrySnapshot {
	readonly capabilityProviders: ReadonlyMap<string, readonly Provider<unknown>[]>;
	readonly providerCapabilities: ReadonlyMap<string, ReadonlySet<string>>;
	readonly providerMeta: ReadonlyMap<string, { displayName: string; description: string }>;
	readonly disabledProviders: ReadonlySet<string>;
	readonly importForeignConfig: boolean;
	readonly settings: Settings | null;
}

export function captureRegistryForTests(): RegistrySnapshot {
	return {
		capabilityProviders: new Map(Array.from(capabilities, ([id, cap]) => [id, cap.providers.slice()])),
		providerCapabilities: new Map(Array.from(providerCapabilities, ([id, set]) => [id, new Set(set)])),
		providerMeta: new Map(Array.from(providerMeta, ([id, meta]) => [id, { ...meta }])),
		disabledProviders: new Set(disabledProviders),
		importForeignConfig,
		settings,
	};
}

export function restoreRegistryForTests(snapshot: RegistrySnapshot): void {
	for (const id of Array.from(capabilities.keys())) {
		const captured = snapshot.capabilityProviders.get(id);
		if (!captured) {
			capabilities.delete(id);
			continue;
		}
		const providers = capabilities.get(id)!.providers as Provider<unknown>[];
		providers.length = 0;
		for (let pi = 0; pi < captured.length; pi++) providers.push(captured[pi]!);
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

export type * from "./types";
