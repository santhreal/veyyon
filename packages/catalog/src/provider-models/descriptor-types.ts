import type { ModelManagerOptions } from "../model-manager";
import type { Api, FetchImpl } from "../types";

export type ModelManagerConfig = { apiKey?: string; baseUrl?: string; fetch?: FetchImpl };

export interface CatalogDiscoveryConfig {
	label: string;
	envVars?: readonly string[];
	oauthProvider?: string;
	allowUnauthenticated?: boolean;
}

export interface ProviderDescriptor {
	providerId: string;
	createModelManagerOptions(config: ModelManagerConfig): ModelManagerOptions<Api>;
	defaultModel: string;
	allowUnauthenticated?: boolean;
	dynamicModelsAuthoritative?: boolean;
	catalogDiscovery?: CatalogDiscoveryConfig;
}

export type CatalogProviderDescriptor = ProviderDescriptor & { catalogDiscovery: CatalogDiscoveryConfig };

export function isCatalogDescriptor(d: ProviderDescriptor): d is CatalogProviderDescriptor {
	return d.catalogDiscovery != null;
}

export function allowsUnauthenticatedCatalogDiscovery(descriptor: CatalogProviderDescriptor): boolean {
	return descriptor.catalogDiscovery.allowUnauthenticated ?? descriptor.allowUnauthenticated ?? false;
}

export interface ProviderCatalogEntry {
	readonly id: string;
	readonly defaultModel: string;
	readonly envVars?: readonly string[];
	readonly createModelManagerOptions?: (config: ModelManagerConfig) => ModelManagerOptions<Api>;
	readonly allowUnauthenticated?: boolean;
	readonly dynamicModelsAuthoritative?: boolean;
	/**
	 * When true, the provider's own endpoint is the sole authority for context
	 * windows and output caps: generation leaves an unpublished limit null
	 * instead of backfilling it from another host's same-family model.
	 */
	readonly publishesOwnModelLimits?: boolean;
	/** Catalog discovery configuration for generate-models.ts. */
	readonly catalogDiscovery?: CatalogDiscoveryConfig;
	/**
	 * Built bespoke by the coding-agent runtime (OAuth-token-driven managers);
	 * excluded from `PROVIDER_DESCRIPTORS` even though models are discoverable.
	 */
	readonly specialModelManager?: boolean;
}
