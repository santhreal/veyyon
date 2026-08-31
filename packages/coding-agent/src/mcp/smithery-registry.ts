import { clampLow, logger } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { type ProviderTextTransformResolver, resolveProviderTextTransform } from "../provider-boundary";
import { isTimeoutError } from "../utils/fetch-timeout";
import { smitheryTimeoutSignal } from "./smithery-http";
import type { MCPServerConfig } from "./types";

const SMITHERY_REGISTRY_BASE_URL = "https://registry.smithery.ai";

type SmitherySearchEntry = {
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

type SmitheryConnection = {
	type?: "http" | "stdio";
	deploymentUrl?: string;
	configSchema?: SmitheryConfigSchema;
};

type SmitheryConfigSchema = {
	type?: string;
	required?: string[];
	properties?: Record<string, SmitheryConfigProperty>;
};

type SmitheryConfigProperty = {
	type?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
	format?: string;
};

type SmitheryServerDetails = {
	qualifiedName?: string;
	displayName?: string;
	description?: string;
	remote?: boolean;
	deploymentUrl?: string;
	connections?: SmitheryConnection[];
	security?: unknown;
	tools?: unknown;
};

type SmitheryToolDefinition = {
	name?: string;
	description?: string;
	inputSchema?: {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
	};
};

type RegistryInputType = "string" | "number" | "boolean";

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

export class SmitheryRegistryError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "SmitheryRegistryError";
		this.status = status;
	}
}

async function parseRegistryObject(response: Response, request: string): Promise<Record<string, unknown>> {
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new SmitheryRegistryError(
			`The Smithery registry answered the ${request} with a body that is not JSON. Fix: this is a registry-side fault, not a bad query. Retry in a moment, and if it persists add the server by hand with \`/mcp add <name> url <url>\` instead of searching for it.`,
			502,
		);
	}
	if (!isRecord(payload)) {
		throw new SmitheryRegistryError(
			`The Smithery registry answered the ${request} with JSON that is not an object, so it cannot be read. Fix: this is a registry-side fault, not a bad query. Retry in a moment, and if it persists add the server by hand with \`/mcp add <name> url <url>\`.`,
			502,
		);
	}
	return payload;
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function isSearchEntry(value: unknown): value is SmitherySearchEntry {
	if (!isRecord(value)) return false;
	const entry = value;
	return (
		isOptionalString(entry.id) &&
		isOptionalString(entry.qualifiedName) &&
		isOptionalString(entry.namespace) &&
		isOptionalString(entry.slug) &&
		isOptionalString(entry.displayName) &&
		isOptionalString(entry.description) &&
		isOptionalString(entry.homepage) &&
		isOptionalString(entry.createdAt) &&
		isOptionalString(entry.owner) &&
		isOptionalString(entry.iconUrl) &&
		isOptionalBoolean(entry.remote) &&
		isOptionalBoolean(entry.verified) &&
		isOptionalBoolean(entry.isDeployed) &&
		(entry.score === undefined || (typeof entry.score === "number" && Number.isFinite(entry.score))) &&
		(entry.useCount === undefined || (typeof entry.useCount === "number" && Number.isFinite(entry.useCount)))
	);
}

function isServerDetails(value: unknown): value is SmitheryServerDetails {
	if (!isRecord(value)) return false;
	const details = value;
	if (
		!isOptionalString(details.qualifiedName) ||
		!isOptionalString(details.displayName) ||
		!isOptionalString(details.description) ||
		!isOptionalString(details.deploymentUrl) ||
		!isOptionalBoolean(details.remote)
	) {
		return false;
	}
	if (details.connections === undefined) return true;
	if (!Array.isArray(details.connections)) return false;
	return details.connections.every(connection => {
		if (!isRecord(connection)) return false;
		const candidate = connection;
		return (
			(candidate.type === undefined || candidate.type === "http" || candidate.type === "stdio") &&
			isOptionalString(candidate.deploymentUrl)
		);
	});
}

function clampRegistryLimit(limit: number | undefined): number {
	// 0/undefined/NaN mean "unspecified" here, so they fall back to the page-size
	// default (20) rather than clamping to the low bound; a real value is truncated
	// and clamped into [1, 100] via the shared clampLow owner.
	if (!limit || Number.isNaN(limit)) return 20;
	return clampLow(Math.trunc(limit), 1, 100);
}

function matchesIdentityQuery(query: string, entry: SmitherySearchEntry): boolean {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return true;
	const displayName = entry.displayName?.toLowerCase() ?? "";
	const qualifiedName = entry.qualifiedName?.toLowerCase() ?? "";
	return displayName.includes(normalizedQuery) || qualifiedName.includes(normalizedQuery);
}

