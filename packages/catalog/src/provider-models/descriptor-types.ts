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
	readonly publishesOwnModelLimits?: boolean;
	readonly catalogDiscovery?: CatalogDiscoveryConfig;
	readonly specialModelManager?: boolean;
}
