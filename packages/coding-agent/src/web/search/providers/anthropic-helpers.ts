import {
	type AnthropicAuthConfig,
	type AnthropicSystemBlock,
	type ApiKey,
	buildAnthropicAuthConfig,
	buildAnthropicSearchHeaders,
	buildAnthropicSystemBlocks,
	buildAnthropicUrl,
	type FetchImpl,
	resolveAnthropicMetadataUserId,
	stripClaudeToolPrefix,
	withAuth,
	wrapFetchForCch,
} from "@veyyon/ai";
import { ANTHROPIC_WEB_SEARCH_TOOL } from "@veyyon/catalog/wire/anthropic";
import { $env } from "@veyyon/utils/env";
import {
	type ProviderTextTransformResolver,
	resolveProviderTextTransform,
	transformProviderPayload,
} from "../../../provider-boundary";
import type {
	AnthropicApiResponse,
	AnthropicCitation,
	SearchCitation,
	SearchResponse,
	SearchSource,
} from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { applyResultLimit } from "../utils";
import type { SearchParams } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_MAX_TOKENS = 4096;
export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
export interface AnthropicSearchParams {
	query: string;
	system_prompt?: string;
	num_results?: number;
	max_tokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	resolveProviderTextTransform?: ProviderTextTransformResolver;
}

export function getModel(): string {
	return $env.ANTHROPIC_SEARCH_MODEL ?? DEFAULT_MODEL;
}

function buildSystemBlocks(
	auth: AnthropicAuthConfig,
	model: string,
	systemPrompt?: string,
): AnthropicSystemBlock[] | undefined {
	const includeClaudeCode = auth.isOAuth && !model.startsWith("claude-3-5-haiku");
	const extraInstructions = auth.isOAuth ? ["You are a helpful AI assistant with web search capabilities."] : [];

	return buildAnthropicSystemBlocks(systemPrompt ? [systemPrompt] : undefined, {
		includeClaudeCodeInstruction: includeClaudeCode,
		extraInstructions,
		cacheControl: { type: "ephemeral" },
	});
}

async function callSearch(
	auth: AnthropicAuthConfig,
	model: string,
	query: string,
	metadataUserId?: string,
	systemPrompt?: string,
	maxTokens?: number,
	temperature?: number,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
	resolveTextTransform?: ProviderTextTransformResolver,
): Promise<AnthropicApiResponse> {
	const url = buildAnthropicUrl(auth);
	const headers = buildAnthropicSearchHeaders(auth);

	const systemBlocks = buildSystemBlocks(auth, model, systemPrompt);

	const body: Record<string, unknown> = {
		model,
		max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
		messages: [{ role: "user", content: query }],
		tools: [
			{
				type: WEB_SEARCH_TOOL_TYPE,
				name: ANTHROPIC_WEB_SEARCH_TOOL,
			},
		],
	};

	if (metadataUserId) {
		body.metadata = { user_id: metadataUserId };
	}

	if (temperature !== undefined) {
		body.temperature = temperature;
	}

	if (systemBlocks && systemBlocks.length > 0) {
		body.system = systemBlocks;
	}

	const doFetch = auth.isOAuth ? wrapFetchForCch(fetchImpl) : fetchImpl;
	return withHardTimeout(signal, async hardSignal => {
		const transform = resolveProviderTextTransform(resolveTextTransform, "Anthropic search request");
		const requestBody = transformProviderPayload(body, transform, "Anthropic search request");
		const response = await doFetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: hardSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("anthropic", response.status, errorText);
			if (classified) throw classified;
			throw new SearchProviderError("anthropic", `Anthropic API error (${response.status}).`, response.status);
		}

		return response.json() as Promise<AnthropicApiResponse>;
	});
}

