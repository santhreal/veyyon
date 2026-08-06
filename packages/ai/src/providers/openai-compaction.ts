/**
 * OpenAI server-side compaction transport: `POST /responses/compact`.
 *
 * Wire contract implemented here, from the OpenAI Compaction guide
 * (https://developers.openai.com/api/docs/guides/compaction) and the compact
 * method reference
 * (https://developers.openai.com/api/reference/resources/responses/methods/compact):
 *
 * - Request body: `{ model, input, instructions? }`. `input` is a Responses-API
 *   item array; "The window you send to /responses/compact must still fit
 *   within your model's context window."
 * - Response: `CompactedResponse { id, created_at, object: "response.compaction",
 *   output, usage }`. "The compacted window generally contains more than just
 *   the compaction item. It can also include retained items from the previous
 *   window."
 * - The compaction item `{ type: "compaction", encrypted_content }` "is opaque
 *   and not intended to be human-interpretable."
 * - "Output handling: do not prune /responses/compact output. The returned
 *   window is the canonical next context window, so pass it into your next
 *   /responses call as-is." This module therefore returns `output` verbatim;
 *   callers store and replay it untouched.
 *
 * Host support is DATA on the model row (`compat.supportsServerCompaction`,
 * resolved in `@veyyon/catalog/compat/openai`): the official OpenAI API and
 * Azure OpenAI's v1 API serve the endpoint today (Microsoft Learn documents
 * `{resource}.openai.azure.com/openai/v1/responses/compact` with the `api-key`
 * header and the deployment name as `model`). A second compatible host opts in
 * with that flag alone; a provider with a different wire shape adds a sibling
 * implementation of {@link ServerCompactionTransport}.
 */

import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { ProviderHttpError } from "../error";
import type { Api, FetchImpl, Message, Model } from "../types";
import type { ResponseInput } from "./openai-responses-wire";
import { buildResponsesInput, parseAzureDeploymentNameMap, resolveOpenAIRequestSetup } from "./openai-shared";

/**
 * What a provider that compacts server-side must implement. The compaction
 * engine (`@veyyon/agent-core/compaction/remote-compaction`) talks to this
 * interface and nothing else; the next provider is a new implementation plus
 * its capability flag, never an edit to the engine.
 */
export interface ServerCompactionTransport {
	/**
	 * Compact the given conversation span on the provider and return the
	 * canonical next window. `request.previousWindow` is the window stored by
	 * the previous server-side compaction on this branch, chained in front of
	 * the new span ("The latest compaction item carries the necessary context
	 * to continue the conversation").
	 */
	compact(request: ServerCompactionRequest): Promise<ServerCompactionResult>;
}

export interface ServerCompactionRequest {
	/** The SESSION model; server-side compaction always runs on it, never on a configured compaction model. */
	model: Model<Api>;
	/** LLM messages of the span being compacted (already secret-obfuscated by the caller). */
	messages: Message[];
	/** Native window from the previous server-side compaction on this branch, for chaining. */
	previousWindow?: Array<Record<string, unknown>>;
	/** System instructions for the compaction call (the session's base system prompt). */
	instructions?: string;
	/** Resolved credential for this attempt (wrap in `withAuth` at the call site). */
	apiKey: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	/** Hard ceiling for the whole call; <= 0 disables the timeout. */
	timeoutMs?: number;
	/** Redactor applied to any provider error text before it reaches logs or errors. */
	sanitizeErrorText?: (text: string) => string;
}

export interface ServerCompactionResult {
	/** Canonical next window from the provider, verbatim: retained items plus the opaque compaction item. */
	window: Array<Record<string, unknown>>;
	/** Token accounting of the compaction call itself, when the provider reports it. */
	usage?: { inputTokens?: number; outputTokens?: number };
}

/** Responses-API families served by the OpenAI wire shape in this module. */
const SERVER_COMPACTION_WIRE_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
};

/**
 * Resolve the server-side compaction transport for a model, or undefined when
 * the model cannot compact server-side. Support is the compat DATA flag, not
 * a provider-name check: `supportsServerCompaction` is resolved per host at
 * model build time and can be flipped per row by config or discovery.
 */
