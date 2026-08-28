import * as os from "node:os";
import type { AuthStorage, FetchImpl, Model, OAuthAccess } from "@veyyon/ai";
import { withOAuthAccess } from "@veyyon/ai/auth-retry";
import {
	applyCodexResponsesLiteShape,
	resolveCodexResponsesLite,
} from "@veyyon/ai/providers/openai-codex/request-transformer";
import { createOpenAICodexCompatibilityMetadata } from "@veyyon/ai/providers/openai-codex-responses";
import { getBundledModels } from "@veyyon/catalog/models";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@veyyon/catalog/wire/codex";
import { $env, readSseJson } from "@veyyon/utils";
import packageJson from "../../../../package.json" with { type: "json" };
import {
	type ProviderTextTransformResolver,
	resolveProviderTextTransform,
	transformProviderPayload,
} from "../../../provider-boundary";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { applyResultLimit } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const CODEX_RESPONSES_PATH = "/codex/responses";
const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_MODEL_PREFERENCES = [
	"gpt-5.6-luna",
	"gpt-5.6-terra",
	"gpt-5.6-sol",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5-codex",
	"gpt-5",
	"gpt-5.3-codex",
	"gpt-5.2-codex",
	"gpt-5.1-codex",
	"gpt-5-codex-mini",
];
const DEFAULT_INSTRUCTIONS =
	"You are a helpful assistant with web search capabilities. Search the web to answer the user's question accurately and cite your sources.";

type CodexSearchModel = Model<"openai-codex-responses">;

interface CodexModelCandidate {
	modelId: string;
	catalogModel?: CodexSearchModel;
}

function getBundledCodexModels(): CodexSearchModel[] {
	const models: CodexSearchModel[] = [];
	for (const model of getBundledModels("openai-codex")) {
		if (model.api === "openai-codex-responses") {
			models.push(model as CodexSearchModel);
		}
	}
	return models;
}

function getConfiguredModel(): CodexModelCandidate | undefined {
	const configuredModel = $env.VEYYON_CODEX_WEB_SEARCH_MODEL?.trim();
	if (!configuredModel) return undefined;

	const catalogModel = getBundledCodexModels().find(model => model.id === configuredModel);
	return { modelId: configuredModel, ...(catalogModel ? { catalogModel } : {}) };
}

function getDefaultModelCandidates(): CodexModelCandidate[] {
	const bundledModels = getBundledCodexModels();
	const candidates: CodexModelCandidate[] = [];
	for (const modelId of DEFAULT_MODEL_PREFERENCES) {
		const catalogModel = bundledModels.find(model => model.id === modelId);
		if (catalogModel) candidates.push({ modelId, catalogModel });
	}

	if (candidates.length > 0) {
		return candidates;
	}

	const nonMini = bundledModels.find(model => !model.id.includes("mini") && !model.id.includes("spark"));
	if (nonMini) {
		return [{ modelId: nonMini.id, catalogModel: nonMini }];
	}

	const fallbackModel = bundledModels[0];
	return fallbackModel ? [{ modelId: fallbackModel.id, catalogModel: fallbackModel }] : [{ modelId: FALLBACK_MODEL }];
}

function shouldRetryWithNextDefaultModel(error: unknown): boolean {
	if (!(error instanceof SearchProviderError)) return false;
	if (error.provider !== "codex" || error.status !== 400) return false;
	return /model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
		error.message,
	);
}

export interface CodexSearchParams {
	signal?: AbortSignal;
	fetch?: FetchImpl;
	query: string;
	system_prompt?: string;
	num_results?: number;
	search_context_size?: "low" | "medium" | "high";
	resolveProviderTextTransform?: ProviderTextTransformResolver;
}

interface CodexResponseItem {
	type: string;
	id?: string;
	role?: string;
	name?: string;
	call_id?: string;
	status?: string;
	arguments?: string;
	content?: CodexContentPart[];
	summary?: Array<{ type: string; text: string }>;
}

interface CodexContentPart {
	type: string;
	text?: string;
	annotations?: CodexAnnotation[];
}

interface CodexAnnotation {
	type: string;
	url?: string;
	title?: string;
	start_index?: number;
	end_index?: number;
}