function parsePageAge(pageAge: string | null | undefined): number | undefined {
	if (!pageAge) return undefined;

	const match = pageAge.match(/^(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day|w|week|mo|month|y|year)s?\s*(ago)?$/i);
	if (!match) return undefined;

	const value = parseInt(match[1], 10);
	const unit = match[2].toLowerCase();

	const multipliers: Record<string, number> = {
		s: 1,
		sec: 1,
		second: 1,
		m: 60,
		min: 60,
		minute: 60,
		h: 3600,
		hour: 3600,
		d: 86400,
		day: 86400,
		w: 604800,
		week: 604800,
		mo: 2592000,
		month: 2592000,
		y: 31536000,
		year: 31536000,
	};

	return value * (multipliers[unit] ?? 86400);
}

export function parseResponse(response: AnthropicApiResponse): SearchResponse {
	const answerParts: string[] = [];
	const searchQueries: string[] = [];
	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];

	for (const block of response.content) {
		if (
			block.type === "server_tool_use" &&
			block.name &&
			stripClaudeToolPrefix(block.name) === ANTHROPIC_WEB_SEARCH_TOOL
		) {
			if (block.input?.query) {
				searchQueries.push(block.input.query);
			}
		} else if (block.type === "web_search_tool_result" && block.content) {
			for (const result of block.content) {
				if (result.type === "web_search_result") {
					sources.push({
						title: result.title,
						url: result.url,
						snippet: undefined,
						publishedDate: result.page_age ?? undefined,
						ageSeconds: parsePageAge(result.page_age),
					});
				}
			}
		} else if (block.type === "text" && block.text) {
			answerParts.push(block.text);
			if (block.citations) {
				for (const c of block.citations as AnthropicCitation[]) {
					citations.push({
						url: c.url,
						title: c.title,
						citedText: c.cited_text,
					});
				}
			}
		}
	}

	return {
		provider: "anthropic",
		answer: answerParts.join("\n\n") || undefined,
		sources,
		citations: citations.length > 0 ? citations : undefined,
		searchQueries: searchQueries.length > 0 ? searchQueries : undefined,
		usage: {
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
			searchRequests: response.usage.server_tool_use?.web_search_requests,
		},
		model: response.model,
		requestId: response.id,
	};
}

export async function searchAnthropic(
	params: SearchParams | AnthropicSearchParams,
	_legacyStorage?: unknown,
): Promise<SearchResponse> {
	const searchApiKey = $env.ANTHROPIC_SEARCH_API_KEY;
	const searchBaseUrl = $env.ANTHROPIC_SEARCH_BASE_URL;
	const keyOrResolver: ApiKey | undefined = searchApiKey
		? searchApiKey
		: "authStorage" in params
			? params.authStorage.resolver("anthropic", { sessionId: params.sessionId })
			: undefined;

	if (!keyOrResolver) {
		throw new Error(
			"No Anthropic credentials found. Set ANTHROPIC_SEARCH_API_KEY or ANTHROPIC_API_KEY, or configure Anthropic OAuth.",
		);
	}

	const model = getModel();
	const systemPrompt = "authStorage" in params ? params.systemPrompt : params.system_prompt;
	const maxTokens = "authStorage" in params ? params.maxOutputTokens : params.max_tokens;
	const callerSessionId = "authStorage" in params ? params.sessionId : undefined;
	const accountId =
		"authStorage" in params ? params.authStorage.getOAuthAccountId("anthropic", params.sessionId) : undefined;
	const response = await withAuth(
		keyOrResolver,
		key => {
			const auth = buildAnthropicAuthConfig(key, searchBaseUrl);
			const metadataUserId = resolveAnthropicMetadataUserId(
				callerSessionId,
				auth.isOAuth,
				callerSessionId,
				accountId,
			);
			return callSearch(
				auth,
				model,
				params.query,
				metadataUserId,
				systemPrompt,
				maxTokens,
				params.temperature,
				params.signal,
				params.fetch,
				params.resolveProviderTextTransform,
			);
		},
		{
			signal: params.signal,
			missingKeyMessage:
				"No Anthropic credentials found. Set ANTHROPIC_SEARCH_API_KEY or ANTHROPIC_API_KEY, or configure Anthropic OAuth.",
		},
	);

	const result = parseResponse(response);

	result.sources = applyResultLimit(
		result.sources,
		"authStorage" in params ? (params.numSearchResults ?? params.limit) : params.num_results,
	);

	return result;
}