export function resolveServerCompactionTransport(model: Model<Api>): ServerCompactionTransport | undefined {
	if (!SERVER_COMPACTION_WIRE_APIS[model.api]) return undefined;
	// Narrowed by the api gate above: every responses-family model carries the
	// resolved responses compat record.
	const compat = model.compat as ResolvedOpenAIResponsesCompat;
	if (compat.supportsServerCompaction !== true) return undefined;
	return openAIResponsesServerCompaction;
}

/** Bound the non-2xx body written into logs and error messages. */
const MAX_ERROR_DETAIL_CHARS = 4096;

interface CompactedResponseWire {
	id?: string;
	object?: string;
	created_at?: number;
	output?: Array<Record<string, unknown>>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** Resolve the compact endpoint and headers for the official OpenAI host family. */
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
	return { url: `${baseUrl}/responses/compact`, headers: setup.requestHeaders };
}

/**
 * Resolve the compact endpoint and headers for Azure OpenAI. Mirrors
 * `buildAzureResponsesRequest` in azure-openai-responses.ts: a string key rides
 * as the `api-key` header, `api-version` as a query parameter, and the path is
 * not deployment-scoped — the deployment name goes in the body's `model` field.
 */
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

/** Wire model id for the compact call, honoring Azure deployment mapping. */
function resolveCompactWireModel(model: Model<Api>): string {
	const requestModel = model.requestModelId ?? model.id;
	if (model.api !== "azure-openai-responses") return requestModel;
	return parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel) ?? requestModel;
}

/**
 * Encode the LLM messages of the compacted span as Responses-API input items
 * through the same encoder a live turn uses, with native-history replay on so
 * assistant turns contribute their stored provider items (encrypted reasoning
 * included) instead of a text re-encode. That fidelity is the reason to
 * compact server-side at all.
 */
function buildCompactInputItems(model: Model<Api>, messages: Message[]): ResponseInput {
	// Narrowed by resolveServerCompactionTransport: only responses-family models
	// reach this encoder, and their compat is the resolved responses record.
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

/** The OpenAI Responses server-side compaction transport (official + Azure hosts). */
export const openAIResponsesServerCompaction: ServerCompactionTransport = {
	async compact(request: ServerCompactionRequest): Promise<ServerCompactionResult> {
		const { model, apiKey } = request;
		const { url, headers } =
			model.api === "azure-openai-responses"
				? resolveAzureCompactRequest(model, apiKey)
				: resolveOpenAiCompactRequest(model, apiKey, request.messages);

		const input: Array<Record<string, unknown>> = [
			...(request.previousWindow ?? []),
			...(buildCompactInputItems(model, request.messages) as unknown as Array<Record<string, unknown>>),
		];

		// Body exactly per the compact method reference: model, input,
		// instructions. No streaming, no store: the endpoint is stateless.
		const body: Record<string, unknown> = {
			model: resolveCompactWireModel(model),
			input,
		};
		if (request.instructions && request.instructions.trim().length > 0) {
			body.instructions = request.instructions;
		}

		const sanitize = (text: string): string => {
			const capped =
				text.length <= MAX_ERROR_DETAIL_CHARS
					? text
					: `${text.slice(0, MAX_ERROR_DETAIL_CHARS)} [truncated, ${text.length} chars total]`;
			if (!request.sanitizeErrorText) return capped;
			try {
				const sanitized = request.sanitizeErrorText(capped);
				return typeof sanitized === "string" ? sanitized : "[redacted]";
			} catch {
				return "[redacted]";
			}
		};

		// The fence spans the body read too; a middlebox can drop the connection
		// after headers and only the armed signal interrupts response.json().
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
				const errorText = sanitize(await response.text().catch(() => ""));
				const statusText = sanitize(response.statusText);
				logger.warn("Server-side compaction failed", {
					url,
					provider: model.provider,
					model: model.id,
					status: response.status,
					statusText,
					errorText,
				});
				throw new ProviderHttpError(
					`Server-side compaction failed (${response.status} ${statusText})`,
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
			// A window without a compaction item is not compacted: it would replay
			// at full size on every turn while claiming the history was reduced.
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