interface CodexUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
}

interface CodexResponse {
	id?: string;
	model?: string;
	status?: string;
	usage?: CodexUsage;
}

const IMAGE_PLACEHOLDER_ANSWERS: ReadonlySet<string> = new Set([
	"see attached image",
	"attached image",
	"see the attached image",
	"see image",
	"see image above",
	"image above",
	"see image below",
	"image below",
]);

function isImagePlaceholderAnswer(text: string): boolean {
	const normalized = text
		.trim()
		.replace(/^[[("'`*_]+/, "")
		.replace(/[\])"'`*_.!?]+$/, "")
		.trim()
		.toLowerCase();
	return IMAGE_PLACEHOLDER_ANSWERS.has(normalized);
}

function addSource(sources: SearchSource[], source: SearchSource): void {
	if (!sources.some(existing => existing.url === source.url)) {
		sources.push(source);
	}
}

function countCharacter(text: string, target: string): number {
	let count = 0;
	for (const char of text) {
		if (char === target) {
			count += 1;
		}
	}
	return count;
}

function normalizeExtractedUrl(candidate: string): string | null {
	let url = candidate.trim();

	while (url.length > 0) {
		const lastCharacter = url.at(-1);
		if (!lastCharacter) break;
		if (/[.,!?;:'"]/u.test(lastCharacter)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === ")" && countCharacter(url, ")") > countCharacter(url, "(")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "]" && countCharacter(url, "]") > countCharacter(url, "[")) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastCharacter === "}" && countCharacter(url, "}") > countCharacter(url, "{")) {
			url = url.slice(0, -1);
			continue;
		}
		break;
	}

	if (!/^https?:\/\//.test(url)) {
		return null;
	}

	try {
		return new URL(url).toString();
	} catch {
		return null;
	}
}

function findMarkdownLinkUrlEnd(text: string, openParenIndex: number): number | null {
	let depth = 0;

	for (let index = openParenIndex; index < text.length; index += 1) {
		const character = text[index];
		if (!character || character === "\n") {
			return null;
		}
		if (character === "(") {
			depth += 1;
			continue;
		}
		if (character !== ")") {
			continue;
		}
		depth -= 1;
		if (depth === 0) {
			return index;
		}
		if (depth < 0) {
			return null;
		}
	}

	return null;
}

function extractTextSources(text: string): SearchSource[] {
	const sources: SearchSource[] = [];

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] !== "[") {
			continue;
		}
		const titleEnd = text.indexOf("]", index + 1);
		if (titleEnd === -1 || text[titleEnd + 1] !== "(") {
			continue;
		}
		const urlEnd = findMarkdownLinkUrlEnd(text, titleEnd + 1);
		if (urlEnd === null) {
			continue;
		}
		const title = text.slice(index + 1, titleEnd).trim();
		const url = normalizeExtractedUrl(text.slice(titleEnd + 2, urlEnd));
		if (url) {
			addSource(sources, { title: title || url, url });
		}
		index = urlEnd;
	}

	for (const match of text.matchAll(/https?:\/\/\S+/g)) {
		const url = normalizeExtractedUrl(match[0] ?? "");
		if (!url) continue;
		addSource(sources, { title: url, url });
	}

	return sources;
}

function getAccountIdFromJwt(accessToken: string): string | null {
	return getCodexAccountId(accessToken) ?? null;
}

async function findCodexAuth(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<{ access: OAuthAccess; accountId: string } | null> {
	const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });
	if (!access) return null;
	const accountId = access.accountId ?? getAccountIdFromJwt(access.accessToken);
	if (!accountId) return null;
	return { access, accountId };
}

function buildCodexHeaders(accessToken: string, accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		[OPENAI_HEADERS.ACCOUNT_ID]: accountId,
		[OPENAI_HEADERS.BETA]: OPENAI_HEADER_VALUES.BETA_RESPONSES,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		"User-Agent": `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`,
		Accept: "text/event-stream",
		"Content-Type": "application/json",
	};
}

