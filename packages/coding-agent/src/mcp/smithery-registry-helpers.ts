import type { ProviderTextTransformResolver } from "../provider-boundary";
import type { MCPServerConfig } from "./types";

export const SMITHERY_REGISTRY_BASE_URL = "https://registry.smithery.ai";

export type SmitherySearchEntry = {
	id?: string;
	qualifiedName?: string;
	namespace?: string;
	slug?: string;
	displayName?: string;
	description?: string;
	remote?: boolean;
	score?: number;
	useCount?: number;
	homepage?: string;
	verified?: boolean;
	isDeployed?: boolean;
	createdAt?: string;
	owner?: string;
	iconUrl?: string;
};

export type SmitheryConnection = {
	type?: "http" | "stdio";
	deploymentUrl?: string;
	configSchema?: SmitheryConfigSchema;
};

export type SmitheryConfigSchema = {
	type?: string;
	required?: string[];
	properties?: Record<string, SmitheryConfigProperty>;
};

export type SmitheryConfigProperty = {
	type?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
	format?: string;
};

export type SmitheryServerDetails = {
	qualifiedName?: string;
	displayName?: string;
	description?: string;
	remote?: boolean;
	deploymentUrl?: string;
	connections?: SmitheryConnection[];
	security?: unknown;
	tools?: unknown;
};

export type SmitheryToolDefinition = {
	name?: string;
	description?: string;
	inputSchema?: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
};

export type RegistryInputType = "string" | "number" | "boolean";

export type SmitherySearchResult = {
	id: string;
	name: string;
	title?: string;
	description?: string;
	score?: number;
	useCount?: number;
	display: {
		displayName: string;
		description: string;
		useCount: number;
		verified: boolean;
		deployed: boolean;
		transport: string;
		connectionType: string;
		createdAt?: string;
		homepage?: string;
		tools: Array<{
			name: string;
			description?: string;
			params: string[];
		}>;
	};
	sourceType: "remote" | "package";
	config: MCPServerConfig;
	warnings: string[];
	requiredInputs: Array<{
		key: string;
		label: string;
		type: RegistryInputType;
		required: boolean;
		defaultValue?: string;
		description?: string;
		enumValues?: string[];
		sensitive: boolean;
	}>;
};

export interface SmitherySearchOptions {
	limit?: number;
	apiKey?: string;
	includeSemantic?: boolean;
	signal?: AbortSignal;
	resolveProviderTextTransform?: ProviderTextTransformResolver;
}
