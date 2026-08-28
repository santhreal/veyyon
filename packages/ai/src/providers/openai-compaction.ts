import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { boundProviderErrorDetail, ProviderHttpError, readProviderErrorDetail } from "../error";
import type { Api, CodexCompactionRequestContext, FetchImpl, Message, Model, ProviderSessionState } from "../types";
import { applyCodexResponsesLiteShape, resolveCodexResponsesLite } from "./openai-codex/request-transformer";
import { createOpenAICodexDirectRequest } from "./openai-codex-responses";
import type { ResponseInput } from "./openai-responses-wire";
import { buildResponsesInput, parseAzureDeploymentNameMap, resolveOpenAIRequestSetup } from "./openai-shared";

export interface ServerCompactionTransport {
	compact(request: ServerCompactionRequest): Promise<ServerCompactionResult>;
}

export interface ServerCompactionRequest {
	model: Model<Api>;
	messages: Message[];
	previousWindow?: Array<Record<string, unknown>>;
	instructions?: string;
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	codexCompaction?: CodexCompactionRequestContext;
	apiKey: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	timeoutMs?: number;
	sanitizeErrorText?: (text: string) => string;
}

export interface ServerCompactionResult {
	window: Array<Record<string, unknown>>;
	usage?: { inputTokens?: number; outputTokens?: number };
}

export const SERVER_COMPACTION_WIRE_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

const routeAbsentForModel = new Set<string>();

export function resetServerCompactionRouteCache(): void {
	routeAbsentForModel.clear();
}

export function resolveServerCompactionTransport(model: Model<Api>): ServerCompactionTransport | undefined {
	if (!SERVER_COMPACTION_WIRE_APIS[model.api]) return undefined;
	const compat = model.compat as ResolvedOpenAIResponsesCompat;
	if (compat.supportsServerCompaction !== true) return undefined;
	if (routeAbsentForModel.has(`${model.provider}/${model.api}/${model.id}`)) return undefined;
	return openAIResponsesServerCompaction;
}

interface CompactedResponseWire {
	id?: string;
	object?: string;
	created_at?: number;
	output?: Array<Record<string, unknown>>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

function resolveOpenAiCompactRequest(
	model: Model<Api>,
	apiKey: string,
	messages: Message[],
): { url: string; headers: Record<string, string> } {
	const setup = resolveOpenAIRequestSetup(
		{ provider: model.provider, id: model.id, baseUrl: model.baseUrl, headers: model.headers },
		{ apiKey, messages },
	);
	const baseUrl = trimTrailingSlashes(setup.baseUrl ?? "https://api.openai.com/v1");
	return { url: `${baseUrl}/responses/compact`, headers: setup.headers };
}

function resolveAzureCompactRequest(
	model: Model<Api>,
	apiKey: string,
): { url: string; headers: Record<string, string> } {
	if (!apiKey) {
		const envKey = $env.AZURE_OPENAI_API_KEY;
		if (!envKey) {
			throw new ProviderHttpError("Azure OpenAI API key is required for server-side compaction.", 401);
		}
		apiKey = envKey;
	}
	const baseUrl = $env.AZURE_OPENAI_BASE_URL?.trim() || undefined;
	const resourceName = $env.AZURE_OPENAI_RESOURCE_NAME;
	const resolvedBaseUrl =
		(baseUrl && baseUrl.length > 0 ? baseUrl : undefined) ??
		(resourceName ? `https://${resourceName}.openai.azure.com/openai/v1` : undefined) ??
		(model.baseUrl && model.baseUrl.length > 0 ? model.baseUrl : undefined);
	if (!resolvedBaseUrl) {
		throw new ProviderHttpError(
			"Azure OpenAI base URL is required for server-side compaction. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or configure model.baseUrl.",
			400,
		);
	}
	const apiVersion = $env.AZURE_OPENAI_API_VERSION || "v1";
	const headers: Record<string, string> = { "api-key": apiKey, ...(model.headers ?? {}) };
	return {
		url: `${trimTrailingSlashes(resolvedBaseUrl)}/responses/compact?api-version=${encodeURIComponent(apiVersion)}`,
		headers,
	};
}

function resolveCompactWireModel(model: Model<Api>): string {
	const requestModel = model.requestModelId ?? model.id;
	if (model.api !== "azure-openai-responses") return requestModel;
	return parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel) ?? requestModel;
}

