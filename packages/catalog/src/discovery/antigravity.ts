import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { type } from "arktype";
import type { ModelSpec } from "../types";
import { discoveryFetch, toPositiveNumber } from "../utils";
import {
	ANTIGRAVITY_VARIANT_COLLAPSE_TABLE,
	collapseEffortVariants,
	type VariantCollapseTable,
} from "../variant-collapse";
import { getAntigravityUserAgent } from "../wire/gemini-headers";
import { AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW, AGENT_GATEWAY_DEFAULT_MAX_TOKENS } from "./default-limits";
import type { DiscoveryFailure, DiscoveryHooks } from "./failure";

// Re-exported, not redeclared: `@veyyon/catalog/provider-endpoints` owns the hosts, and this module's
// existing importers keep the names they already use.
export { ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT } from "../provider-endpoints";

import { ANTIGRAVITY_ENDPOINTS } from "../provider-endpoints";

const DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS = ANTIGRAVITY_ENDPOINTS;
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";

const ANTIGRAVITY_DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310", "gemini-2.5-pro"]);

/**
 * Raw model metadata returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiModel {
	displayName?: string;
	supportsImages?: boolean;
	supportsThinking?: boolean;
	thinkingBudget?: number;
	recommended?: boolean;
	maxTokens?: number;
	maxOutputTokens?: number;
	model?: string;
	apiProvider?: string;
	modelProvider?: string;
	isInternal?: boolean;
	supportsVideo?: boolean;
}

/**
 * Grouping metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelGroup {
	modelIds?: string[];
}

/**
 * Sort/group metadata used by Antigravity to surface recommended model ids.
 */
export interface AntigravityDiscoveryAgentModelSort {
	groups?: AntigravityDiscoveryAgentModelGroup[];
}

/**
 * Response payload returned by Antigravity's `fetchAvailableModels` endpoint.
 */
export interface AntigravityDiscoveryApiResponse {
	models?: Record<string, AntigravityDiscoveryApiModel>;
	agentModelSorts?: AntigravityDiscoveryAgentModelSort[];
}
const AntigravityDiscoveryApiModelSchema = type({
	"displayName?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"supportsImages?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"supportsThinking?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"thinkingBudget?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"recommended?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"maxTokens?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"maxOutputTokens?": type("unknown").pipe(value =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined,
	),
	"model?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"apiProvider?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"modelProvider?": type("unknown").pipe(value => (typeof value === "string" ? value : undefined)),
	"isInternal?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
	"supportsVideo?": type("unknown").pipe(value => (typeof value === "boolean" ? value : undefined)),
});

const AntigravityDiscoveryAgentModelGroupSchema = type({
	"modelIds?": type("unknown").pipe(value =>
		Array.isArray(value) ? value.filter((modelId): modelId is string => typeof modelId === "string") : undefined,
	),
});

const AntigravityDiscoveryAgentModelSortSchema = type({
	"groups?": type("unknown").pipe(value => {
		if (!Array.isArray(value)) return undefined;
		const result: AntigravityDiscoveryAgentModelGroup[] = [];
		for (const group of value) {
			const parsedGroup = AntigravityDiscoveryAgentModelGroupSchema(group);
			if (!(parsedGroup instanceof type.errors)) {
				result.push(parsedGroup);
			}
		}
		return result;
	}),
});

const AntigravityDiscoveryApiResponseSchema = type({
	"models?": type("unknown").pipe(value => {
		if (typeof value !== "object" || value === null) {
			return undefined;
		}
		const normalized: Record<string, AntigravityDiscoveryApiModel> = {};
		for (const [modelId, modelValue] of Object.entries(value)) {
			if (typeof modelValue !== "object" || modelValue === null) {
				continue;
			}
			const parsedModel = AntigravityDiscoveryApiModelSchema(modelValue);
			if (!(parsedModel instanceof type.errors)) {
				normalized[modelId] = parsedModel;
			}
		}
		return normalized;
	}),
	"agentModelSorts?": type("unknown").pipe(value => {
		if (!Array.isArray(value)) {
			return undefined;
		}
		const result: AntigravityDiscoveryAgentModelSort[] = [];
		for (const sort of value) {
			const parsedSort = AntigravityDiscoveryAgentModelSortSchema(sort);
			if (!(parsedSort instanceof type.errors)) {
				result.push(parsedSort);
			}
		}
		return result;
	}),
});
/**
 * Options for fetching Antigravity discovery models.
 */
