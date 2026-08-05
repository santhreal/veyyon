import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { errorMessage, trimTrailingSlashes } from "@veyyon/utils";
import { DEVIN_CASCADE_ENDPOINT } from "../provider-endpoints";
import type { FetchImpl, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW, AGENT_GATEWAY_DEFAULT_MAX_TOKENS } from "./default-limits";
import {
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
} from "./devin-gen/exa/api_server_pb/api_server_pb";
import { type ClientModelConfig, MetadataSchema } from "./devin-gen/exa/codeium_common_pb/codeium_common_pb";
import type { DiscoveryHooks } from "./failure";

const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

/**
 * The client Devin's API is told it is talking to.
 *
 * All four are sent as request metadata on every call, by model discovery here AND by the
 * provider in `@veyyon/ai`, which had its own copy of the strings. `@veyyon/catalog`
 * is the declared owner of what goes on Devin's wire, so a bump landed in one file and
 * left the other claiming a different client: two versions of the same product
 * identifying themselves differently on requests that belong to one session, which the
 * server is entitled to treat as two clients. Exported for the same reason
 * {@link DEVIN_SESSION_TOKEN_PREFIX} is.
 *
 * `chisel` is the native `devin` CLI's own internal name, and it is load-bearing rather
 * than cosmetic: `GetCliModelConfigs` gates entitlement on `ide_name`. Claiming to be
 * `windsurf` came back with `disabled_reason` "Upgrade to Pro to access this model" on 167
 * of 168 entries for an account that is fully entitled through the CLI, leaving discovery
 * with the one free model. `extension_name` is not part of that gate, but the two are sent
 * together to describe one client. The versions are the CLI's own (it really does ship
 * `0.0.0-dev`); their VALUE does not affect the gate, but an empty one is a 400, so they
 * are pinned rather than omitted.
 */
export const DEVIN_IDE_NAME = "chisel";
export const DEVIN_EXTENSION_NAME = "chisel";
export const DEVIN_IDE_VERSION = "0.0.0-dev";
export const DEVIN_EXTENSION_VERSION = "0.0.0-dev";

/**
 * Model display styles this client asks for, sent as `Metadata.supported_model_displays`.
 *
 * This is a catalogue filter rather than a rendering hint: the server only returns configs
 * whose display style the client claims to support. Sending nothing returns 168 of the 174
 * entries and drops `adaptive`; sending the native CLI's own `[3, 4, 6, 8]` returns all 174.
 *
 * We deliberately ask for LESS than the CLI does. Styles 4 and 6 are its internal buckets —
 * `swe-check`, `opus-4-7-review`, `gpt-5-5-review` (4) and `subagent-default`,
 * `memory-migration-default` (6) — which the CLI receives and then hides, because they are
 * fixed roles in its own harness and not models a user picks. Asking only for the
 * user-facing styles makes the server do that filtering: `[3, 8]` returns exactly the 169
 * the CLI displays, with no entry it omits and none of the five it hides.
 */
const DEVIN_SUPPORTED_MODEL_DISPLAYS = [3, 8];

/**
 * Prefix Devin's API expects on a session token.
 *
 * A user pastes the token with or without it, so it is added when missing rather than
 * demanded. The provider in `@veyyon/ai` sends the same header, and both used to spell the
 * prefix and the normalization themselves: if one added it and the other did not, model
 * discovery would authenticate while the requests that follow would not, or the reverse.
 */
export const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** Best-effort match for labels whose wording implies a thinking / reasoning-effort variant. */
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;
function supportsDevinThinking(config: ClientModelConfig): boolean {
	if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
	return config.modelInfo?.modelFeatures?.supportsThinking === true || REASONING_LABEL_PATTERN.test(config.label);
}

/**
 * Options for fetching dynamic Devin (Codeium Cascade) models from `GetCliModelConfigs`.
 */
export interface DevinModelDiscoveryOptions {
	/** Codeium session token carried inside protobuf `Metadata.apiKey`. */
	apiKey?: string;
	/** Optional Codeium API base URL override. */
	baseUrl?: string;
	/** Optional request timeout in milliseconds (default 5000). */
	timeoutMs?: number;
	/** Optional caller abort signal, combined with the internal timeout. */
	signal?: AbortSignal;
	/** Optional fetch implementation for request-debug/proxy/test transports. */
	fetch?: FetchImpl;
	/**
	 * Called with the reason when discovery returns `null`.
	 *
	 * The same channel every reader in this package uses, for the same reason: `null` alone cannot be
	 * explained, so a token this endpoint rejects and a network that never answered present identically,
	 * and the user sees a picker with no Devin models and nothing saying why. Never called on success,
	 * including a success with no models.
	 */
	onFailure?: DiscoveryHooks["onFailure"];
}