function buildCompactInputItems(model: Model<Api>, messages: Message[]): ResponseInput {
	const compat = model.compat as ResolvedOpenAIResponsesCompat;
	return buildResponsesInput({
		model: model as Model<"openai-responses">,
		context: { messages },
		strictResponsesPairing: compat.strictResponsesPairing,
		supportsImageDetailOriginal: compat.supportsImageDetailOriginal,
		supportsDeveloperRole: compat.supportsDeveloperRole,
		nativeHistory: { replay: true, filterReasoning: compat.filterReasoningHistory },
		includeThinkingSignatures: !compat.filterReasoningHistory,
		repairOrphanOutputs: true,
	});
}

function resolveCodexCompactRequest(
	model: Model<Api>,
	apiKey: string,
	request: ServerCompactionRequest,
): { url: string; headers: Record<string, string>; clientMetadata: Record<string, string> } {
	return createOpenAICodexDirectRequest({
		model: model as Model<"openai-codex-responses">,
		accessToken: apiKey,
		pathSuffix: "/compact",
		requestKind: "compaction",
		sessionId: request.sessionId,
		providerSessionState: request.providerSessionState,
		compaction: request.codexCompaction,
		responsesLite: resolveCodexResponsesLite(model, undefined),
	});
}

export const openAIResponsesServerCompaction: ServerCompactionTransport = {
	async compact(request: ServerCompactionRequest): Promise<ServerCompactionResult> {
		const { model, apiKey } = request;
		const isCodex = model.api === "openai-codex-responses";
		const resolved =
			model.api === "azure-openai-responses"
				? resolveAzureCompactRequest(model, apiKey)
				: isCodex
					? resolveCodexCompactRequest(model, apiKey, request)
					: resolveOpenAiCompactRequest(model, apiKey, request.messages);
		const { url, headers } = resolved;

		const input: Array<Record<string, unknown>> = [
			...(request.previousWindow ?? []),
			...(buildCompactInputItems(model, request.messages) as unknown as Array<Record<string, unknown>>),
		];

		const body: Record<string, unknown> = {
			model: resolveCompactWireModel(model),
			input,
		};
		if (request.instructions && request.instructions.trim().length > 0) {
			body.instructions = request.instructions;
		}
		if (isCodex) {
			const clientMetadata = "clientMetadata" in resolved ? resolved.clientMetadata : undefined;
			if (clientMetadata) body.client_metadata = clientMetadata;
			body.store = false;
			if (resolveCodexResponsesLite(model, undefined)) applyCodexResponsesLiteShape(body);
		}
		const applyCallerSanitizer = (text: string): string => {
			if (!request.sanitizeErrorText) return text;
			try {
				const sanitized = request.sanitizeErrorText(text);
				return typeof sanitized === "string" ? sanitized : "[redacted]";
			} catch {
				return "[redacted]";
			}
		};
		const sanitize = (text: string): string => applyCallerSanitizer(boundProviderErrorDetail(text));

		const timeoutMs = request.timeoutMs ?? 0;
		const requestTimeout = timeoutMs > 0 ? scopedTimeoutSignal(timeoutMs, request.signal) : undefined;
		try {
			const response = await (request.fetch ?? fetch)(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: stringifyJson(body),
				signal: requestTimeout?.signal ?? request.signal,
			});

			if (!response.ok) {
				const errorText = applyCallerSanitizer(await readProviderErrorDetail(response));
				const statusText = sanitize(response.statusText);
				const routeAbsent = response.status === 404;
				if (routeAbsent) routeAbsentForModel.add(`${model.provider}/${model.api}/${model.id}`);
				logger.warn("Server-side compaction failed", {
					url,
					provider: model.provider,
					model: model.id,
					status: response.status,
					statusText,
					errorText,
					routeAbsent,
				});
				throw new ProviderHttpError(
					routeAbsent
						? `Server-side compaction is not available for ${model.provider}/${model.id} (404 ${statusText})`
						: `Server-side compaction failed (${response.status} ${statusText})`,
					response.status,
					{ headers: response.headers },
				);
			}

			const data = (await response.json()) as CompactedResponseWire | undefined;
			const output = data?.output;
			if (!Array.isArray(output) || output.length === 0) {
				throw new Error(
					"Server-side compaction returned no output items. The history was NOT compacted; the caller falls back to local compaction.",
				);
			}
			if (
				!output.some(
					item =>
						item &&
						typeof item === "object" &&
						item.type === "compaction" &&
						typeof item.encrypted_content === "string",
				)
			) {
				throw new Error(
					"Server-side compaction returned a window with no compaction item. The history was NOT compacted; the caller falls back to local compaction.",
				);
			}
			return {
				window: output,
				usage:
					typeof data?.usage?.input_tokens === "number" || typeof data?.usage?.output_tokens === "number"
						? { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens }
						: undefined,
			};
		} finally {
			requestTimeout?.cancel();
		}
	},
};
