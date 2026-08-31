/**
 * OpenAI server-side compaction transport.
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
 *
 * The route is per host family, and they do not agree. The official and Azure
 * hosts serve `POST {base}/responses/compact` as documented above, answering
 * with one JSON document. The ChatGPT Codex backend serves no compact route at
 * all — that path, `{base}/codex/compact` and `{base}/responses/compact` each
 * answer 404 — and compacts through an input item instead: an ordinary
 * streaming `POST {base}/codex/responses` whose last input item is
 * `{ type: "compaction_trigger" }`. `./openai-codex/compaction-v2.ts` owns that
 * wire, `resolveCodexCompactRequest` resolves its identity, and
 * `a-compaction-route-matches-the-host-that-serves-it.test.ts` pins both.
 */

import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { boundProviderErrorDetail, ProviderHttpError, readProviderErrorDetail } from "../error";
import type { Api, CodexCompactionRequestContext, FetchImpl, Message, Model, ProviderSessionState } from "../types";
import { applyCodexResponsesLiteShape, resolveCodexResponsesLite } from "./openai-codex/request-transformer";
import { createOpenAICodexDirectRequest } from "./openai-codex-responses";
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
	/**
	 * Live session id. Hosts that key request identity to a conversation (the
	 * ChatGPT Codex backend, which carries thread/window/turn headers) send it;
	 * the stateless official and Azure routes ignore it.
	 */
	sessionId?: string;
	/** Provider-owned per-session transport state, for the same identity. */
	providerSessionState?: Map<string, ProviderSessionState>;
	/** Canonical Codex compaction classification for this pass; ignored elsewhere. */
	codexCompaction?: CodexCompactionRequestContext;
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

/**
 * Responses-API families served by the OpenAI wire shape in this module.
 * Exported so a test pins the exact set: this table and the
 * `supportsServerCompaction` host predicate are the two places server-side
 * compaction has been switched off and back on, and neither change is visible
 * in a diff that only reads the transport.
 */
export const SERVER_COMPACTION_WIRE_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

/**
 * Models whose compact route answered 404. A 404 is not a transient failure
 * and not a credential problem: the route is absent for that model on that
 * host, so every later attempt costs a round trip, a warning and a fallback to
 * reach the same answer. Recording it turns the negative into data discovered
 * at run time instead of a hand-maintained predicate.
 *
 * Scope is the process, keyed by `provider/api/id`. A host that gains the
 * route serves it again on the next launch; nothing here is persisted, so a
 * stale negative cannot outlive the run that observed it.
 */
const routeAbsentForModel = new Set<string>();

/** Forget every observed 404 so a test starts from the declared capability data. */
export function resetServerCompactionRouteCache(): void {
	routeAbsentForModel.clear();
}

/**
 * Whether this model's compact route was observed absent in this process, so
 * {@link resolveServerCompactionTransport} now resolves undefined for a model
 * whose capability data still says it is supported.
 *
 * The caller needs the two cases apart. A model that never supported
 * server-side compaction is INERT: the setting does not apply to it and saying
 * so on every compaction would be noise. A model that supported it until a 404
 * took it away is a DOWNGRADE the operator chose the opposite of, and the only
 * evidence used to be one warning on the first compaction of each process,
 * after which every later compaction ran locally in silence.
 */
export function serverCompactionRouteAbsent(model: Model<Api>): boolean {
	return routeAbsentForModel.has(`${model.provider}/${model.api}/${model.id}`);
}

/**
 * Resolve the server-side compaction transport for a model, or undefined when
 * the model cannot compact server-side. Support is the compat DATA flag, not
 * a provider-name check: `supportsServerCompaction` is resolved per host at
 * model build time and can be flipped per row by config or discovery. A model
 * whose route already answered 404 in this process resolves undefined too, so
 * the caller goes straight to local compaction without asking again.
 */
export function resolveServerCompactionTransport(model: Model<Api>): ServerCompactionTransport | undefined {
	if (!SERVER_COMPACTION_WIRE_APIS[model.api]) return undefined;
	// Narrowed by the api gate above: every responses-family model carries the
	// resolved responses compat record.
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
	return { url: `${baseUrl}/responses/compact`, headers: setup.headers };
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

/**
 * Resolve the compaction endpoint and headers for the ChatGPT Codex backend.
 *
 * The route is the codex responses path with the `/compact` suffix
 * (`chatgpt.com/backend-api/codex/responses/compact`), reached with the ChatGPT
 * OAuth access token and the same request identity a turn carries. This is the
 * wire oh-my-pi posts (`resolveOpenAiCodexCompactEndpoint`): a base already
 * ending in `/codex` takes `/responses/compact`, anything else takes
 * `/codex/responses/compact`. `createOpenAICodexDirectRequest` returns the turn
 * route, so the suffix is appended to it.
 */
function resolveCodexCompactRequest(
	model: Model<Api>,
	apiKey: string,
	request: ServerCompactionRequest,
): { url: string; headers: Record<string, string>; clientMetadata: Record<string, string> } {
	const direct = createOpenAICodexDirectRequest({
		model: model as Model<"openai-codex-responses">,
		accessToken: apiKey,
		requestKind: "compaction",
		sessionId: request.sessionId,
		providerSessionState: request.providerSessionState,
		compaction: request.codexCompaction,
		responsesLite: resolveCodexResponsesLite(model, undefined),
	});
	const base = direct.url.replace(/\/+$/, "");
	return { ...direct, url: base.endsWith("/compact") ? base : `${base}/compact` };
}

/** The OpenAI Responses server-side compaction transport (official, Azure, and ChatGPT Codex hosts). */
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

		// Body exactly per the compact method reference: model, input,
		// instructions. No store: the endpoint is stateless. The Codex host is
		// not that route and shapes its own body below.
		const body: Record<string, unknown> = {
			model: resolveCompactWireModel(model),
			input,
		};
		if (request.instructions && request.instructions.trim().length > 0) {
			body.instructions = request.instructions;
		}
		if (isCodex) {
			// The compact route answers one JSON document, exactly as the official
			// host does: no `stream`, no `compaction_trigger` item. What the codex
			// host adds is its request identity and, for a Responses Lite model, the
			// same rewrite a turn takes — oh-my-pi routes compaction through the one
			// request builder for this reason (`build_responses_request` in
			// codex-rs), so the lite marker and the encrypted-reasoning include ride
			// along rather than being special-cased here.
			const clientMetadata = "clientMetadata" in resolved ? resolved.clientMetadata : undefined;
			if (clientMetadata) body.client_metadata = clientMetadata;
			body.store = false;
			if (resolveCodexResponsesLite(model, undefined)) {
				applyCodexResponsesLiteShape(body);
				body.include = Array.from(
					new Set([
						...(Array.isArray(body.include) ? (body.include as string[]) : []),
						"reasoning.encrypted_content",
					]),
				);
			}
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

		// The fence spans the body read too; a middlebox can drop the connection
		// after headers and only the armed signal interrupts the response read.
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
				// The body is read under the shared byte ceiling, so an enormous error page is
				// never allocated whole just to be capped afterwards.
				const errorText = applyCallerSanitizer(await readProviderErrorDetail(response));
				const statusText = sanitize(response.statusText);
				// 404 answers the capability question the compat flag only
				// predicts: this model's host does not serve the route. Record
				// it so the next compaction skips the request instead of
				// repeating it once per compaction for the rest of the run.
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
