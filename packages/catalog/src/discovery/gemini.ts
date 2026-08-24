import { errorMessage } from "@veyyon/utils/type-guards";
import { normalizeBaseUrl } from "@veyyon/utils/url";
import { getBundledModels } from "../models";
import { GEMINI_DEVELOPER_API_ENDPOINT } from "../provider-endpoints";
import { toModelSpec } from "../provider-models/bundled-references";
import type { FetchImpl, Model, ModelSpec } from "../types";
import { discoveryFetch, toArray, toFields, toFiniteNumber, toStringValue } from "../utils";
import type { DiscoveryFailure, DiscoveryHooks } from "./failure";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 25;

/**
 * One entry of Google's `models.list` page.
 *
 * Read field by field rather than through a schema library: every field here was already
 * declared as "unknown, coerced by hand", and reaching the library cost 362ms of module
 * evaluation on a launch path that touches this file through the provider descriptor table.
 */
interface GeminiModelListItem {
	name?: string | undefined;
	displayName?: string | undefined;
	supportedGenerationMethods?: string[] | undefined;
	inputTokenLimit?: number | undefined;
	outputTokenLimit?: number | undefined;
}

/**
 * An entry, or `undefined` for one this reader will not guess at.
 *
 * A name or a token limit of the wrong type is dropped and the rest of the entry kept, because
 * a model with no display name is still a usable model. A `supportedGenerationMethods` that is
 * not a list of strings drops the whole entry: that field decides whether the model can be
 * called at all, and a half-read answer would either hide a usable model or offer a broken one.
 */
function readModelListItem(value: unknown): GeminiModelListItem | undefined {
	const fields = toFields(value);
	if (!fields) {
		return undefined;
	}
	const methods = fields.supportedGenerationMethods;
	if (methods !== undefined && !(Array.isArray(methods) && methods.every(entry => typeof entry === "string"))) {
		return undefined;
	}
	return {
		name: toStringValue(fields.name),
		displayName: toStringValue(fields.displayName),
		supportedGenerationMethods: methods as string[] | undefined,
		inputTokenLimit: toFiniteNumber(fields.inputTokenLimit),
		outputTokenLimit: toFiniteNumber(fields.outputTokenLimit),
	};
}

interface GeminiModelListPage {
	models: GeminiModelListItem[];
	nextPageToken?: string | undefined;
}

/**
 * A page of the model list, or `undefined` when the response is not one.
 *
 * An absent `models` key is an empty page, which is a real answer from a project with no models
 * enabled. A `models` that is present and not a list is a response shape this reader does not
 * know, and is reported rather than read as "no models".
 */
function readModelListPage(payload: unknown): GeminiModelListPage | undefined {
	const fields = toFields(payload);
	if (!fields) {
		return undefined;
	}
	if (fields.models !== undefined && !Array.isArray(fields.models)) {
		return undefined;
	}
	const items: GeminiModelListItem[] = [];
	for (const entry of toArray(fields.models) ?? []) {
		const item = readModelListItem(entry);
		if (item) {
			items.push(item);
		}
	}
	return { models: items, nextPageToken: toStringValue(fields.nextPageToken) };
}
/**
 * Configuration for Google Generative AI model discovery.
 */
export interface GeminiDiscoveryOptions {
	/** API key for the Google Generative AI public endpoint. */
	apiKey: string;
	/** Optional endpoint override for testing or proxying. */
	baseUrl?: string;
	/** Optional requested page size for model listing. */
	pageSize?: number;
	/** Maximum number of pages to request before stopping pagination. */
	maxPages?: number;
	/** Optional abort signal for HTTP requests. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetch?: FetchImpl;
	/**
	 * Called with the reason when discovery returns `null`.
	 *
	 * The same channel every reader in this package uses. This reader PAGINATES, so a failure can happen on
	 * the fourth page after three good ones, and the page number is part of the reason: without it an
	 * operator cannot tell a rejected key (page 0) from a listing that broke partway through.
	 * Never called on success, including a success with no models.
	 */
	onFailure?: DiscoveryHooks["onFailure"];
}

