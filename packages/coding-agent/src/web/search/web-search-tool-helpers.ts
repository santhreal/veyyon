import type { AuthStorage } from "@veyyon/ai";
import { formatCount, truncate } from "@veyyon/utils";
import { type } from "arktype";
import { settings } from "../../config/settings-instance";
import { toolsPrompts } from "../../prompts/tools/rows";
import type { ProviderTextTransformResolver } from "../../provider-boundary";
import { formatAge } from "../../tools/render-utils";
import { throwIfAborted } from "../../tools/tool-errors";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getSearchProvider,
	getSearchProviderLabel,
	type SearchProvider,
	selectSearchProviders,
} from "./provider";
import type { SearchRenderDetails } from "./render";
import type { SearchProviderId, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

export async function discoverAuthStorage(): Promise<AuthStorage> {
	const { discoverAuthStorage: discover } = await import("../../session/auth-broker-config");

	return discover();
}

export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

function formatForLLM(response: SearchResponse): string {
	const parts: string[] = [];

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) {
			parts.push(`    ${truncate(src.snippet, 240)}`);
		}
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) {
				parts.push(`    ${truncate(citation.citedText, 240)}`);
			}
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const q of response.relatedQuestions) {
			parts.push(`- ${q}`);
		}
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) {
			parts.push(`- ${truncate(query, 120)}`);
		}
	}

	return parts.join("\n");
}

export function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	return false;
}

export interface ExecuteSearchOptions {
	authStorage: AuthStorage;
	sessionId?: string;
	signal?: AbortSignal;
	resolveProviderTextTransform?: ProviderTextTransformResolver;
}

export async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const { authStorage, sessionId, signal, resolveProviderTextTransform } = options;
	const selection = selectSearchProviders(params.provider);
	if ("refusal" in selection) {
		return {
			content: [{ type: "text" as const, text: `Error: ${selection.refusal}` }],
			details: { response: { provider: "none", sources: [] }, error: selection.refusal },
		};
	}
	const candidates = selection.candidates;

	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
	} catch {
		antigravityEndpointMode = undefined;
	}

	let geminiModel: string | undefined;
	try {
		geminiModel = settings.get("providers.webSearchGeminiModel");
	} catch {
		geminiModel = undefined;
	}

	const failures: Array<{ provider: Pick<SearchProvider, "id" | "label">; error: unknown }> = [];
	let availableProviderCount = 0;
	let lastProvider: Pick<SearchProvider, "id" | "label"> | undefined;
	for (const candidate of candidates) {
		let provider: SearchProvider | undefined;
		const providerMeta = { id: candidate.id, label: getSearchProviderLabel(candidate.id) };
		lastProvider = providerMeta;
		try {
			provider = await getSearchProvider(candidate.id);
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(authStorage)
				: await provider.isAvailable(authStorage);
			if (!available) continue;
			availableProviderCount++;
			lastProvider = provider;

			const response = await provider.search({
				query: params.query,
				limit: params.limit,
				recency: params.recency,
				systemPrompt: toolsPrompts["tools/web-search-system"].text,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal,
				authStorage,
				sessionId,
				antigravityEndpointMode,
				geminiModel,
				resolveProviderTextTransform,
			});

			if (!hasRenderableSearchContent(response)) {
				throw new SearchProviderError(provider.id, `${provider.label} found no results for this query.`, 204);
			}

			const text = formatForLLM(response);

			return {
				content: [{ type: "text" as const, text }],
				details: { response },
			};
		} catch (error) {
			throwIfAborted(signal);
			failures.push({ provider: provider ?? providerMeta, error });
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const chosen = candidates.length === 1 && candidates[0]?.explicit ? candidates[0].id : undefined;
		const message =
			chosen === undefined
				? "No web search provider configured."
				: `${getSearchProviderLabel(chosen)} is the chosen web search provider and is not configured. ` +
					`Add its credential, or set providers.webSearch to auto.`;
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			details: { response: { provider: chosen ?? "none", sources: [] }, error: message },
		};
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: {
			response: { provider: lastFailure?.provider.id ?? lastProvider?.id ?? "none", sources: [] },
			error: message,
		},
	};
}

export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		sessionId?: string;
		signal?: AbortSignal;
		resolveProviderTextTransform?: ProviderTextTransformResolver;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const createdAuthStorage = options.authStorage ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			sessionId: options.sessionId,
			signal: options.signal,
			resolveProviderTextTransform: options.resolveProviderTextTransform,
		});
	} finally {
		createdAuthStorage?.close();
	}
}
