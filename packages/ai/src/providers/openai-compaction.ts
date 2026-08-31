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
 *
 * That split is a live measurement, not a reading of the guide. Re-measured on
 * 2026-09-01 against a ChatGPT account on `gpt-5.6-sol` with a valid OAuth
 * token: `POST {base}/codex/responses/compact` answered `404 Not Found`, and
 * the same span sent to `POST {base}/codex/responses` with a trailing
 * `compaction_trigger` item answered `200` with exactly one `compaction` item
 * carrying a 1740-character `encrypted_content`. An earlier session read the
 * opposite and moved this module to the compact route; that shipped a wire the
 * host does not serve, so every codex compaction 404'd into a paid local pass.
 * Move the route only with a live call of your own, and move the
 * `implementation` declaration in `@veyyon/agent-core/compaction/remote-compaction`
 * in the same commit — the two are one decision.
 */

import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { boundProviderErrorDetail, ProviderHttpError, readProviderErrorDetail } from "../error";
import type { Api, CodexCompactionRequestContext, FetchImpl, Message, Model, ProviderSessionState } from "../types";
import {
	buildCodexCompactionV2Window,
	CODEX_COMPACTION_TRIGGER_ITEM,
	collectCodexCompactionV2Stream,
} from "./openai-codex/compaction-v2";
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
	/**
	 * The session's prompt cache key, when it differs from the session id. A
	 * turn keys its cache on `promptCacheKey ?? sessionId`, so a compaction that
	 * used the session id alone would open a second cache lineage for the same
	 * conversation and the next turn would re-pay full uncached input.
	 */
	promptCacheKey?: string;
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
 * How long an observed 404 keeps a model out of server-side compaction before
 * the route is tried once more.
 *
 * A permanent latch is the wrong shape even though a 404 is a capability
 * answer. The negative is observed once, from one request, and it survives a
 * deploy that adds the route, a proxy that answers 404 while it reloads, and a
 * gateway that mis-routes one call. Every compaction after that runs LOCALLY —
 * a paid summarization pass on every compaction for the rest of the run — so a
 * single wrong negative is not a silent no-op, it is a recurring charge.
 *
 * Re-arming costs one request per model per window, which is bounded and
 * cheap; the latch it replaces was unbounded in the other direction.
 */
const ROUTE_ABSENT_REARM_MS = 30 * 60_000;

/**
 * Models whose compact route answered 404, and when. A 404 is not a transient
 * failure and not a credential problem: the route is absent for that model on
 * that host, so every later attempt costs a round trip, a warning and a
 * fallback to reach the same answer. Recording it turns the negative into data
 * discovered at run time instead of a hand-maintained predicate.
 *
 * Scope is the process, keyed by `provider/api/id`, and the value is the
 * observation time so the negative expires after {@link ROUTE_ABSENT_REARM_MS}.
 * Nothing here is persisted, so a stale negative cannot outlive the run that
 * observed it either.
 */
const routeAbsentForModel = new Map<string, number>();

function routeCacheKey(model: Model<Api>): string {
	return `${model.provider}/${model.api}/${model.id}`;
}

/** Forget every observed 404 so a test starts from the declared capability data. */
export function resetServerCompactionRouteCache(): void {
	routeAbsentForModel.clear();
}

/**
 * Whether this model's compact route was observed absent recently enough to
 * still be believed, so {@link resolveServerCompactionTransport} resolves
 * undefined for a model whose capability data still says it is supported.
 *
 * The caller needs the two cases apart. A model that never supported
 * server-side compaction is INERT: the setting does not apply to it and saying
 * so on every compaction would be noise. A model that supported it until a 404
 * took it away is a DOWNGRADE the operator chose the opposite of, and the only
 * evidence used to be one warning on the first compaction of each process,
 * after which every later compaction ran locally in silence.
 *
 * Reading is what expires the entry, so the negative cannot outlive its window
 * even if no compaction happens for hours.
 */