/**
 * Fetches and normalizes Google Generative AI models from the public models endpoint.
 *
 * Returns `null` on transport/protocol failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchGeminiModels(
	options: GeminiDiscoveryOptions,
): Promise<ModelSpec<"google-generative-ai">[] | null> {
	const fetchImpl = discoveryFetch(options.fetch);
	const baseUrl = normalizeBaseUrl(options.baseUrl, GEMINI_DEVELOPER_API_ENDPOINT);
	if (!options.apiKey.trim()) {
		// Reported rather than silent, because an empty key is a configuration mistake the user can fix, and it
		// otherwise looks exactly like an endpoint that is down. The key itself is never in the reason.
		options.onFailure?.({ stage: "base-url", url: `${baseUrl}/models`, detail: "no API key is configured" });
		return null;
	}

	const pageSize = normalizePositiveInt(options.pageSize, DEFAULT_PAGE_SIZE);
	const maxPages = normalizePositiveInt(options.maxPages, DEFAULT_MAX_PAGES);

	const bundledById = new Map(
		getBundledModels("google").map(model => [model.id, toModelSpec(model as Model<"google-generative-ai">)]),
	);
	const modelsById = new Map<string, ModelSpec<"google-generative-ai">>();
	const seenTokens = new Set<string>();
	let nextPageToken: string | undefined;

	for (let page = 0; page < maxPages; page += 1) {
		const requestUrl = buildModelsUrl(baseUrl, options.apiKey, pageSize, nextPageToken);
		// The request URL carries the API key in its query string, so the REPORTED url is the keyless one.
		// A reason an operator cannot paste into a bug report is worth more than a reason that leaks a key.
		const reportedUrl = `${baseUrl}/models`;
		const report = (stage: DiscoveryFailure["stage"], detail: string): void =>
			options.onFailure?.({ stage, url: reportedUrl, detail: `page ${page}: ${detail}` });
		let response: Response;
		try {
			response = await fetchImpl(requestUrl, {
				method: "GET",
				signal: options.signal,
			});
		} catch (error) {
			// Null is 'no catalog', never `[]`, so the caller keeps the distinction between an unreachable endpoint
			// and one that lists no models, and now also has the reason.
			report("request", errorMessage(error));
			return null;
		}

		if (!response.ok) {
			report("status", `HTTP ${response.status} ${response.statusText}`.trim());
			return null;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			report("body", `response is not JSON: ${errorMessage(error)}`);
			return null;
		}

		const parsed = readModelListPage(payload);
		if (!parsed) {
			const shape = payload === null ? "null" : typeof payload;
			report("payload", `response holds no model list: the body is ${shape}, or its \`models\` field is not a list`);
			return null;
		}

		for (const item of parsed.models) {
			const model = normalizeModel(item, baseUrl, bundledById);
			if (model) {
				modelsById.set(model.id, model);
			}
		}

		const token = normalizePageToken(parsed.nextPageToken);
		if (!token) {
			break;
		}
		if (seenTokens.has(token)) {
			break;
		}
		seenTokens.add(token);
		nextPageToken = token;
	}

	return Array.from(modelsById.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function buildModelsUrl(baseUrl: string, apiKey: string, pageSize: number, pageToken?: string): URL {
	const url = new URL(`${baseUrl}/models`);
	url.searchParams.set("key", apiKey);
	url.searchParams.set("pageSize", String(pageSize));
	if (pageToken) {
		url.searchParams.set("pageToken", pageToken);
	}
	return url;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number;
function normalizePositiveInt(value: number | undefined, fallback: number | null): number | null;
function normalizePositiveInt(value: number | undefined, fallback: number | null): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : fallback;
}

function normalizePageToken(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const token = value.trim();
	return token.length > 0 ? token : undefined;
}

function normalizeModel(
	item: GeminiModelListItem,
	baseUrl: string,
	bundledById: Map<string, ModelSpec<"google-generative-ai">>,
): ModelSpec<"google-generative-ai"> | null {
	const id = normalizeModelId(item.name);
	if (!id) {
		return null;
	}
	if (!supportsTextGeneration(item.supportedGenerationMethods)) {
		return null;
	}

	const reference = bundledById.get(id);
	const contextWindow = normalizePositiveInt(item.inputTokenLimit, reference?.contextWindow ?? null);
	const maxTokens = normalizePositiveInt(item.outputTokenLimit, reference?.maxTokens ?? null);
	const name = normalizeModelName(item.displayName, reference?.name ?? id);

	if (reference) {
		return {
			...reference,
			id,
			name,
			baseUrl,
			contextWindow,
			maxTokens,
		};
	}
	return {
		id,
		name,
		api: "google-generative-ai",
		provider: "google",
		baseUrl,
		reasoning: inferReasoningFromGeminiId(id),
		input: inferInputFromGeminiId(id),
		// This endpoint publishes no pricing, so the zeros mean "not told", not "free".
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		pricing: "unknown",
		contextWindow,
		maxTokens,
	};
}

function normalizeModelId(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

function normalizeModelName(displayName: string | undefined, id: string): string {
	const trimmed = displayName?.trim();
	return trimmed ? trimmed : id;
}

function supportsTextGeneration(methods: string[] | undefined): boolean {
	if (!methods || methods.length === 0) {
		return false;
	}
	return methods.some(method => method === "generateContent");
}

function inferReasoningFromGeminiId(id: string): boolean {
	const normalized = id.toLowerCase();
	if (normalized.includes("thinking")) {
		return true;
	}
	if (normalized.includes("pro") || normalized.includes("2.5")) {
		return true;
	}
	return false;
}

function inferInputFromGeminiId(id: string): ("text" | "image")[] {
	const normalized = id.toLowerCase();
	if (normalized.includes("vision") || normalized.includes("image") || normalized.includes("gemini")) {
		return ["text", "image"];
	}
	return ["text"];
}