function resolveDetailPathCandidates(entry: SmitherySearchEntry): string[] {
	const candidates: string[] = [];
	const pushUnique = (value: string | undefined): void => {
		if (!value) return;
		if (!candidates.includes(value)) candidates.push(value);
	};

	if (entry.namespace && entry.slug) {
		pushUnique(`${entry.namespace}/${entry.slug}`);
	}
	if (entry.slug) {
		pushUnique(entry.slug);
	}
	const qualifiedName = entry.qualifiedName?.trim();
	if (qualifiedName) {
		pushUnique(qualifiedName.replace(/^@/, ""));
	}
	return candidates;
}

function getEntryIdentityKey(entry: SmitherySearchEntry): string | null {
	const candidates = resolveDetailPathCandidates(entry);
	if (candidates.length > 0) {
		return candidates[0] ?? null;
	}
	if (entry.id) return `id:${entry.id}`;
	return null;
}

function toConfigNameFromQualifiedName(qualifiedName: string): string {
	const normalized = qualifiedName
		.toLowerCase()
		.replace(/^@/, "")
		.replace(/\//g, "-")
		.replace(/[^a-z0-9_.-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized.length > 0 ? normalized : "mcp-server";
}

function normalizeQualifiedName(value: string): string {
	return value.startsWith("@") ? value : `@${value}`;
}

function scalarToString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function unknownToString(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		// A value with a cycle in it has no string form, and this only renders registry metadata for
		// display. Undefined means the field is not shown, the same as a field that was absent.
		return undefined;
	}
}

function safeMetadataValue(value: unknown): string | undefined {
	const raw = unknownToString(value);
	if (!raw) return undefined;
	const normalized = raw
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function toDateLabel(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString().slice(0, 10);
}

function getToolsList(tools: unknown): SmitherySearchResult["display"]["tools"] {
	if (!Array.isArray(tools)) return [];
	const output: SmitherySearchResult["display"]["tools"] = [];
	for (const item of tools) {
		if (!isRecord(item)) continue;
		const tool = item as SmitheryToolDefinition;
		const name = safeMetadataValue(tool.name);
		if (!name) continue;
		const description = safeMetadataValue(tool.description);
		const params = tool.inputSchema?.properties ? Object.keys(tool.inputSchema.properties) : [];
		output.push({
			name,
			description,
			params,
		});
	}
	return output;
}

function getInputType(propertyType: string | undefined): RegistryInputType {
	if (propertyType === "number" || propertyType === "integer") return "number";
	if (propertyType === "boolean") return "boolean";
	return "string";
}

function isSensitiveInput(key: string, format: string | undefined): boolean {
	if (format?.toLowerCase() === "password") return true;
	return /(api[_-]?key|token|secret|password)/i.test(key);
}

function getSchemaInputs(schema: SmitheryConfigSchema | undefined): SmitherySearchResult["requiredInputs"] {
	const required = new Set(schema?.required ?? []);
	const properties = schema?.properties ?? {};
	const inputs: SmitherySearchResult["requiredInputs"] = [];

	for (const [key, property] of Object.entries(properties)) {
		const type = getInputType(property.type);
		const enumValues = Array.isArray(property.enum)
			? property.enum.map(scalarToString).filter((value): value is string => Boolean(value))
			: undefined;
		inputs.push({
			key,
			label: key.replace(/[_-]+/g, " "),
			type,
			required: required.has(key),
			defaultValue: scalarToString(property.default),
			description: property.description,
			enumValues: enumValues && enumValues.length > 0 ? enumValues : undefined,
			sensitive: isSensitiveInput(key, property.format),
		});
	}

	return inputs;
}

function chooseConnection(
	details: SmitheryServerDetails,
): { connection: SmitheryConnection; useDirectHttp: boolean } | null {
	const connections = details.connections ?? [];
	const httpConnection = connections.find(connection => connection.type === "http" && !!connection.deploymentUrl);
	if (httpConnection) {
		const hasConfigInputs = getSchemaInputs(httpConnection.configSchema).length > 0;
		if (!hasConfigInputs) {
			return { connection: httpConnection, useDirectHttp: true };
		}
	}

	const stdioConnection = connections.find(connection => connection.type === "stdio");
	if (stdioConnection) {
		return { connection: stdioConnection, useDirectHttp: false };
	}

	if (httpConnection) {
		return { connection: httpConnection, useDirectHttp: false };
	}

	return null;
}

function createConfig(
	qualifiedName: string,
	selected: { connection: SmitheryConnection; useDirectHttp: boolean },
): MCPServerConfig | null {
	if (selected.useDirectHttp && selected.connection.type === "http" && selected.connection.deploymentUrl) {
		return {
			type: "http",
			url: selected.connection.deploymentUrl,
		};
	}

	return {
		type: "stdio",
		command: "bunx",
		args: ["-y", "@smithery/cli", "run", normalizeQualifiedName(qualifiedName), "--config", "{}"],
	};
}

async function fetchServerDetails(
	path: string,
	options?: { apiKey?: string; signal?: AbortSignal },
): Promise<SmitheryServerDetails | null> {
	options?.signal?.throwIfAborted();
	const headers = new Headers();
	if (options?.apiKey) {
		headers.set("Authorization", `Bearer ${options.apiKey}`);
	}
	const encodedPath = path
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
	const response = await fetch(`${SMITHERY_REGISTRY_BASE_URL}/servers/${encodedPath}`, {
		headers,
		signal: smitheryTimeoutSignal(options?.signal),
	});
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new SmitheryRegistryError(
			`The Smithery registry refused the details request for "${path}" with HTTP ${response.status}. Fix: ${
				response.status === 401 || response.status === 403
					? "the registry rejected the API key. Run `/mcp smithery-login` to obtain a new one, or set `SMITHERY_API_KEY` in the environment."
					: response.status === 429
						? "the registry is rate limiting. Wait and search again."
						: "retry in a moment; if it persists, add the server by hand with `/mcp add <name> url <url>`."
			}`,
			response.status,
		);
	}
	const details = await parseRegistryObject(response, "detail request");
	if (!isServerDetails(details)) {
		throw new SmitheryRegistryError(
			`The Smithery registry returned an entry for "${path}" that is missing the fields needed to configure a server. Fix: this listing is unusable as it stands. Open it on smithery.ai and add the server by hand with \`/mcp add <name> url <url>\`.`,
			502,
		);
	}
	return details;
}

async function fetchServerDetailsFromEntry(
	entry: SmitherySearchEntry,
	options?: { apiKey?: string; signal?: AbortSignal },
): Promise<SmitheryServerDetails | null> {
	const candidates = resolveDetailPathCandidates(entry);
	options?.signal?.throwIfAborted();
	for (const candidate of candidates) {
		const details = await fetchServerDetails(candidate, options);
		if (details) return details;
	}
	return null;
}

function toSearchResult(entry: SmitherySearchEntry, details: SmitheryServerDetails): SmitherySearchResult | null {
	if (!entry.id) return null;
	const qualifiedName = normalizeQualifiedName(
		details.qualifiedName ?? entry.qualifiedName ?? `${entry.namespace}/${entry.slug}`,
	);
	const selected = chooseConnection(details);
	if (!selected) return null;

	const config = createConfig(qualifiedName, selected);
	if (!config) return null;

	const requiredInputs = getSchemaInputs(selected.connection.configSchema);
	const warnings: string[] = [];
	if (config.type === "stdio") {
		warnings.push("Runs through Smithery CLI at runtime (`bunx @smithery/cli run ...`).");
	}
	if (requiredInputs.length > 0) {
		warnings.push("Provider requires configuration input defined by Smithery schema.");
	}
	const displayName = safeMetadataValue(details.displayName ?? entry.displayName) ?? qualifiedName.replace(/^@/, "");
	const description = safeMetadataValue(details.description ?? entry.description) ?? "No description";
	const connectionType = safeMetadataValue(selected.connection.type) ?? "unknown";
	const transport = safeMetadataValue(config.type ?? "stdio") ?? "stdio";
	const createdAt = toDateLabel(entry.createdAt);
	const homepage = safeMetadataValue(entry.homepage);
	const tools = getToolsList(details.tools);

	return {
		id: entry.id,
		name: qualifiedName.replace(/^@/, ""),
		title: details.displayName ?? entry.displayName,
		description: details.description ?? entry.description,
		score: entry.score,
		useCount: entry.useCount,
		display: {
			displayName,
			description,
			useCount: entry.useCount ?? 0,
			verified: entry.verified === true,
			deployed: entry.isDeployed === true,
			transport,
			connectionType,
			createdAt,
			homepage,
			tools,
		},
		sourceType: selected.useDirectHttp || details.remote ? "remote" : "package",
		config,
		requiredInputs,
		warnings,
	};
}

export async function searchSmitheryRegistry(
	keyword: string,
	options?: SmitherySearchOptions,
): Promise<SmitherySearchResult[]> {
	options?.signal?.throwIfAborted();
	const query = keyword.trim();
	if (!query) return [];

	const limit = clampRegistryLimit(options?.limit);
	const isSemantic = options?.includeSemantic === true;
	// Two pages worth of headroom for the filter below, held inside the API's [20, 100] page bound.
	const pageSize = clampLow(limit * 2, 20, 100);
	const headers = new Headers();
	if (options?.apiKey) {
		headers.set("Authorization", `Bearer ${options.apiKey}`);
	}

	// Fetch pages until we have enough filtered entries or run out of results.
	const maxPages = 3;
	const allEntries: SmitherySearchEntry[] = [];
	for (let page = 1; page <= maxPages; page++) {
		options?.signal?.throwIfAborted();
		const transform = resolveProviderTextTransform(options?.resolveProviderTextTransform, "Smithery registry search");
		const outboundQuery = transform(query);
		const url = new URL(`${SMITHERY_REGISTRY_BASE_URL}/servers`);
		url.searchParams.set("q", outboundQuery);
		url.searchParams.set("pageSize", String(pageSize));
		if (page > 1) url.searchParams.set("page", String(page));
		let response: Response;
		try {
			response = await fetch(url.toString(), {
				headers,
				signal: smitheryTimeoutSignal(options?.signal),
			});
		} catch (err) {
			options?.signal?.throwIfAborted();
			if (isTimeoutError(err)) {
				throw new SmitheryRegistryError(
					`The Smithery registry did not answer this search within 10s. Fix: check that smithery.ai is reachable from this network, then search again. To skip the registry entirely, add the server by hand with \`/mcp add <name> url <url>\`.`,
					0,
				);
			}
			throw err;
		}
		if (!response.ok) {
			throw new SmitheryRegistryError(
				`The Smithery registry refused this search with HTTP ${response.status}. Fix: ${
					response.status === 401 || response.status === 403
						? "the registry rejected the API key. Run `/mcp smithery-login` to obtain a new one, or set `SMITHERY_API_KEY` in the environment."
						: response.status === 429
							? "the registry is rate limiting. Wait and search again."
							: "retry in a moment; if it persists, add the server by hand with `/mcp add <name> url <url>`."
				}`,
				response.status,
			);
		}
		const payload = await parseRegistryObject(response, "search");
		const servers = payload.servers;
		if (servers !== undefined && !Array.isArray(servers)) {
			throw new SmitheryRegistryError(
				`The Smithery registry returned a search result whose "servers" field is not a list, so it cannot be read. Fix: this is a registry-side fault, not a bad query. Retry in a moment, and if it persists add the server by hand with \`/mcp add <name> url <url>\`.`,
				502,
			);
		}
		const pageEntries = servers ?? [];
		if (!pageEntries.every(isSearchEntry)) {
			throw new SmitheryRegistryError(
				`The Smithery registry returned search entries that are missing the fields a listing needs, so this page cannot be shown. Fix: this is a registry-side fault, not a bad query. Retry in a moment, and if it persists add the server by hand with \`/mcp add <name> url <url>\`.`,
				502,
			);
		}
		if (pageEntries.length === 0) break;
		allEntries.push(...pageEntries);

		// Stop early if we already have enough identity-matching entries.
		const filtered = isSemantic ? allEntries : allEntries.filter(entry => matchesIdentityQuery(query, entry));
		if (filtered.length >= limit * 2) break;
		if (pageEntries.length < pageSize) break;
	}

	const entries = isSemantic ? [...allEntries] : [...allEntries].filter(entry => matchesIdentityQuery(query, entry));

	// Only apply local useCount sort when not in semantic mode (preserve API relevance ranking).
	if (!isSemantic) {
		entries.sort((a, b) => (b.useCount ?? 0) - (a.useCount ?? 0));
	}

	const uniqueEntries = entries.filter((entry, index) => {
		const identity = getEntryIdentityKey(entry);
		if (!identity) return false;
		return (
			entries.findIndex(candidate => {
				const candidateIdentity = getEntryIdentityKey(candidate);
				return candidateIdentity === identity;
			}) === index
		);
	});

	let detailFailures = 0;
	let firstDetailFailure: unknown;
	const results: SmitherySearchResult[] = [];
	const detailConcurrency = 8;
	let nextEntry = 0;
	while (nextEntry < uniqueEntries.length && results.length < limit) {
		options?.signal?.throwIfAborted();
		const batchSize = Math.min(detailConcurrency, limit - results.length, uniqueEntries.length - nextEntry);
		const batch = uniqueEntries.slice(nextEntry, nextEntry + batchSize);
		nextEntry += batchSize;
		const batchResults = await Promise.all(
			batch.map(async entry => {
				try {
					const details = await fetchServerDetailsFromEntry(entry, {
						apiKey: options?.apiKey,
						signal: options?.signal,
					});
					if (!details) return null;
					return toSearchResult(entry, details);
				} catch (error) {
					options?.signal?.throwIfAborted();
					detailFailures++;
					firstDetailFailure ??= error;
					return null;
				}
			}),
		);
		for (const result of batchResults) {
			if (result) results.push(result);
		}
	}

	if (results.length === 0 && firstDetailFailure !== undefined) {
		throw firstDetailFailure;
	}
	if (detailFailures > 0) {
		logger.warn("Smithery detail fetch failed for some entries", {
			failedEntries: detailFailures,
			totalEntries: uniqueEntries.length,
		});
	}
	return results;
}

export function toConfigName(candidate: string): string {
	return toConfigNameFromQualifiedName(candidate);
}