export interface FetchAntigravityDiscoveryModelsOptions {
	/** OAuth access token used as `Authorization: Bearer <token>`. */
	token: string;
	/** Optional endpoint override. Defaults to Antigravity fallback endpoints. */
	endpoint?: string;
	/** Deprecated and ignored for antigravity discovery parity. */
	project?: string;
	/** Optional user agent override. */
	userAgent?: string;
	/** Optional abort signal for request cancellation. */
	signal?: AbortSignal;
	/** Optional fetch implementation override for tests. */
	fetcher?: typeof fetch;
	/**
	 * Hand collapse table to apply to the discovered list. Defaults to the
	 * Antigravity (budget-transport) table; `googleGeminiCli` passes the
	 * level-transport table so cloudcode-pa keeps `thinkingLevel`.
	 */
	collapseTable?: VariantCollapseTable;
	/**
	 * Called with the reason each endpoint attempt produced nothing.
	 *
	 * The same channel every reader in this package uses. This reader walks a LIST of fallback endpoints and
	 * `continue`d past every kind of failure, so a token the service rejects looked identical to a list of
	 * endpoints that have all moved -- and the final answer was a bare `null` naming none of them. Every
	 * attempt reports, because "all three endpoints answered 401" and "all three refused the connection"
	 * are different problems. Never called on success, including a success with no models.
	 */
	onFailure?: DiscoveryHooks["onFailure"];
}

/**
 * Fetches discoverable Antigravity models and normalizes them into canonical model entries.
 *
 * Returns `null` on network/payload/auth failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchAntigravityDiscoveryModels(
	options: FetchAntigravityDiscoveryModelsOptions,
): Promise<ModelSpec<"google-gemini-cli">[] | null> {
	const fetcher = discoveryFetch(options.fetcher);
	const endpoints = options.endpoint
		? [trimTrailingSlashes(options.endpoint)]
		: DEFAULT_ANTIGRAVITY_DISCOVERY_ENDPOINTS.map(trimTrailingSlashes);

	for (const endpoint of endpoints) {
		const url = `${endpoint}${FETCH_AVAILABLE_MODELS_PATH}`;
		const report = (stage: DiscoveryFailure["stage"], detail: string): void =>
			options.onFailure?.({ stage, url, detail });
		let response: Response;
		try {
			response = await fetcher(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.token}`,
					"Content-Type": "application/json",
					"User-Agent": options.userAgent ?? getAntigravityUserAgent(),
				},
				body: JSON.stringify({}),
				signal: options.signal,
			});
		} catch (error) {
			// `continue` tries the next fallback endpoint, which is right; what was wrong is that the attempt
			// left no trace, so an operator whose whole endpoint list is unreachable saw only an empty picker.
			report("request", errorMessage(error));
			continue;
		}

		if (!response.ok) {
			report("status", `HTTP ${response.status} ${response.statusText}`.trim());
			continue;
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			report("body", `response is not JSON: ${errorMessage(error)}`);
			continue;
		}

		const parsed = parseAntigravityDiscoveryResponse(payload);
		if (!parsed) {
			report("payload", "response holds no model map this reader recognizes");
			continue;
		}

		const models: ModelSpec<"google-gemini-cli">[] = [];

		for (const [modelId, model] of Object.entries(parsed.models ?? {})) {
			if (ANTIGRAVITY_DISCOVERY_DENYLIST.has(modelId)) {
				continue;
			}
			if (model.isInternal === true) {
				continue;
			}

			const supportsImages = model.supportsImages === true;
			models.push({
				id: modelId,
				name: model.displayName || modelId,
				api: "google-gemini-cli",
				provider: "google-antigravity",
				baseUrl: endpoint,
				reasoning: model.supportsThinking === true,
				input: supportsImages ? ["text", "image"] : ["text"],
				// This endpoint publishes no pricing, so the zeros mean "not told", not "free".
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				pricing: "unknown",
				contextWindow: toPositiveNumber(model.maxTokens, AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW),
				maxTokens: toPositiveNumber(model.maxOutputTokens, AGENT_GATEWAY_DEFAULT_MAX_TOKENS),
			});
		}

		// Collapse effort-tier variants at the source so runtime discovery,
		// the gemini-cli re-provision, and the catalog generator all see
		// logical ids only.
		const collapsed = collapseEffortVariants(models, options.collapseTable ?? ANTIGRAVITY_VARIANT_COLLAPSE_TABLE);
		collapsed.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		return collapsed;
	}

	return null;
}

function parseAntigravityDiscoveryResponse(value: unknown): AntigravityDiscoveryApiResponse | null {
	const parsed = AntigravityDiscoveryApiResponseSchema(value);
	if (parsed instanceof type.errors) {
		return null;
	}
	return parsed;
}