async function callCodexSearch(
	auth: { accessToken: string; accountId: string },
	query: string,
	options: {
		signal?: AbortSignal;
		systemPrompt?: string;
		searchContextSize?: "low" | "medium" | "high";
		model: CodexModelCandidate;
		sessionId?: string;
		fetch?: FetchImpl;
		resolveProviderTextTransform?: ProviderTextTransformResolver;
	},
): Promise<{
	answer: string;
	sources: SearchSource[];
	model: string;
	requestId: string;
	usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}> {
	const url = `${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
	const headers = buildCodexHeaders(auth.accessToken, auth.accountId);

	const requestedModel = options.model.modelId;
	const candidateModel = options.model.catalogModel ?? {
		id: requestedModel,
		api: "openai-codex-responses" as const,
		provider: "openai-codex" as const,
	};
	const usesResponsesLite = resolveCodexResponsesLite(candidateModel, undefined);

	const body: Record<string, unknown> = {
		model: requestedModel,
		stream: true,
		store: false,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: query }],
			},
		],
		tools: [
			{
				type: "web_search",
				search_context_size: options.searchContextSize ?? "high",
			},
		],
		tool_choice: { type: "web_search" },
		instructions: options.systemPrompt ?? DEFAULT_INSTRUCTIONS,
	};
	if (usesResponsesLite) {
		const metadata = createOpenAICodexCompatibilityMetadata({
			sessionId: options.sessionId,
			requestKind: "turn",
			startNewTurn: true,
		});
		Object.assign(headers, metadata.headers);
		headers[OPENAI_HEADERS.RESPONSES_LITE] = "true";
		body.client_metadata = metadata.clientMetadata;
		body.reasoning = { context: "all_turns" };
		applyCodexResponsesLiteShape(body);
	}

	const fetchImpl = options.fetch ?? fetch;
	return withHardTimeout(options.signal, async hardSignal => {
		const transform = resolveProviderTextTransform(options.resolveProviderTextTransform, "Codex search request");
		const requestBody = transformProviderPayload(body, transform, "Codex search request");
		const response = await fetchImpl(url, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
			signal: hardSignal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			const classified = classifyProviderHttpError("codex", response.status, errorText);
			if (classified) throw classified;
			const message =
				/model is not supported|requested model is not supported|not supported when using codex with a chatgpt account/i.test(
					errorText,
				)
					? "codex: requested model is not supported"
					: `Codex API error (${response.status}).`;
			throw new SearchProviderError("codex", message, response.status);
		}

		if (!response.body) {
			throw new SearchProviderError("codex", "Codex API returned no response body", 500);
		}

		const answerParts: string[] = [];
		const streamedAnswerParts: string[] = [];
		const sources: SearchSource[] = [];
		let model = requestedModel;
		let requestId = "";
		let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

		for await (const rawEvent of readSseJson<Record<string, unknown>>(response.body, options.signal)) {
			const eventType = typeof rawEvent.type === "string" ? rawEvent.type : "";
			if (!eventType) continue;

			if (eventType === "response.output_text.delta") {
				const delta = typeof rawEvent.delta === "string" ? rawEvent.delta : "";
				if (delta) {
					streamedAnswerParts.push(delta);
				}
			} else if (eventType === "response.output_item.done") {
				const item = rawEvent.item as CodexResponseItem | undefined;
				if (!item) continue;

				if (item.type === "message" && item.content) {
					for (const part of item.content) {
						if (part.type === "output_text" && part.text) {
							answerParts.push(part.text);

							if (part.annotations) {
								for (const annotation of part.annotations) {
									if (annotation.type === "url_citation" && annotation.url) {
										addSource(sources, { title: annotation.title ?? annotation.url, url: annotation.url });
									}
								}
							}
						}
					}
				}

				if (item.type === "reasoning" && item.summary) {
					for (const part of item.summary) {
						if (part.type === "summary_text" && part.text) {
							answerParts.push(part.text);
						}
					}
				}
			} else if (eventType === "response.completed" || eventType === "response.done") {
				const resp = (rawEvent as { response?: CodexResponse }).response;
				if (resp) {
					if (resp.model) model = resp.model;
					if (resp.id) requestId = resp.id;
					if (resp.usage) {
						const cachedTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0;
						usage = {
							inputTokens: (resp.usage.input_tokens ?? 0) - cachedTokens,
							outputTokens: resp.usage.output_tokens ?? 0,
							totalTokens: resp.usage.total_tokens ?? 0,
						};
					}
				}
			} else if (eventType === "error") {
				const code = (rawEvent as { code?: string }).code ?? "";
				const message = (rawEvent as { message?: string }).message ?? "Unknown error";
				throw new SearchProviderError("codex", `Codex error (${code}): ${message}`, 500);
			} else if (eventType === "response.failed") {
				const resp = (rawEvent as { response?: { error?: { message?: string } } }).response;
				const errorMessage = resp?.error?.message ?? "Request failed";
				throw new SearchProviderError("codex", `Codex request failed: ${errorMessage}`, 500);
			}
		}

		const finalAnswer = answerParts.join("\n\n").trim();
		const streamedAnswer = streamedAnswerParts.join("").trim();
		const finalIsPlaceholder = finalAnswer.length > 0 && isImagePlaceholderAnswer(finalAnswer);
		const streamedIsPlaceholder = streamedAnswer.length > 0 && isImagePlaceholderAnswer(streamedAnswer);
		const hasFinalText = finalAnswer.length > 0 && !finalIsPlaceholder;
		const hasStreamedText = streamedAnswer.length > 0 && !streamedIsPlaceholder;
		if (!hasFinalText && !hasStreamedText && sources.length === 0) {
			throw new SearchProviderError("codex", "Codex returned image-only response", 502);
		}
		const answer = hasFinalText ? finalAnswer : hasStreamedText ? streamedAnswer : "";

		if (sources.length === 0 && answer.length > 0) {
			for (const source of extractTextSources(answer)) {
				addSource(sources, source);
			}
		}

		return {
			answer,
			sources,
			model,
			requestId,
			usage,
		};
	});
}

export async function searchCodex(params: SearchParams): Promise<SearchResponse> {
	const seed = await findCodexAuth(params.authStorage, params.sessionId, params.signal);
	if (!seed) {
		throw new Error(
			"No Codex OAuth credentials found. Login with 'veyyon /login openai-codex' to enable Codex web search.",
		);
	}

	const configuredModel = getConfiguredModel();
	const modelCandidates = configuredModel ? [configuredModel] : getDefaultModelCandidates();

	const result = await withOAuthAccess(
		params.authStorage,
		"openai-codex",
		async access => {
			const accountId = access.accountId ?? getAccountIdFromJwt(access.accessToken);
			if (!accountId) {
				throw new Error("Codex OAuth credential is missing a ChatGPT account id");
			}
			const auth = { accessToken: access.accessToken, accountId };

			let lastError: unknown;
			for (let index = 0; index < modelCandidates.length; index += 1) {
				const candidate = modelCandidates[index];
				if (!candidate) continue;

				try {
					return await callCodexSearch(auth, params.query, {
						signal: params.signal,
						systemPrompt: params.systemPrompt,
						searchContextSize: "high",
						model: candidate,
						sessionId: params.sessionId,
						fetch: params.fetch,
						resolveProviderTextTransform: params.resolveProviderTextTransform,
					});
				} catch (error) {
					lastError = error;
					const isLastCandidate = index === modelCandidates.length - 1;
					if (configuredModel || isLastCandidate || !shouldRetryWithNextDefaultModel(error)) {
						throw error;
					}
				}
			}
			throw lastError ?? new Error("Codex search failed without returning a result");
		},
		{ sessionId: params.sessionId, signal: params.signal, seed: seed.access },
	);

	const sources = applyResultLimit(result.sources, params.numSearchResults ?? params.limit);

	return {
		provider: "codex",
		answer: result.answer || undefined,
		sources,
		usage: result.usage
			? {
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
				}
			: undefined,
		model: result.model,
		requestId: result.requestId,
	};
}

export async function hasCodexSearch(authStorage: AuthStorage): Promise<boolean> {
	return authStorage.hasOAuth("openai-codex");
}

export class CodexProvider extends SearchProvider {
	readonly id = "codex";
	readonly label = "OpenAI";

	isAvailable(authStorage: AuthStorage): Promise<boolean> | boolean {
		return hasCodexSearch(authStorage);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchCodex(params);
	}
}
