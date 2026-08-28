export interface LoadContext {
	cwd: string;
	home: string;
	repoRoot: string | null;
	agentDir?: string;
}

export interface LoadResult<T> {
	items: T[];
	warnings?: string[];
}

export interface Provider<T> {
	id: string;

	displayName: string;

	description: string;

	priority: number;

	load(ctx: LoadContext): Promise<LoadResult<T>>;
}

export interface LoadOptions {
	providers?: string[];
	excludeProviders?: string[];
	cwd?: string;
	home?: string;
	agentDir?: string;
	includeInvalid?: boolean;
	includeDisabled?: boolean;
	disabledExtensions?: string[];
}

export interface SourceMeta {
	provider: string;
	providerName: string;
	path: string;
	level: "user" | "project" | "native";
}

export interface CapabilityResult<T> {
	items: Array<T & { _source: SourceMeta }>;
	all: Array<T & { _source: SourceMeta; _shadowed?: boolean }>;
	warnings: string[];
	providers: string[];
}

export interface Capability<T> {
	id: string;

	displayName: string;

	description: string;

	key(item: T): string | undefined;

	validate?(item: T): string | undefined;

	toExtensionId?(item: T): string | undefined;

	providers: Provider<T>[];
}

export interface CapabilityInfo {
	id: string;
	displayName: string;
	description: string;
	providers: Array<{
		id: string;
		displayName: string;
		description: string;
		priority: number;
		enabled: boolean;
	}>;
}

export interface ProviderInfo {
	id: string;
	displayName: string;
	description: string;
	priority: number;
	capabilities: string[];
	enabled: boolean;
}