/**
 * Fetches Devin models through the `GetCliModelConfigs` unary Connect RPC and
 * normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchDevinModels(
	options: DevinModelDiscoveryOptions,
): Promise<ModelSpec<"devin-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const resolvedBaseUrl = options.baseUrl ?? DEVIN_CASCADE_ENDPOINT;
	const requestUrl = `${trimTrailingSlashes(resolvedBaseUrl)}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const request = create(GetCliModelConfigsRequestSchema, {
			metadata: create(MetadataSchema, {
				apiKey: normalizeDevinSessionToken(options.apiKey),
				ideName: DEVIN_IDE_NAME,
				ideVersion: DEVIN_IDE_VERSION,
				extensionName: DEVIN_EXTENSION_NAME,
				extensionVersion: DEVIN_EXTENSION_VERSION,
				supportedModelDisplays: DEVIN_SUPPORTED_MODEL_DISPLAYS,
			}),
		});
		const body = toBinary(GetCliModelConfigsRequestSchema, request);

		const headers: Record<string, string> = {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		};

		const fetchImpl = discoveryFetch(options.fetch);
		const response = await fetchImpl(requestUrl, { method: "POST", headers, body, signal });
		if (!response.ok) {
			options.onFailure?.({
				stage: "status",
				url: requestUrl,
				detail: `HTTP ${response.status} ${response.statusText}`.trim(),
			});
			return null;
		}

		const decoded = decodeCliModelConfigsResponse(new Uint8Array(await response.arrayBuffer()), detail =>
			options.onFailure?.({ stage: "body", url: requestUrl, detail }),
		);
		if (!decoded) {
			return null;
		}

		return normalizeDevinModels(decoded.clientModelConfigs, options.baseUrl);
	} catch (error) {
		// Null is 'no catalog from this provider', distinct from the `[]` an endpoint with no models returns,
		// and the caller reports the provider as unavailable. The throw covers the request itself and the body
		// read, both of which point at the network rather than at the protocol.
		options.onFailure?.({ stage: "request", url: requestUrl, detail: errorMessage(error) });
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** A Devin session token with its prefix, adding it when the pasted value lacks one. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
	if (!apiKey) return "";
	return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Decodes a raw (unframed) `GetCliModelConfigsResponse`. Bun's `fetch` usually
 * auto-decompresses gzip, so the direct decode is attempted first; a
 * `gunzipSync` fallback covers runtimes that hand back the still-compressed body.
 */
function decodeCliModelConfigsResponse(payload: Uint8Array, reportUndecodable: (detail: string) => void) {
	try {
		return fromBinary(GetCliModelConfigsResponseSchema, payload);
	} catch (directError) {
		try {
			return fromBinary(GetCliModelConfigsResponseSchema, gunzipSync(payload));
		} catch (gzipError) {
			// Both attempts are reported, because which one failed is the whole diagnosis: a direct decode error
			// with a gzip error that is NOT a decode error means the body was never protobuf at all (a proxy login
			// page is the usual culprit), while two decode errors mean the endpoint changed its schema.
			reportUndecodable(
				`response is not a GetCliModelConfigsResponse: ${errorMessage(directError)}; after gunzip: ${errorMessage(gzipError)}`,
			);
			return null;
		}
	}
}

/**
 * Turns `ClientModelConfig` entries into canonical model entries, dropping the ones this
 * account cannot actually use.
 *
 * The disabled test reads `disabled_reason` (field 33) and NOT the `disabled` bool the
 * vendored descriptor still declares at field 4. Field 4 is not a disablement flag on the
 * current wire: in the native CLI's own fully-entitled response it is true on 171 of 174
 * entries, `grok-4-5-medium` among them, every one of which the CLI lists as available, and
 * the CLI's own compiled `ClientModelConfig` has no `disabled` field at all — it carries
 * `disabled_reason` instead. Reading field 4 is what reduced this provider to the single
 * free model. What field 4 does mean is not something the evidence settles, so nothing here
 * reads it; the descriptor is generated and is left as the vendor's proto produced it.
 *
 * `disabled_reason` is the signal the server actually populates, and it is per-account: the
 * same request under the wrong `ide_name` comes back with "Upgrade to Pro to access this
 * model" attached to nearly every entry. It is absent on all 169 when the identity is right.
 */
function normalizeDevinModels(
	configs: readonly ClientModelConfig[],
	baseUrlOverride: string | undefined,
): ModelSpec<"devin-agent">[] {
	const byId = new Map<string, ModelSpec<"devin-agent">>();
	for (const config of configs) {
		if (config.disabledReason) {
			continue;
		}
		const id = config.modelUid.trim();
		if (!id) {
			continue;
		}
		const input: ("text" | "image")[] = config.supportsImages ? ["text", "image"] : ["text"];
		const contextWindow = config.maxTokens > 0 ? config.maxTokens : AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW;
		byId.set(id, {
			id,
			name: config.label.trim() || id,
			api: "devin-agent",
			provider: "devin",
			baseUrl: baseUrlOverride ?? DEVIN_CASCADE_ENDPOINT,
			reasoning: supportsDevinThinking(config),
			input,
			supportsTools: true,
			// This endpoint publishes no pricing, so the zeros mean "not told", not "free".
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			pricing: "unknown",
			contextWindow,
			maxTokens: Math.min(
				config.maxTokens > 0 ? config.maxTokens : AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
				AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
			),
		});
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