export function serverCompactionRouteAbsent(model: Model<Api>): boolean {
	const key = routeCacheKey(model);
	const observedAt = routeAbsentForModel.get(key);
	if (observedAt === undefined) return false;
	if (Date.now() - observedAt < ROUTE_ABSENT_REARM_MS) return true;
	routeAbsentForModel.delete(key);
	return false;
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
	if (serverCompactionRouteAbsent(model)) return undefined;
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
 * The route is the ordinary codex responses path
 * (`chatgpt.com/backend-api/codex/responses`), reached with the ChatGPT OAuth
 * access token and the same request identity a turn carries. There is no
 * `/compact` suffix: the host answers that path with 404, and the compaction is
 * requested by the trailing `compaction_trigger` input item instead.
 *
 * The cache key is the turn's, not a compaction-specific one: the request rides
 * the same conversation and must land on the same cached prefix.
 */
function resolveCodexCompactRequest(
	model: Model<Api>,
	apiKey: string,
	request: ServerCompactionRequest,
): { url: string; headers: Record<string, string>; clientMetadata: Record<string, string> } {
	return createOpenAICodexDirectRequest({
		model: model as Model<"openai-codex-responses">,
		accessToken: apiKey,
		requestKind: "compaction",
		sessionId: request.sessionId,
		promptCacheKey: request.promptCacheKey,
		providerSessionState: request.providerSessionState,
		compaction: request.codexCompaction,
		responsesLite: resolveCodexResponsesLite(model, undefined),
	});
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

		// Body per the compact method reference: model, input, instructions. No
		// store: the official endpoint is stateless. The Codex host serves a
		// different wire and shapes its own body below.
		const body: Record<string, unknown> = {
			model: resolveCompactWireModel(model),
			input,
		};
		if (request.instructions && request.instructions.trim().length > 0) {
			body.instructions = request.instructions;
		}
		if (isCodex) {
			// The codex host has no compact route. A compaction is an ordinary
			// streaming turn whose last input item is `compaction_trigger`, which
			// makes the backend answer exactly one `compaction` output item and
			// nothing else. codex-rs does this in `core/src/compact_remote_v2.rs`.
			//
			// `stream` is not optional: a body without it is rejected with 400
			// `{"detail":"Stream must be set to true"}`, which is why the request
			// builder already sends `accept: text/event-stream`.
			//
			// The trigger is appended to `input` rather than replacing it, so the
			// span the host compacts is the span the caller asked to compact.
			input.push({ ...CODEX_COMPACTION_TRIGGER_ITEM });
			const clientMetadata = "clientMetadata" in resolved ? resolved.clientMetadata : undefined;
			if (clientMetadata) body.client_metadata = clientMetadata;
			body.stream = true;
			body.store = false;
			// A turn sends `prompt_cache_key`, so a compaction without it is a
			// cache miss on the session's own prefix, and the turn after it pays
			// full uncached input again. Same key, same lineage, one cache.
			const cacheKey = "promptCacheKey" in resolved ? resolved.promptCacheKey : undefined;
			if (cacheKey) body.prompt_cache_key = cacheKey;
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
				if (routeAbsent) routeAbsentForModel.set(routeCacheKey(model), Date.now());
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

			if (isCodex) {
				if (!response.body) {
					throw new Error(
						"Codex compaction returned no response body. The history was NOT compacted; the caller falls back to local compaction.",
					);
				}
				// The reader requires exactly one compaction item: zero means the
				// trigger did not take and the host ran the span as an ordinary
				// paid turn, more than one means the window is ambiguous. Either
				// way the caller compacts locally rather than storing a history
				// that does not compact.
				const stream = await collectCodexCompactionV2Stream(
					response.body,
					requestTimeout?.signal ?? request.signal,
					sanitize,
				);
				return {
					// The codex host answers `response.completed` with an empty
					// `output`, so the window is assembled here: the span's
					// retained real user messages followed by the compaction item.
					window: buildCodexCompactionV2Window(input, stream.compactionItem),
					usage: stream.usage,
				};
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
			// More than one is legitimate here and only here — the guide states the
			// compacted window may retain items from the previous window, and a
			// chained compaction retains the prior compaction item — so the JSON
			// route requires at least one where the codex stream requires exactly
			// one.
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
