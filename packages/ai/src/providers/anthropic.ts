import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import { scheduler } from "node:timers/promises";
import * as tls from "node:tls";
import { isOfficialAnthropicApiUrl } from "@veyyon/catalog/compat/anthropic";
import { mapEffortToAnthropicAdaptiveEffort } from "@veyyon/catalog/model-thinking";
import { calculateCost, discardAttemptUsage, emptyCost, emptyUsage, getBundledModel } from "@veyyon/catalog/models";
import { ANTHROPIC_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import type { ProviderAnthropicMessagesCapability } from "@veyyon/catalog/provider-models/wire-capabilities";
import { providerWireCapabilities } from "@veyyon/catalog/provider-models/wire-capabilities";
import { isAnthropicOAuthToken } from "@veyyon/catalog/utils";
import { ANTHROPIC_WEB_SEARCH_TOOL, CLAUDE_CODE_VERSION as claudeCodeVersion } from "@veyyon/catalog/wire/anthropic";
import { parseGitHubCopilotApiKey } from "@veyyon/catalog/wire/github-copilot";
import { getInstallId } from "@veyyon/utils/dirs";
import { $env } from "@veyyon/utils/env";
import { DEFAULT_MAX_DELAY_MS } from "@veyyon/utils/fetch-retry";
import { isEnoent } from "@veyyon/utils/fs-error";
import { parseJsonWithRepair, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { clampLow } from "@veyyon/utils/math";
import { looksLikeFilePath } from "@veyyon/utils/path";
import { readSseEvents } from "@veyyon/utils/stream";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import {
	beginCacheTrackedRequest,
	type CacheEnforcement,
	CacheRejectedError,
	type CacheTrackedRequest,
	type CacheTrackerState,
	createCacheTrackerState,
	describeCacheVerdict,
	recordCacheOutcome,
	resolveCacheEnforcement,
	takePendingCacheFailure,
} from "../cache";
import { renderDemotedThinking } from "../dialect/demotion";
import { XML_THINKING_CLOSE, XML_THINKING_OPEN } from "../dialect/wire-tags";
import * as AIError from "../error";
import { getEnvApiKey, OUTPUT_FALLBACK_BUFFER } from "../stream";
import type {
	AnthropicFallbackContent,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ProviderSessionState,
	RawSseEvent,
	RedactedThinkingContent,
	ServiceTier,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types";
import { EMPTY_ERROR_TOOL_RESULT_TEXT, realizesPriorityServiceTier } from "../types";
import { isRecord, normalizeSystemPrompts, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { withEmptyCompletionRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { type FirstEventBudget, isPreResponseStall, openStallLadderBudget } from "../utils/first-event-budget";
import { isFoundryEnabled } from "../utils/foundry";
import { finalizeErrorMessage, materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { createSdkStreamRequestOptions } from "../utils/sdk-stream-timeout";
import { notifyRawSseEvent } from "../utils/sse-debug";
import {
	AnthropicApiError,
	AnthropicConnectionTimeoutError,
	type AnthropicFetchOptions,
	AnthropicMessagesClient,
	type AnthropicMessagesClientLike,
	calculateAnthropicRetryDelayMs,
	retryDelayFromHeaders,
} from "./anthropic-client";
import { buildAnthropicToolSchemaPlans } from "./anthropic-schema";
import type {
	Tool as AnthropicWireTool,
	AnthropicWireUsage,
	ContentBlockParam,
	FallbackParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	TextBlockParam,
} from "./anthropic-wire";
import {
	buildCopilotDynamicHeaders,
	hasCopilotVisionInput,
	resolveGitHubCopilotBaseUrl,
} from "./github-copilot-headers";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export { normalizeAnthropicToolSchema } from "./anthropic-schema";

export type AnthropicHeaderOptions = {
	apiKey: string;
	baseUrl?: string;
	isOAuth?: boolean;
	extraBetas?: string[];
	stream?: boolean;
	modelHeaders?: Record<string, string>;
	isCloudflareAiGateway?: boolean;
	claudeCodeSessionId?: string;
	claudeCodeBetas?: readonly string[];
};

export function normalizeAnthropicBaseUrl(baseUrl?: string): string | undefined {
	const trimmed = baseUrl?.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutTrailingSlashes = trimTrailingSlashes(trimmed);
	return withoutTrailingSlashes.endsWith("/v1") ? withoutTrailingSlashes.slice(0, -3) : withoutTrailingSlashes;
}

export function buildBetaHeader(baseBetas: readonly string[], extraBetas: readonly string[]): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const beta of baseBetas.concat(extraBetas)) {
		const trimmed = beta.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result.join(",");
}

const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
const contextManagementBeta = "context-management-2025-06-27";
const structuredOutputsBeta = "structured-outputs-2025-12-15";
const claudeCodeUtilityBetaDefaults = [
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	structuredOutputsBeta,
] as const;
const claudeCodeAgentBetaDefaults = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	midConversationSystemBeta,
	"advanced-tool-use-2025-11-20",
] as const;
const claudeCodeAgentPostEffortBetas = ["extended-cache-ttl-2025-04-11"] as const;
const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
export const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
const redactThinkingBeta = "redact-thinking-2026-02-12";
const fastModeBeta = "fast-mode-2026-02-01";
const taskBudgetBeta = "task-budgets-2026-03-13";
const effortBeta = "effort-2025-11-24";
const serverSideFallbackBeta = "server-side-fallback-2026-06-01";

function buildClaudeCodeBetas(
	agentRequest: boolean,
	thinkingRequest: boolean,
	redactThinking: boolean,
	disableStrictTools = false,
): readonly string[] {
	if (!agentRequest && !redactThinking && !disableStrictTools) return claudeCodeUtilityBetaDefaults;
	const betas: string[] = [];
	for (const beta of agentRequest ? claudeCodeAgentBetaDefaults : claudeCodeUtilityBetaDefaults) {
		if (disableStrictTools && beta === structuredOutputsBeta) continue;
		betas.push(beta);
		if (redactThinking && beta === interleavedThinkingBeta) betas.push(redactThinkingBeta);
	}
	if (!agentRequest) return betas;
	if (thinkingRequest) betas.push(effortBeta);
	for (let bi = 0; bi < claudeCodeAgentPostEffortBetas.length; bi++) betas.push(claudeCodeAgentPostEffortBetas[bi]!);
	return betas;
}

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, headerName: string): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
	"x-app": "cli",
};

const reportedDroppedEnforcedHeaders = new Set<string>();

function reportDroppedEnforcedHeaders(keys: string[]): void {
	const signature = Array.from(keys).sort().join(",");
	const detail = { headers: keys };
	if (reportedDroppedEnforcedHeaders.has(signature)) {
		logger.debug("anthropic: still ignoring caller-supplied enforced headers", detail);
		return;
	}
	reportedDroppedEnforcedHeaders.add(signature);
	logger.warn(
		"anthropic: caller-supplied headers were replaced by this request's own values, so the configured ones are not being sent",
		detail,
	);
}

export function __resetDroppedEnforcedHeaderReportsForTests(): void {
	reportedDroppedEnforcedHeaders.clear();
}

export function buildAnthropicHeaders(options: AnthropicHeaderOptions): Record<string, string> {
	const oauthToken = options.isOAuth ?? isAnthropicOAuthToken(options.apiKey);
	const extraBetas = options.extraBetas ?? [];
	const stream = options.stream ?? false;

	const incomingUserAgent = getHeaderCaseInsensitive(options.modelHeaders, "User-Agent");
	const incomingAuthorization = getHeaderCaseInsensitive(options.modelHeaders, "Authorization");
	const incomingApiKey = getHeaderCaseInsensitive(options.modelHeaders, "X-Api-Key");

	const betaHeader = buildBetaHeader(
		options.claudeCodeBetas ?? (oauthToken ? buildClaudeCodeBetas(true, true, false) : []),
		extraBetas,
	);
	const acceptHeader = oauthToken ? "application/json" : stream ? "text/event-stream" : "application/json";
	const isCloudflare = options.isCloudflareAiGateway ?? false;
	const honorAuthorization = !oauthToken && !isCloudflare;
	const honorApiKey = !isCloudflare;
	const modelHeaders: Record<string, string> = {};
	const filteredEnforcedKeys: string[] = [];
	for (const [key, value] of Object.entries(options.modelHeaders ?? {})) {
		const lowerKey = key.toLowerCase();
		if (enforcedHeaderKeys.has(lowerKey)) {
			if (lowerKey === "user-agent") {
				if (oauthToken && !isClaudeCodeClientUserAgent(value)) filteredEnforcedKeys.push(key);
				continue;
			}
			if (lowerKey === "authorization" && honorAuthorization) continue;
			if (lowerKey === "x-api-key" && honorApiKey) continue;
			filteredEnforcedKeys.push(key);
			continue;
		}
		modelHeaders[key] = value;
	}
	if (filteredEnforcedKeys.length > 0) {
		reportDroppedEnforcedHeaders(filteredEnforcedKeys);
	}

	if (isCloudflare) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			"cf-aig-authorization": `Bearer ${options.apiKey}`,
		};
	}

	if (oauthToken) {
		const userAgent = isClaudeCodeClientUserAgent(incomingUserAgent)
			? incomingUserAgent
			: `claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`;
		return {
			...modelHeaders,
			...claudeCodeHeaders,
			Accept: acceptHeader,
			Authorization: `Bearer ${options.apiKey}`,
			...sharedHeaders,
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(options.claudeCodeSessionId ? { "X-Claude-Code-Session-Id": options.claudeCodeSessionId } : {}),
			"x-client-request-id": nodeCrypto.randomUUID(),
			"User-Agent": userAgent,
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
	} else if (!isOfficialAnthropicApiUrl(options.baseUrl)) {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			Authorization: incomingAuthorization ?? `Bearer ${options.apiKey}`,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingApiKey ? { "X-Api-Key": incomingApiKey } : {}),
		};
	} else {
		return {
			...modelHeaders,
			Accept: acceptHeader,
			...sharedHeaders,
			...(incomingUserAgent ? { "User-Agent": incomingUserAgent } : {}),
			...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
			...(incomingAuthorization ? { Authorization: incomingAuthorization } : {}),
			"X-Api-Key": incomingApiKey ?? options.apiKey,
		};
	}
}

type AnthropicCacheControl = NonNullable<TextBlockParam["cache_control"]>;
type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function normalizeAnthropicImageMediaType(mimeType: string): AnthropicImageMediaType | undefined {
	const normalized = mimeType.trim().toLowerCase();
	if (normalized === "image/jpg") return "image/jpeg";
	if (
		normalized === "image/jpeg" ||
		normalized === "image/png" ||
		normalized === "image/gif" ||
		normalized === "image/webp"
	) {
		return normalized;
	}
	return undefined;
}

function cloneAnthropicCacheControl(cacheControl: AnthropicCacheControl): AnthropicCacheControl {
	return { ...cacheControl };
}

type AnthropicOutputConfig = NonNullable<MessageCreateParamsStreaming["output_config"]>;

const ANTHROPIC_STOP_SEQUENCES_MAX = 4;
let warnedStopSequencesTrim = false;

const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	fastModeDisabled: boolean;
	replayUnsignedThinkingDisabled: boolean;
	cacheTracker: CacheTrackerState;
};

function createAnthropicProviderSessionState(): AnthropicProviderSessionState {
	const state: AnthropicProviderSessionState = {
		strictToolsDisabled: false,
		fastModeDisabled: false,
		replayUnsignedThinkingDisabled: false,
		cacheTracker: createCacheTrackerState(),
		close: () => {
			state.strictToolsDisabled = false;
			state.fastModeDisabled = false;
			state.replayUnsignedThinkingDisabled = false;
			state.cacheTracker = createCacheTrackerState();
		},
	};
	return state;
}

function anthropicProviderSessionStateKey(baseUrl: string, modelId: string): string {
	return `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:${baseUrl}\u0000${modelId}`;
}

function getAnthropicProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	baseUrl: string,
	modelId: string,
): AnthropicProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = anthropicProviderSessionStateKey(baseUrl, modelId);
	const existing = providerSessionState.get(key) as AnthropicProviderSessionState | undefined;
	if (existing) return existing;
	const created = createAnthropicProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;

	const prefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, value] of providerSessionState) {
		if (key !== ANTHROPIC_PROVIDER_SESSION_STATE_KEY && !key.startsWith(prefix)) continue;
		(value as AnthropicProviderSessionState).fastModeDisabled = false;
	}
}

function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	return params.tools?.some(tool => tool.strict === true) ?? false;
}

function dropAnthropicFastMode(params: MessageCreateParamsStreaming): void {
	delete params.speed;
}

function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	if (!params.tools) return;
	for (const tool of params.tools) {
		delete tool.strict;
	}
}

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention: CacheRetention | undefined,
	isOAuthToken: boolean,
): { retention: CacheRetention; cacheControl?: AnthropicCacheControl } {
	const retention = cacheRetention ?? (isOAuthToken ? "long" : resolveCacheRetention(undefined));
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && model.compat.supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

export { CLAUDE_CODE_VERSION as claudeCodeVersion } from "@veyyon/catalog/wire/anthropic";
export const claudeAgentSdkVersion = "0.3.165";
export const claudeClientVersion = "1.11187.4";
export const claudeToolPrefix: string = "_";
export const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;

function anthropicWire(model: Pick<Model<"anthropic-messages">, "provider">): ProviderAnthropicMessagesCapability {
	return providerWireCapabilities(model.provider)?.anthropicMessages ?? {};
}

export function mapStainlessOs(platform: string): "MacOS" | "Windows" | "Linux" | "FreeBSD" | `Other::${string}` {
	switch (platform.toLowerCase()) {
		case "darwin":
			return "MacOS";
		case "windows":
		case "win32":
			return "Windows";
		case "linux":
			return "Linux";
		case "freebsd":
			return "FreeBSD";
		default:
			return `Other::${platform.toLowerCase()}`;
	}
}

export function mapStainlessArch(arch: string): "x64" | "arm64" | "x86" | `other::${string}` {
	switch (arch.toLowerCase()) {
		case "amd64":
		case "x64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "386":
		case "x86":
		case "ia32":
			return "x86";
		default:
			return `other::${arch.toLowerCase()}`;
	}
}

export const claudeCodeHeaders = {
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.3.0",
	"X-Stainless-Package-Version": "0.94.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": mapStainlessArch(process.arch),
	"X-Stainless-OS": mapStainlessOs(process.platform),
	"X-Stainless-Timeout": "900",
	"anthropic-client-platform": "desktop_app",
	"anthropic-client-version": claudeClientVersion,
};

const enforcedHeaderKeys = new Set(
	[
		...Object.keys(claudeCodeHeaders),
		"Accept",
		"Accept-Encoding",
		"Connection",
		"Content-Type",
		"anthropic-version",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-beta",
		"User-Agent",
		"x-app",
		"Authorization",
		"X-Api-Key",
		"X-Claude-Code-Session-Id",
		"x-client-request-id",
		"cf-aig-authorization",
	].map(key => key.toLowerCase()),
);

const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

function createClaudeBillingHeader(firstUserMessageText: string): string {
	const k = [4, 7, 20].map(i => firstUserMessageText[i] ?? "0").join("");
	const versionSuffix = nodeCrypto
		.createHash("sha256")
		.update(`59cf53e54c78${k}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER_STR};`;
}

const CCH_SEED = 0x4d659218e32a3268n;
const CCH_PLACEHOLDER_STR = "cch=00000";
const cchEncoder = new TextEncoder();
const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);
const BILLING_SYSTEM_MARKER = cchEncoder.encode(`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`);
const CCH_BILLING_SEARCH_WINDOW = 150;

function patchCch(body: Uint8Array): "patched" | "no-billing-header" | "unanchored" {
	const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);

	const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER);
	if (markerIdx === -1) return "no-billing-header"; // no CC billing header injected

	const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length;
	const idx = view.indexOf(CCH_PLACEHOLDER, searchFrom);
	if (idx === -1 || idx - searchFrom > CCH_BILLING_SEARCH_WINDOW) return "unanchored";

	const h = Bun.hash.xxHash64(body, CCH_SEED);
	const cch = (h & 0xfffffn).toString(16).padStart(5, "0");

	for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i);
	return "patched";
}

export function wrapFetchForCch(base: FetchImpl): FetchImpl {
	return (input, init) => {
		if (init?.body && typeof init.body === "string" && init.body.includes(CCH_PLACEHOLDER_STR)) {
			const encoded = cchEncoder.encode(init.body);
			if (patchCch(encoded) === "unanchored") {
				logger.warn("anthropic: cch billing placeholder present but not patched; sending unattested request");
			}
			return base(input, { ...init, body: encoded });
		}
		return base(input, init);
	};
}

const CLAUDE_CLOAKING_USER_ID_REGEX =
	/^user_[0-9a-fA-F]{64}_account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeCloakingUserId(userId: string): boolean {
	return CLAUDE_CLOAKING_USER_ID_REGEX.test(userId);
}

function isClaudeJsonUserId(userId: string): boolean {
	if (userId.length === 0 || userId[0] !== "{") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return false;
	}
	if (!isRecord(parsed)) return false;
	const obj = parsed as Record<string, unknown>;
	return typeof obj.session_id === "string" && obj.session_id.length > 0;
}

function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
	if (typeof userId !== "string") return undefined;
	if (isClaudeCloakingUserId(userId)) {
		return userId.slice(userId.lastIndexOf("_session_") + "_session_".length);
	}
	if (userId.length === 0 || userId[0] !== "{") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(userId);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const sessionId = (parsed as Record<string, unknown>).session_id;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

export function generateClaudeCloakingUserId(): string {
	const userHash = nodeCrypto.randomBytes(32).toString("hex");
	const accountId = nodeCrypto.randomUUID().toLowerCase();
	const sessionId = nodeCrypto.randomUUID().toLowerCase();
	return `user_${userHash}_account_${accountId}_session_${sessionId}`;
}

const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "veyyon-claude-device-id-v1:";
const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "veyyon-claude-device-id-v2";

export function deriveClaudeDeviceId(installId: string, accountId?: string): string {
	const hash = nodeCrypto.createHash("sha256");
	if (accountId && accountId.length > 0) {
		return hash
			.update(CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN)
			.update("\0")
			.update(installId)
			.update("\0")
			.update(accountId)
			.digest("hex");
	}
	return hash.update(CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN).update(installId).digest("hex");
}

function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readAnthropicMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
	return (
		readMetadataString(metadata, "account_uuid") ??
		readMetadataString(metadata, "accountId") ??
		readMetadataString(metadata, "account_id")
	);
}

function deriveClaudeDeviceIdFromInstallId(accountId?: string): string {
	return deriveClaudeDeviceId(getInstallId(), accountId);
}

function generateClaudeJsonUserId(sessionId?: string, accountId?: string): string {
	const userId: Record<string, string> = {
		device_id: deriveClaudeDeviceIdFromInstallId(accountId),
		session_id: sessionId ?? nodeCrypto.randomUUID().toLowerCase(),
	};
	if (accountId && accountId.length > 0) userId.account_uuid = accountId;
	return JSON.stringify(userId);
}

export function resolveAnthropicMetadataUserId(
	userId: unknown,
	isOAuthToken: boolean,
	sessionId?: string,
	accountId?: string,
): string | undefined {
	if (typeof userId === "string") {
		if (!isOAuthToken || isClaudeCloakingUserId(userId) || isClaudeJsonUserId(userId)) {
			return userId;
		}
	}

	if (!isOAuthToken) return undefined;
	return generateClaudeJsonUserId(sessionId, accountId);
}

const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set([ANTHROPIC_WEB_SEARCH_TOOL, "code_execution", "text_editor", "computer"]);
const UMANS_WEBSEARCH_PROVIDER_HEADER = "X-Umans-Websearch-Provider";
export const applyClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (ANTHROPIC_BUILTIN_TOOL_NAMES.has(name.toLowerCase())) return name;

	return `${claudeToolPrefix}${name}`;
};

export const stripClaudeToolPrefix = (name: string): string => {
	if (!claudeToolPrefix) return name;
	if (!name.toLowerCase().startsWith(claudeToolPrefix.toLowerCase())) return name;
	return name.slice(claudeToolPrefix.length);
};

function normalizeUmansWebSearchProvider(value: string | undefined): "native" | "exa" | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "native" || normalized === "exa" ? normalized : undefined;
}

function getUmansWebSearchProvider(headers: Record<string, string> | undefined): "native" | "exa" | undefined {
	const explicit = getHeaderCaseInsensitive(headers, UMANS_WEBSEARCH_PROVIDER_HEADER);
	if (explicit !== undefined) return normalizeUmansWebSearchProvider(explicit);
	return normalizeUmansWebSearchProvider($env.UMANS_WEBSEARCH_PROVIDER);
}

function isUmansAnthropicModel(model: Model<"anthropic-messages">): boolean {
	return anthropicWire(model).gatewayWebSearch === true || model.baseUrl.toLowerCase().includes("api.code.umans.ai");
}

function getUmansWebSearchHeader(
	model: Model<"anthropic-messages">,
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!isUmansAnthropicModel(model)) return undefined;
	const provider = getUmansWebSearchProvider(headers);
	return provider ? { [UMANS_WEBSEARCH_PROVIDER_HEADER]: provider } : undefined;
}

function shouldUseUmansGatewayWebSearch(name: string, enabled: boolean): boolean {
	return enabled && name.toLowerCase() === ANTHROPIC_WEB_SEARCH_TOOL;
}

function encodeAnthropicToolName(
	name: string,
	isOAuthToken: boolean,
	escapeBuiltinToolNames: boolean,
	useUmansGatewayWebSearch = false,
): string {
	if (shouldUseUmansGatewayWebSearch(name, useUmansGatewayWebSearch)) return name;
	if (escapeBuiltinToolNames) return `${claudeToolPrefix}${name}`;
	return isOAuthToken ? applyClaudeToolPrefix(name) : name;
}

function decodeAnthropicToolName(name: string, isOAuthToken: boolean, escapeBuiltinToolNames: boolean): string {
	if (isOAuthToken || escapeBuiltinToolNames) return stripClaudeToolPrefix(name);
	return name;
}

const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
const ANTHROPIC_MANY_IMAGE_MAX_DIMENSION = 2000;

function countAnthropicImageBlocks(messages: Message[]): number {
	let count = 0;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

const ANTHROPIC_IMAGE_RESIZE_CONCURRENCY = 4;

const anthropicManyImageResizeCache = new WeakMap<ImageContent, ImageContent>();

type ResizeLimiter = <R>(fn: () => Promise<R>) => Promise<R>;

function createResizeLimiter(limit: number): ResizeLimiter {
	let active = 0;
	const queue: (() => void)[] = [];
	return async fn => {
		if (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			queue.push(resolve);
			await promise;
		} else {
			active++;
		}
		try {
			return await fn();
		} finally {
			const next = queue.shift();
			if (next) next();
			else active--;
		}
	};
}

async function resizeAnthropicManyImageBlock(block: ImageContent): Promise<ImageContent> {
	try {
		const inputBuffer = Buffer.from(block.data, "base64");
		const { width, height } = await new Bun.Image(inputBuffer).metadata();
		if (!width || !height) return block;
		if (width <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION && height <= ANTHROPIC_MANY_IMAGE_MAX_DIMENSION) return block;

		const scale = Math.min(ANTHROPIC_MANY_IMAGE_MAX_DIMENSION / width, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION / height);
		const targetWidth = clampLow(Math.round(width * scale), 1, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION);
		const targetHeight = clampLow(Math.round(height * scale), 1, ANTHROPIC_MANY_IMAGE_MAX_DIMENSION);

		const [png, jpeg] = await Promise.all([
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).png().bytes(),
			new Bun.Image(inputBuffer).resize(targetWidth, targetHeight).jpeg({ quality: 85 }).bytes(),
		]);
		const best =
			png.length <= jpeg.length ? { buffer: png, mimeType: "image/png" } : { buffer: jpeg, mimeType: "image/jpeg" };

		return {
			type: "image",
			data: Buffer.from(best.buffer).toString("base64"),
			mimeType: best.mimeType,
		};
	} catch (error) {
		logger.warn("anthropic: failed to resize oversized image for many-image request", {
			mimeType: block.mimeType,
			error: errorMessage(error),
		});
		return block;
	}
}

async function resizeAnthropicManyImageContent(
	content: (TextContent | ImageContent)[],
	state: { resized: number },
	limit: ResizeLimiter,
): Promise<(TextContent | ImageContent)[]> {
	let changed = false;
	const next = await Promise.all(
		content.map(async block => {
			if (block.type !== "image") return block;
			let resized = anthropicManyImageResizeCache.get(block);
			if (resized === undefined) {
				resized = await limit(() => resizeAnthropicManyImageBlock(block));
				anthropicManyImageResizeCache.set(block, resized);
			}
			if (resized !== block) {
				changed = true;
				state.resized++;
			}
			return resized;
		}),
	);
	return changed ? next : content;
}

async function resizeAnthropicManyImageMessage(
	message: Message,
	state: { resized: number },
	limit: ResizeLimiter,
): Promise<Message> {
	if (message.role === "user" || message.role === "developer") {
		if (!Array.isArray(message.content)) return message;
		const content = await resizeAnthropicManyImageContent(message.content, state, limit);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role === "toolResult") {
		const content = await resizeAnthropicManyImageContent(message.content, state, limit);
		return content === message.content ? message : { ...message, content };
	}
	return message;
}

async function prepareAnthropicManyImageContext(context: Context, supportsImages: boolean): Promise<Context> {
	if (!supportsImages) return context;
	const imageCount = countAnthropicImageBlocks(context.messages);
	if (imageCount <= ANTHROPIC_MANY_IMAGE_THRESHOLD) return context;

	let changed = false;
	const state = { resized: 0 };
	const limit = createResizeLimiter(ANTHROPIC_IMAGE_RESIZE_CONCURRENCY);
	const messages = await Promise.all(
		context.messages.map(async message => {
			const next = await resizeAnthropicManyImageMessage(message, state, limit);
			if (next !== message) changed = true;
			return next;
		}),
	);
	if (!changed) return context;
	logger.debug("anthropic: resized oversized images for many-image request", {
		imageCount,
		resized: state.resized,
		maxDimension: ANTHROPIC_MANY_IMAGE_MAX_DIMENSION,
	});
	return { ...context, messages };
}

type AnthropicToolResultContent =
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: AnthropicImageMediaType;
						data: string;
					};
			  }
	  >;

function convertContentBlocks(
	content: (TextContent | ImageContent)[],
	supportsImages = true,
): AnthropicToolResultContent {
	const blocks: Array<
		| { type: "text"; text: string }
		| {
				type: "image";
				source: {
					type: "base64";
					media_type: AnthropicImageMediaType;
					data: string;
				};
		  }
	> = [];
	let sawText = false;
	let sawImage = false;

	for (const block of content) {
		if (block.type === "text") {
			const text = block.text.toWellFormed();
			if (text.trim().length === 0) continue;
			sawText = true;
			blocks.push({ type: "text", text });
			continue;
		}

		if (!supportsImages) {
			blocks.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
			continue;
		}

		const mediaType = normalizeAnthropicImageMediaType(block.mimeType);
		if (!mediaType) {
			blocks.push({ type: "text", text: `[unsupported image: ${block.mimeType}]` });
			continue;
		}

		sawImage = true;
		blocks.push({
			type: "image",
			source: {
				type: "base64",
				media_type: mediaType,
				data: block.data,
			},
		});
	}

	if (!supportsImages) {
		return blocks
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.toWellFormed();
	}

	if (sawImage && !sawText) {
		blocks.unshift({
			type: "text",
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicEffort = AnthropicOutputEffort | "adaptive";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

export interface AnthropicOptions extends StreamOptions {
	thinkingEnabled?: boolean;

	thinkingBudgetTokens?: number;

	requestModelId?: string;

	effort?: AnthropicEffort;

	reasoning?: SimpleStreamOptions["reasoning"];

	thinkingDisplay?: AnthropicThinkingDisplay;
	interleavedThinking?: boolean;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	betas?: string[] | string;

	serviceTier?: ServiceTier;

	isOAuth?: boolean;

	client?: AnthropicMessagesClientLike;

	fallbacks?: FallbackParam[];
}

export type AnthropicClientOptionsArgs = {
	model: Model<"anthropic-messages">;
	apiKey: string;
	extraBetas?: string[];
	stream?: boolean;
	interleavedThinking?: boolean;
	headers?: Record<string, string>;
	dynamicHeaders?: Record<string, string>;
	isOAuth?: boolean;
	hasTools?: boolean;
	thinkingEnabled?: boolean;
	thinkingDisplay?: AnthropicThinkingDisplay;
	disableStrictTools?: boolean;
	fetch?: FetchImpl;
	claudeCodeSessionId?: string;
};

export type AnthropicClientOptionsResult = {
	isOAuthToken: boolean;
	apiKey: string | null;
	authToken?: string | null;
	baseURL?: string;
	maxRetries: number;
	defaultHeaders: Record<string, string>;
	fetch?: FetchImpl;
	fetchOptions?: AnthropicFetchOptions;
};

const CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

const CERTIFICATE_EXTENSIONS = ["pem", "crt", "cer", "key"] as const;

const foundryTlsOptionsCache = new Map<string, FoundryTlsOptions | undefined>();

function foundryTlsCacheKeyComponent(value: string | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();

	if (trimmed && !trimmed.includes("-----BEGIN") && looksLikeFilePath(trimmed, CERTIFICATE_EXTENSIONS)) {
		try {
			return `${trimmed}@${fs.statSync(trimmed).mtimeMs}`;
		} catch {
			return trimmed;
		}
	}
	return value;
}

function foundryTlsOptionsCacheKey(): string {
	return JSON.stringify([
		foundryTlsCacheKeyComponent($env.NODE_EXTRA_CA_CERTS),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_CERT),
		foundryTlsCacheKeyComponent($env.CLAUDE_CODE_CLIENT_KEY),
	]);
}

function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
	const wire = anthropicWire(model);
	if (wire.credential === "copilot-bearer") {
		return normalizeAnthropicBaseUrl(resolveGitHubCopilotBaseUrl(model.baseUrl, apiKey) ?? model.baseUrl);
	}
	if (wire.directEndpoint && isFoundryEnabled()) {
		const foundryBaseUrl = normalizeAnthropicBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) {
			return foundryBaseUrl;
		}
	}
	if (wire.directEndpoint) {
		return normalizeAnthropicBaseUrl(model.baseUrl) ?? ANTHROPIC_API_ENDPOINT;
	}
	return normalizeAnthropicBaseUrl(model.baseUrl);
}

function parseAnthropicCustomHeaders(rawHeaders: string | undefined): Record<string, string> | undefined {
	const source = rawHeaders?.trim();
	if (!source) return undefined;

	const parsed: Record<string, string> = {};
	for (const token of source.split(/\r?\n|,/)) {
		const entry = token.trim();
		if (!entry) continue;
		const separatorIndex = entry.indexOf(":");
		if (separatorIndex <= 0) continue;
		const key = entry.slice(0, separatorIndex).trim();
		const value = entry.slice(separatorIndex + 1).trim();
		if (!key || !value) continue;
		parsed[key] = value;
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function resolveAnthropicCustomHeadersForBaseUrl(
	baseUrl: string | undefined,
): Record<string, string> | undefined {
	if (!isFoundryEnabled() && isOfficialAnthropicApiUrl(baseUrl)) return undefined;
	return parseAnthropicCustomHeaders($env.ANTHROPIC_CUSTOM_HEADERS);
}

function resolveAnthropicCustomHeaders(model: Model<"anthropic-messages">): Record<string, string> | undefined {
	if (!anthropicWire(model).directEndpoint) return undefined;
	return resolveAnthropicCustomHeadersForBaseUrl(model.baseUrl);
}

function resolvePemValue(value: string | undefined, name: string): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;

	const inline = trimmed.replace(/\\n/g, "\n");
	if (inline.includes("-----BEGIN")) {
		return inline;
	}

	if (looksLikeFilePath(trimmed, CERTIFICATE_EXTENSIONS)) {
		try {
			return fs.readFileSync(trimmed, "utf8");
		} catch (error) {
			if (isEnoent(error)) {
				throw new AIError.ValidationError(`${name} path does not exist: ${trimmed}`);
			}
			throw error;
		}
	}

	return inline;
}

function resolveFoundryTlsOptions(model: Model<"anthropic-messages">): FoundryTlsOptions | undefined {
	if (!anthropicWire(model).directEndpoint) return undefined;
	if (!isFoundryEnabled()) return undefined;

	const cacheKey = foundryTlsOptionsCacheKey();
	if (foundryTlsOptionsCache.has(cacheKey)) return foundryTlsOptionsCache.get(cacheKey);

	const ca = resolvePemValue($env.NODE_EXTRA_CA_CERTS, "NODE_EXTRA_CA_CERTS");
	const cert = resolvePemValue($env.CLAUDE_CODE_CLIENT_CERT, "CLAUDE_CODE_CLIENT_CERT");
	const key = resolvePemValue($env.CLAUDE_CODE_CLIENT_KEY, "CLAUDE_CODE_CLIENT_KEY");

	if ((cert && !key) || (!cert && key)) {
		throw new AIError.ConfigurationError(
			"Both CLAUDE_CODE_CLIENT_CERT and CLAUDE_CODE_CLIENT_KEY must be set for mTLS.",
		);
	}

	const options: FoundryTlsOptions = {};
	if (ca) options.ca = tls.rootCertificates.concat([ca]);
	if (cert) options.cert = cert;
	if (key) options.key = key;
	const resolved = Object.keys(options).length > 0 ? options : undefined;
	foundryTlsOptionsCache.set(cacheKey, resolved);
	return resolved;
}

function buildClaudeCodeTlsFetchOptions(
	model: Model<"anthropic-messages">,
	baseUrl: string | undefined,
): AnthropicFetchOptions | undefined {
	if (!anthropicWire(model).directEndpoint) return undefined;
	if (!baseUrl) return undefined;

	let serverName: string;
	try {
		serverName = new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}

	if (!serverName) return undefined;

	const foundryTlsOptions = resolveFoundryTlsOptions(model);

	return {
		tls: {
			rejectUnauthorized: true,
			serverName,
			...(CLAUDE_CODE_TLS_CIPHERS ? { ciphers: CLAUDE_CODE_TLS_CIPHERS } : {}),
			...(foundryTlsOptions ?? {}),
		},
	};
}
function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
	const merged: Record<string, string> = {};
	const keyByLower = new Map<string, string>();
	for (const headers of headerSources) {
		if (!headers) continue;
		for (const [key, value] of Object.entries(headers)) {
			const lower = key.toLowerCase();
			const existing = keyByLower.get(lower);
			if (existing !== undefined && existing !== key) delete merged[existing];
			keyByLower.set(lower, key);
			merged[key] = value;
		}
	}
	return merged;
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

type RawMessagePingEvent = { type: "ping" };
type AnthropicStreamEvent = RawMessageStreamEvent | RawMessagePingEvent;
const ANTHROPIC_PING_EVENT: RawMessagePingEvent = { type: "ping" };

function createAnthropicSseStreamError(data: string): Error {
	try {
		const parsed = JSON.parse(data) as { error?: { type?: unknown; message?: unknown } };
		const errorType = typeof parsed?.error?.type === "string" ? parsed.error.type : undefined;
		const message = typeof parsed?.error?.message === "string" ? parsed.error.message : undefined;
		if (message) {
			return new AIError.ProviderResponseError(
				errorType ? `Anthropic stream error (${errorType}): ${message}` : `Anthropic stream error: ${message}`,
				{ provider: "anthropic", kind: "output" },
			);
		}
	} catch {}
	return new AIError.ProviderResponseError(data, { provider: "anthropic", kind: "output" });
}

export async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): AsyncGenerator<AnthropicStreamEvent> {
	if (!response.body) {
		throw new AIError.AnthropicStreamEnvelopeError("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	let droppedFrames = 0;
	let yieldedEvents = 0;

	for await (const sse of readSseEvents(response.body, signal)) {
		notifyRawSseEvent(onSseEvent, sse);
		if (sse.event === "error") {
			throw createAnthropicSseStreamError(sse.data);
		}

		if (sse.event === "ping") {
			yield ANTHROPIC_PING_EVENT;
			continue;
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = JSON.parse(sse.data) as RawMessageStreamEvent;
			if (event.type !== sse.event) {
				reportAnthropicEnvelopeAnomaly(`event type ${event.type} does not match SSE event ${sse.event}`);
			}
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yieldedEvents++;
			yield event;
		} catch (error) {
			droppedFrames++;
			const message = errorMessage(error);
			reportAnthropicEnvelopeAnomaly(
				`could not parse SSE event ${sse.event}: ${message}; skipping frame; data=${sse.data}`,
			);
		}
	}

	if (droppedFrames > 0 && yieldedEvents === 0 && !signal?.aborted) {
		throw new AIError.AnthropicStreamEnvelopeError(
			`Anthropic stream carried ${droppedFrames} event(s) and none of them could be parsed, so the turn produced no content`,
		);
	}

	if (sawMessageStart && !sawMessageEnd && !signal?.aborted) {
		reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
	}
}

type AnthropicRawResponseRequest = {
	asResponse(): Promise<Response>;
};

function hasAnthropicRawResponseRequest(request: unknown): request is AnthropicRawResponseRequest {
	return isRecord(request) && typeof request.asResponse === "function";
}

type AnthropicStreamWithResponseRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<RawMessageStreamEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

function hasAnthropicStreamWithResponseRequest(request: unknown): request is AnthropicStreamWithResponseRequest {
	return isRecord(request) && typeof request.withResponse === "function";
}

async function getAnthropicStreamResponse(
	request: unknown,
	signal?: AbortSignal,
	onSseEvent?: AnthropicOptions["onSseEvent"],
): Promise<{
	events: AsyncIterable<AnthropicStreamEvent>;
	response: Response;
	requestId: string | null;
	recordsRawSseEvents: boolean;
}> {
	if (hasAnthropicRawResponseRequest(request)) {
		const response = await request.asResponse();
		return {
			events: iterateAnthropicEvents(response, signal, onSseEvent),
			response,
			requestId: response.headers.get("request-id"),
			recordsRawSseEvents: true,
		};
	}
	if (hasAnthropicStreamWithResponseRequest(request)) {
		const { data, response, request_id } = await request.withResponse();
		return { events: data, response, requestId: request_id, recordsRawSseEvents: false };
	}
	throw new AIError.AnthropicStreamEnvelopeError("Anthropic SDK request did not expose a stream response");
}

async function* observeDecodedAnthropicSdkEvents(
	events: AsyncIterable<AnthropicStreamEvent>,
	observer: (event: RawSseEvent) => void,
): AsyncGenerator<AnthropicStreamEvent> {
	for await (const event of events) {
		const data = JSON.stringify(event);

		notifyRawSseEvent(observer, { event: event.type, data, raw: [`event: ${event.type}`, `data: ${data}`] });
		yield event;
	}
}

const PROVIDER_MAX_RETRIES = 10;

const PING_PROGRESS_MAX_IDLE_MULTIPLIER = 3;

function reportAnthropicEnvelopeAnomaly(detail: string): void {
	logger.warn(`anthropic: ignoring malformed stream envelope: ${detail}`);
}

function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
	if (typeof eventType !== "string") return false;
	if (eventType === "ping") return true;
	return !ANTHROPIC_MESSAGE_EVENTS.has(eventType);
}

export function isAnthropicStreamRetryable(error: unknown, provider?: string): boolean {
	return AIError.isProviderRetryableError(error, {
		provider,
		isProviderTransient: providerWireCapabilities(provider)?.anthropicMessages?.transientModelErrors
			? (err): boolean => AIError.isCopilotTransientModelError(err)
			: undefined,
	});
}

function unwrapAnthropicThinkingEnvelope(text: string): string | undefined {
	let current = text.trim();
	let stripped = false;
	while (current.startsWith(XML_THINKING_OPEN) && current.endsWith(XML_THINKING_CLOSE)) {
		current = current.slice(XML_THINKING_OPEN.length, current.length - XML_THINKING_CLOSE.length).trim();
		stripped = true;
	}
	return stripped ? current : undefined;
}

function createEmptyUsage(premiumRequests?: number): Usage {
	const usage = emptyUsage();
	if (premiumRequests !== undefined) usage.premiumRequests = premiumRequests;
	return usage;
}

function discardAnthropicAttempt(
	model: Model<"anthropic-messages">,
	output: AssistantMessage,
	premiumRequests?: number,
): void {
	output.content.length = 0;
	output.model = model.id;
	output.responseId = undefined;
	output.errorMessage = undefined;
	output.stopDetails = undefined;
	output.providerPayload = undefined;
	output.usage = discardAttemptUsage(model, output.usage, createEmptyUsage(premiumRequests));
	output.stopReason = "stop";
}

export type AnthropicUsageLike = {
	cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
	server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null;
};

export function applyAnthropicUsageExtras(usage: Usage, source: AnthropicUsageLike): void {
	const cacheCreation = source.cache_creation;
	if (cacheCreation != null) {
		const fiveMinute = cacheCreation.ephemeral_5m_input_tokens ?? 0;
		const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
		if (fiveMinute > 0 || oneHour > 0) {
			usage.cttl = {
				...(fiveMinute > 0 ? { ephemeral5m: fiveMinute } : {}),
				...(oneHour > 0 ? { ephemeral1h: oneHour } : {}),
			};
		} else {
			delete usage.cttl;
		}
	}
	const serverToolUse = source.server_tool_use;
	if (serverToolUse != null) {
		const webSearch = serverToolUse.web_search_requests ?? 0;
		const webFetch = serverToolUse.web_fetch_requests ?? 0;
		if (webSearch > 0 || webFetch > 0) {
			usage.server = {
				...(webSearch > 0 ? { webSearch } : {}),
				...(webFetch > 0 ? { webFetch } : {}),
			};
		} else {
			delete usage.server;
		}
	}
}

function parseAnthropicFallbackWireBlock(value: unknown): AnthropicFallbackContent | undefined {
	if (!isRecord(value) || value.type !== "fallback") return undefined;
	const from = isRecord(value.from) && typeof value.from.model === "string" ? value.from.model : undefined;
	const to = isRecord(value.to) && typeof value.to.model === "string" ? value.to.model : undefined;
	if (!from?.trim() || !to?.trim()) return undefined;
	return { type: "fallback", from: { model: from }, to: { model: to } };
}

function fallbackServedModelFromUsage(source: AnthropicWireUsage): string | undefined {
	const iterations = source.iterations ?? [];
	for (let index = iterations.length - 1; index >= 0; index -= 1) {
		const iteration = iterations[index];
		if (iteration?.type === "fallback_message" && iteration.model?.trim()) return iteration.model;
	}
	return undefined;
}

function resolveIterationModel(
	requestModel: Model<"anthropic-messages">,
	iterationModelId: string | null | undefined,
): Model<Api> {
	const id = iterationModelId?.trim();
	if (!id || id === requestModel.id) return requestModel;

	if (requestModel.provider === "anthropic") {
		const bundled = getBundledModel("anthropic", id);
		if (bundled?.api === "anthropic-messages") return bundled;
	}
	return requestModel;
}

function calculateFallbackTurnCost(
	requestModel: Model<"anthropic-messages">,
	usage: Usage,
	source: AnthropicWireUsage,
): boolean {
	const iterations = source.iterations ?? [];
	if (iterations.length === 0) return false;
	const cost = emptyCost();
	const hasFallbackMessage = iterations.some(iter => iter.type === "fallback_message");
	let applied = false;
	for (const iteration of iterations) {
		const inputTokens = iteration.input_tokens ?? 0;
		const outputTokens = iteration.output_tokens ?? 0;
		const cacheReadTokens = iteration.cache_read_input_tokens ?? 0;
		const cacheWriteTokens = iteration.cache_creation_input_tokens ?? 0;
		const isFallback = iteration.type === "fallback_message";
		if (hasFallbackMessage && !isFallback && outputTokens === 0 && cacheWriteTokens === 0) continue;
		const iterationUsage = createEmptyUsage();
		if (isFallback) {
			iterationUsage.input = 0;
			iterationUsage.cacheRead = cacheReadTokens + inputTokens;
		} else {
			iterationUsage.input = inputTokens;
			iterationUsage.cacheRead = cacheReadTokens;
		}
		iterationUsage.output = outputTokens;
		iterationUsage.cacheWrite = cacheWriteTokens;
		iterationUsage.totalTokens =
			iterationUsage.input + iterationUsage.output + iterationUsage.cacheRead + iterationUsage.cacheWrite;
		calculateCost(resolveIterationModel(requestModel, iteration.model), iterationUsage);
		cost.input += iterationUsage.cost.input;
		cost.output += iterationUsage.cost.output;
		cost.cacheRead += iterationUsage.cost.cacheRead;
		cost.cacheWrite += iterationUsage.cost.cacheWrite;
		cost.total += iterationUsage.cost.total;
		applied = true;
	}
	if (!applied) return false;
	usage.cost = cost;
	return true;
}

const INVALID_THINKING_SIGNATURE_PATTERN = /invalid\s+`?signature`?\s+in\s+`?thinking`?(?:\s+block)?/i;
export function isInvalidThinkingSignatureError(message: string): boolean {
	return INVALID_THINKING_SIGNATURE_PATTERN.test(message);
}

export function maybeAddReplayUnsignedThinkingHint(model: Model<"anthropic-messages">, message: string): string {
	if (!isInvalidThinkingSignatureError(message)) return message;
	if (model.compat.officialEndpoint) return message;
	if (model.compatConfig?.replayUnsignedThinking !== undefined) return message;
	const hint = `Provider "${model.provider}" looks like an Anthropic-compatible signing proxy: it rejected a replayed unsigned thinking block. Set \`compat.replayUnsignedThinking: false\` under \`providers.${model.provider}\` in your models.yml and retry.`;
	return `${hint}\n\n${message}`;
}

type AnthropicStreamBlock = (
	| ThinkingContent
	| RedactedThinkingContent
	| TextContent
	| AnthropicFallbackContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number })
) & { [kStreamingBlockIndex]: number };

interface AnthropicStreamContext {
	model: Model<"anthropic-messages">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	serverSideFallback: boolean;
	isOAuthToken: boolean;
	openBlocks: Map<
		number,
		{
			contentIndex: number;
			kind: "text" | "thinking" | "redactedThinking" | "fallback" | "toolCall" | "ignored";
		}
	>;
	closedBlockIndexes: Set<number>;
	blocks: AnthropicStreamBlock[];
	firstTokenTime?: number;
	streamedReplayUnsafeContent: boolean;
	sawEvent: boolean;
	sawMessageStart: boolean;
	sawTerminalEnvelope: boolean;
	sawMessageStop: boolean;
	sawSplicedEnvelope: boolean;
}

function finalizeAnthropicStreamBlock(
	block: AnthropicStreamBlock,
	contentIndex: number,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	if (block.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
	} else if (block.type === "thinking") {
		const unwrappedThinking = unwrapAnthropicThinkingEnvelope(block.thinking);
		if (unwrappedThinking !== undefined) {
			block.thinking = unwrappedThinking;
			block.thinkingSignature = undefined;
		}
		stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
	} else if (block.type === "toolCall") {
		const finalJson =
			block[kStreamingPartialJson].length > 0 ? block[kStreamingPartialJson] : JSON.stringify(block.arguments ?? {});
		try {
			block.arguments = parseJsonWithRepair(finalJson) as ToolCall["arguments"];
		} catch (parseError) {
			reportAnthropicEnvelopeAnomaly(
				`tool_use ${block.id} arguments are not valid JSON: ${errorMessage(parseError)}`,
			);
			const recoveredKeys = Object.keys(block.arguments ?? {});
			if (recoveredKeys.length === 0) {
				const maxLen = 512;
				const truncatedJson =
					finalJson.length <= maxLen
						? finalJson
						: `${finalJson.slice(0, maxLen)}… [truncated ${finalJson.length - maxLen} chars]`;
				block.arguments = {
					__parseError: errorMessage(parseError),
					__rawJson: truncatedJson,
				};
			}
		}
		clearStreamingPartialJson(block);
		stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
	}
}

function resolveAnthropicStreamBetas(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions | undefined,
	dropFastMode: boolean,
): string[] {
	const extraBetas = normalizeExtraBetas(options?.betas);
	const wantsAnthropicPriority = realizesPriorityServiceTier(options?.serviceTier, model);
	if (wantsAnthropicPriority && !dropFastMode && !extraBetas.includes(fastModeBeta)) {
		extraBetas.push(fastModeBeta);
	}
	if (options?.taskBudget && !extraBetas.includes(taskBudgetBeta)) {
		extraBetas.push(taskBudgetBeta);
	}
	const sendsAdaptiveEffortPin =
		options?.thinkingEnabled === false &&
		model.thinking?.mode === "anthropic-adaptive" &&
		!model.compat.disableAdaptiveThinking &&
		!usesAdaptiveThinkingTagOnly(model);
	if (
		model.reasoning &&
		((options?.thinkingEnabled && options.effort !== "adaptive") || sendsAdaptiveEffortPin) &&
		!extraBetas.includes(effortBeta)
	) {
		extraBetas.push(effortBeta);
	}
	if (model.compat.supportsMidConversationSystem && !extraBetas.includes(midConversationSystemBeta)) {
		extraBetas.push(midConversationSystemBeta);
	}
	if (
		model.reasoning &&
		options?.thinkingEnabled &&
		!anthropicWire(model).rejectsContextManagement &&
		!extraBetas.includes(contextManagementBeta)
	) {
		extraBetas.push(contextManagementBeta);
	}
	if (options?.fallbacks?.length) {
		if (!extraBetas.includes(serverSideFallbackBeta)) {
			extraBetas.push(serverSideFallbackBeta);
		}
		for (const entry of options.fallbacks) {
			if (entry.speed === "fast" && !extraBetas.includes(fastModeBeta)) {
				extraBetas.push(fastModeBeta);
			}
			if (entry.output_config?.effort && !extraBetas.includes(effortBeta)) {
				extraBetas.push(effortBeta);
			}
			if (entry.output_config?.task_budget && !extraBetas.includes(taskBudgetBeta)) {
				extraBetas.push(taskBudgetBeta);
			}
		}
	}
	return extraBetas;
}

function handleAnthropicMessageStartEvent(
	event: Extract<AnthropicStreamEvent, { type: "message_start" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawMessageStart) {
		reportAnthropicEnvelopeAnomaly("duplicate message_start event");
		ctx.sawSplicedEnvelope = true;
		return;
	}
	ctx.sawMessageStart = true;
	const startMessage = event.message;
	if (startMessage?.id) ctx.output.responseId = startMessage.id;
	const startUsage = startMessage?.usage;
	if (startUsage) {
		applyAnthropicUsageExtras(ctx.output.usage, startUsage);
		ctx.output.usage.input = startUsage.input_tokens || 0;
		ctx.output.usage.output = startUsage.output_tokens || 0;
		ctx.output.usage.cacheRead = startUsage.cache_read_input_tokens || 0;
		ctx.output.usage.cacheWrite = startUsage.cache_creation_input_tokens || 0;
		ctx.output.usage.totalTokens =
			ctx.output.usage.input + ctx.output.usage.output + ctx.output.usage.cacheRead + ctx.output.usage.cacheWrite;
		if (ctx.serverSideFallback) {
			const served = fallbackServedModelFromUsage(startUsage);
			if (served) ctx.output.model = served;
			if (!calculateFallbackTurnCost(ctx.model, ctx.output.usage, startUsage)) {
				calculateCost(ctx.model, ctx.output.usage);
			}
		} else {
			calculateCost(ctx.model, ctx.output.usage);
		}
	} else {
		reportAnthropicEnvelopeAnomaly("message_start missing usage");
	}
}

function handleAnthropicContentBlockStartEvent(
	event: Extract<AnthropicStreamEvent, { type: "content_block_start" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawTerminalEnvelope) {
		reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
		return;
	}
	if (ctx.openBlocks.has(event.index)) {
		reportAnthropicEnvelopeAnomaly(`duplicate content_block_start index ${event.index}`);
		return;
	}
	if (ctx.sawSplicedEnvelope && ctx.closedBlockIndexes.has(event.index)) {
		reportAnthropicEnvelopeAnomaly(`replayed content_block_start index ${event.index} after duplicate message_start`);
		ctx.openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
		return;
	}
	if (!event.content_block?.type) {
		reportAnthropicEnvelopeAnomaly("content_block_start missing content_block payload");
		return;
	}
	if (!ctx.firstTokenTime) ctx.firstTokenTime = performance.now();
	if (event.content_block.type === "fallback") {
		const fallback = parseAnthropicFallbackWireBlock(event.content_block);
		if (!ctx.serverSideFallback || !fallback) {
			if (!fallback) {
				reportAnthropicEnvelopeAnomaly("fallback content_block missing model refs");
			}
			ctx.openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
			return;
		}
		const block: AnthropicStreamBlock = { ...fallback, [kStreamingBlockIndex]: event.index };
		ctx.output.content.push(block);
		ctx.openBlocks.set(event.index, {
			contentIndex: ctx.output.content.length - 1,
			kind: "fallback",
		});
		ctx.output.model = fallback.to.model;
		return;
	}
	if (event.content_block.type === "text") {
		ctx.streamedReplayUnsafeContent = true;
		const block: AnthropicStreamBlock = { type: "text", text: "", [kStreamingBlockIndex]: event.index };
		ctx.output.content.push(block);
		const contentIndex = ctx.output.content.length - 1;
		ctx.openBlocks.set(event.index, { contentIndex, kind: "text" });
		ctx.stream.push({ type: "text_start", contentIndex, partial: ctx.output });
	} else if (event.content_block.type === "thinking") {
		ctx.streamedReplayUnsafeContent = true;
		const block: AnthropicStreamBlock = {
			type: "thinking",
			thinking: "",
			thinkingSignature: "",
			[kStreamingBlockIndex]: event.index,
		};
		ctx.output.content.push(block);
		const contentIndex = ctx.output.content.length - 1;
		ctx.openBlocks.set(event.index, { contentIndex, kind: "thinking" });
		ctx.stream.push({ type: "thinking_start", contentIndex, partial: ctx.output });
	} else if (event.content_block.type === "redacted_thinking") {
		ctx.streamedReplayUnsafeContent = true;
		const block: AnthropicStreamBlock = {
			type: "redactedThinking",
			data: event.content_block.data,
			[kStreamingBlockIndex]: event.index,
		};
		ctx.output.content.push(block);
		ctx.openBlocks.set(event.index, {
			contentIndex: ctx.output.content.length - 1,
			kind: "redactedThinking",
		});
	} else if (event.content_block.type === "tool_use") {
		ctx.streamedReplayUnsafeContent = true;
		const block: AnthropicStreamBlock = {
			type: "toolCall",
			id: event.content_block.id,
			name: decodeAnthropicToolName(
				event.content_block.name,
				ctx.isOAuthToken,
				ctx.model.compat.escapeBuiltinToolNames,
			),
			arguments: event.content_block.input ?? {},
			[kStreamingPartialJson]: "",
			[kStreamingBlockIndex]: event.index,
		};
		ctx.output.content.push(block);
		const contentIndex = ctx.output.content.length - 1;
		ctx.openBlocks.set(event.index, { contentIndex, kind: "toolCall" });
		ctx.stream.push({ type: "toolcall_start", contentIndex, partial: ctx.output });
	} else {
		ctx.openBlocks.set(event.index, { contentIndex: -1, kind: "ignored" });
	}
}

function handleAnthropicContentBlockDeltaEvent(
	event: Extract<AnthropicStreamEvent, { type: "content_block_delta" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawTerminalEnvelope) {
		reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
		return;
	}
	const openBlock = ctx.openBlocks.get(event.index);
	if (!openBlock) {
		reportAnthropicEnvelopeAnomaly(`received content_block_delta for unopened index ${event.index}`);
		return;
	}
	if (openBlock.kind === "ignored") return;
	if (!event.delta?.type) {
		reportAnthropicEnvelopeAnomaly("content_block_delta missing delta payload");
		return;
	}
	const block = ctx.blocks[openBlock.contentIndex];
	if (event.delta.type === "text_delta") {
		if (openBlock.kind !== "text" || block?.type !== "text") {
			reportAnthropicEnvelopeAnomaly(`received text_delta for ${openBlock.kind} block`);
			return;
		}
		ctx.streamedReplayUnsafeContent = true;
		block.text += event.delta.text;
		ctx.stream.push({
			type: "text_delta",
			contentIndex: openBlock.contentIndex,
			delta: event.delta.text,
			partial: ctx.output,
		});
	} else if (event.delta.type === "thinking_delta") {
		if (openBlock.kind !== "thinking" || block?.type !== "thinking") {
			reportAnthropicEnvelopeAnomaly(`received thinking_delta for ${openBlock.kind} block`);
			return;
		}
		ctx.streamedReplayUnsafeContent = true;
		block.thinking += event.delta.thinking;
		ctx.stream.push({
			type: "thinking_delta",
			contentIndex: openBlock.contentIndex,
			delta: event.delta.thinking,
			partial: ctx.output,
		});
	} else if (event.delta.type === "input_json_delta") {
		if (openBlock.kind !== "toolCall" || block?.type !== "toolCall") {
			reportAnthropicEnvelopeAnomaly(`received input_json_delta for ${openBlock.kind} block`);
			return;
		}
		ctx.streamedReplayUnsafeContent = true;
		block[kStreamingPartialJson] += event.delta.partial_json;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		ctx.stream.push({
			type: "toolcall_delta",
			contentIndex: openBlock.contentIndex,
			delta: event.delta.partial_json,
			partial: ctx.output,
		});
	} else if (event.delta.type === "signature_delta") {
		if (openBlock.kind !== "thinking" || block?.type !== "thinking") {
			reportAnthropicEnvelopeAnomaly(`received signature_delta for ${openBlock.kind} block`);
			return;
		}
		ctx.streamedReplayUnsafeContent = true;
		block.thinkingSignature = block.thinkingSignature || "";
		block.thinkingSignature += event.delta.signature;
	}
}

function handleAnthropicContentBlockStopEvent(
	event: Extract<AnthropicStreamEvent, { type: "content_block_stop" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawTerminalEnvelope) {
		reportAnthropicEnvelopeAnomaly(`received ${event.type} after terminal stop signal`);
		return;
	}
	const openBlock = ctx.openBlocks.get(event.index);
	if (!openBlock) {
		reportAnthropicEnvelopeAnomaly(`received content_block_stop for unopened index ${event.index}`);
		return;
	}
	if (openBlock.kind === "ignored") {
		ctx.openBlocks.delete(event.index);
		return;
	}
	const block = ctx.blocks[openBlock.contentIndex];
	if (!block || block.type !== openBlock.kind) {
		reportAnthropicEnvelopeAnomaly(`content_block_stop kind mismatch for index ${event.index}`);
		ctx.openBlocks.delete(event.index);
		return;
	}
	ctx.openBlocks.delete(event.index);
	ctx.closedBlockIndexes.add(event.index);
	finalizeAnthropicStreamBlock(block, openBlock.contentIndex, ctx.output, ctx.stream);
}

function handleAnthropicMessageDeltaEvent(
	event: Extract<AnthropicStreamEvent, { type: "message_delta" }>,
	ctx: AnthropicStreamContext,
): void {
	if (ctx.sawTerminalEnvelope) {
		reportAnthropicEnvelopeAnomaly("received message_delta after terminal stop signal");
		return;
	}
	const delta = event.delta;
	const rawStopReason = delta?.stop_reason;
	if (rawStopReason) {
		ctx.output.stopReason = mapStopReason(rawStopReason);
		ctx.sawTerminalEnvelope = true;
	}
	if (ctx.output.stopReason === "error") {
		const stopDetails = delta?.stop_details;
		ctx.output.stopDetails = stopDetails ?? (rawStopReason ? { type: rawStopReason } : null);
		if (stopDetails?.type === "refusal") {
			const explanation = stopDetails.explanation?.trim();
			const category = stopDetails.category;
			const label = category ? `Refusal (${category})` : "Refusal";
			ctx.output.errorMessage = explanation ? `${label}: ${explanation}` : label;
		} else if (!ctx.output.errorMessage) {
			ctx.output.errorMessage =
				rawStopReason === "refusal"
					? "Refusal (no details provided)"
					: rawStopReason === "sensitive"
						? "Content flagged by safety filters"
						: `Anthropic stream ended with stop_reason: ${rawStopReason ?? "unknown"}`;
		}
	}
	const deltaUsage = event.usage;
	if (deltaUsage) {
		if (deltaUsage.input_tokens != null) ctx.output.usage.input = deltaUsage.input_tokens;
		if (deltaUsage.output_tokens != null) ctx.output.usage.output = deltaUsage.output_tokens;
		if (deltaUsage.cache_read_input_tokens != null) ctx.output.usage.cacheRead = deltaUsage.cache_read_input_tokens;
		if (deltaUsage.cache_creation_input_tokens != null)
			ctx.output.usage.cacheWrite = deltaUsage.cache_creation_input_tokens;
		applyAnthropicUsageExtras(ctx.output.usage, deltaUsage);
		ctx.output.usage.totalTokens =
			ctx.output.usage.input + ctx.output.usage.output + ctx.output.usage.cacheRead + ctx.output.usage.cacheWrite;
		if (ctx.serverSideFallback) {
			const served = fallbackServedModelFromUsage(deltaUsage);
			if (served) ctx.output.model = served;
			if (!calculateFallbackTurnCost(ctx.model, ctx.output.usage, deltaUsage)) {
				calculateCost(ctx.model, ctx.output.usage);
			}
		} else {
			calculateCost(ctx.model, ctx.output.usage);
		}
	}
}

function processAnthropicStreamEvent(event: AnthropicStreamEvent, ctx: AnthropicStreamContext): void {
	ctx.sawEvent = true;
	if (event.type === "message_start") {
		handleAnthropicMessageStartEvent(event, ctx);
	} else if (!ctx.sawMessageStart) {
		if (!shouldIgnoreAnthropicPreambleEvent(event.type)) {
			throw new AIError.AnthropicStreamEnvelopeError(`received ${event.type} before message_start`);
		}
	} else if (event.type === "content_block_start") {
		handleAnthropicContentBlockStartEvent(event, ctx);
	} else if (event.type === "content_block_delta") {
		handleAnthropicContentBlockDeltaEvent(event, ctx);
	} else if (event.type === "content_block_stop") {
		handleAnthropicContentBlockStopEvent(event, ctx);
	} else if (event.type === "message_delta") {
		handleAnthropicMessageDeltaEvent(event, ctx);
	} else if (event.type === "message_stop") {
		ctx.sawTerminalEnvelope = true;
		ctx.sawMessageStop = true;
	}
}

function finalizeAnthropicStreamTurn(ctx: AnthropicStreamContext, activeAbortTracker: AbortSourceTracker): void {
	const firstEventTimeoutError = activeAbortTracker.getLocalAbortReason();
	if (firstEventTimeoutError) throw firstEventTimeoutError;
	if (activeAbortTracker.wasCallerAbort()) throw new AIError.RequestAbortError();
	if (!ctx.sawEvent || !ctx.sawMessageStart) {
		throw new AIError.AnthropicStreamEnvelopeError("stream ended before message_start");
	}
	if (!ctx.sawMessageStop) {
		reportAnthropicEnvelopeAnomaly("stream ended before message_stop");
	}
	const truncatedMidDelta = ctx.openBlocks.size > 0 && !ctx.sawTerminalEnvelope;
	for (const [openIndex, openBlock] of ctx.openBlocks) {
		reportAnthropicEnvelopeAnomaly(`stream ended with an unterminated ${openBlock.kind} block at index ${openIndex}`);
		if (openBlock.kind === "ignored" || openBlock.contentIndex < 0) continue;
		const danglingBlock = ctx.blocks[openBlock.contentIndex];
		if (danglingBlock) finalizeAnthropicStreamBlock(danglingBlock, openBlock.contentIndex, ctx.output, ctx.stream);
	}
	ctx.openBlocks.clear();
	if (truncatedMidDelta) {
		throw new AIError.AnthropicStreamEnvelopeError(
			"Anthropic stream ended mid-message with an unterminated content block, so the turn is truncated",
		);
	}
	if (ctx.output.stopReason === "aborted" || ctx.output.stopReason === "error") {
		throw new AIError.ProviderResponseError(ctx.output.errorMessage ?? "An unknown error occurred", {
			provider: ctx.model.provider,
			kind: "output",
		});
	}
}

function recordAnthropicCacheResult(
	cacheTracker: CacheTrackerState | undefined,
	cacheTracked: CacheTrackedRequest | undefined,
	cacheEnforcement: CacheEnforcement,
	params: MessageCreateParamsStreaming,
	output: AssistantMessage,
	model: Model<"anthropic-messages">,
): void {
	if (!cacheTracker || !cacheTracked || cacheEnforcement === "off") return;
	const sent = {
		key: cacheTracked.key,
		expectation: { ...cacheTracked.expectation, anchors: countCacheControlBreakpoints(params) },
	};
	const { verdict, decision } = recordCacheOutcome(cacheTracker, sent, output.usage, cacheEnforcement);
	if (decision.report) {
		logger.warn(`anthropic: ${describeCacheVerdict(verdict)}`, {
			model: model.id,
			provider: model.provider,
			verdict: verdict.kind,
			anchors: sent.expectation.anchors,
			willFailNextRequest: decision.failNext,
		});
	}
}

interface AnthropicStreamRetryContext {
	model: Model<"anthropic-messages">;
	output: AssistantMessage;
	options?: AnthropicOptions;
	activeAbortTracker: AbortSourceTracker;
	firstEventBudget: FirstEventBudget;
	idleTimeoutAbortError: AIError.StreamTimeoutError;
	firstTokenTime: number | undefined;
	streamedReplayUnsafeContent: boolean;
	providerRetryAttempt: number;
	copilotDynamicHeaders?: { premiumRequests?: number };
	params: MessageCreateParamsStreaming;
	rawRequestDump?: RawHttpRequestDump;
	anthropicWireBodyJson?: string;
	providerSessionState?: AnthropicProviderSessionState;
	baseUrl: string;
	disableStrictTools: boolean;
	forceDemoteUnsignedThinking: boolean;
	dropFastMode: boolean;
	prepareParams: (
		disableStrict?: boolean,
		dropFast?: boolean,
		forceDemote?: boolean,
	) => Promise<MessageCreateParamsStreaming>;
}

async function handleAnthropicStreamPreflightRetry(
	streamFailure: unknown,
	ctx: AnthropicStreamRetryContext,
): Promise<{
	disableStrictTools: boolean;
	forceDemoteUnsignedThinking: boolean;
	dropFastMode: boolean;
	providerRetryAttempt: number;
	params: MessageCreateParamsStreaming;
} | null> {
	if (
		!ctx.disableStrictTools &&
		ctx.firstTokenTime === undefined &&
		hasStrictAnthropicTools(ctx.params) &&
		AIError.isGrammarError(streamFailure)
	) {
		logger.warn("anthropic: strict tools rejected, retrying without strict tools", {
			model: ctx.model.id,
			error: await finalizeErrorMessage(
				streamFailure,
				materializeDumpBody(ctx.rawRequestDump, ctx.anthropicWireBodyJson),
			),
		});
		if (ctx.providerSessionState) ctx.providerSessionState.strictToolsDisabled = true;
		const nextParams = await ctx.prepareParams(true, ctx.dropFastMode, ctx.forceDemoteUnsignedThinking);
		discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
		return {
			disableStrictTools: true,
			forceDemoteUnsignedThinking: ctx.forceDemoteUnsignedThinking,
			dropFastMode: ctx.dropFastMode,
			providerRetryAttempt: 0,
			params: nextParams,
		};
	}
	if (
		!ctx.forceDemoteUnsignedThinking &&
		ctx.firstTokenTime === undefined &&
		!ctx.streamedReplayUnsafeContent &&
		isInvalidThinkingSignatureError(errorMessage(streamFailure))
	) {
		logger.warn(
			"anthropic: signing proxy detected (Invalid signature in thinking block), demoting unsigned thinking and retrying",
			{
				provider: ctx.model.provider,
				model: ctx.model.id,
				baseUrl: ctx.baseUrl,
				error: errorMessage(streamFailure),
			},
		);
		if (ctx.providerSessionState) ctx.providerSessionState.replayUnsignedThinkingDisabled = true;
		const nextParams = await ctx.prepareParams(ctx.disableStrictTools, ctx.dropFastMode, true);
		discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
		return {
			disableStrictTools: ctx.disableStrictTools,
			forceDemoteUnsignedThinking: true,
			dropFastMode: ctx.dropFastMode,
			providerRetryAttempt: 0,
			params: nextParams,
		};
	}
	if (
		!ctx.dropFastMode &&
		realizesPriorityServiceTier(ctx.options?.serviceTier, ctx.model) &&
		ctx.firstTokenTime === undefined &&
		AIError.isFastModeUnsupported(streamFailure)
	) {
		logger.warn(
			"anthropic: fast mode is not available for this model, so the request was retried at the standard service tier and fast mode is off for the rest of this session",
			{
				model: ctx.model.id,
				provider: ctx.model.provider,
				error: errorMessage(streamFailure),
			},
		);
		if (ctx.providerSessionState) ctx.providerSessionState.fastModeDisabled = true;
		const nextParams = await ctx.prepareParams(ctx.disableStrictTools, true, ctx.forceDemoteUnsignedThinking);
		discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
		return {
			disableStrictTools: ctx.disableStrictTools,
			forceDemoteUnsignedThinking: ctx.forceDemoteUnsignedThinking,
			dropFastMode: true,
			providerRetryAttempt: 0,
			params: nextParams,
		};
	}
	return null;
}

async function handleAnthropicStreamRetry(
	streamFailure: unknown,
	ctx: AnthropicStreamRetryContext,
): Promise<{
	disableStrictTools: boolean;
	forceDemoteUnsignedThinking: boolean;
	dropFastMode: boolean;
	providerRetryAttempt: number;
	params: MessageCreateParamsStreaming;
}> {
	const preflightResult = await handleAnthropicStreamPreflightRetry(streamFailure, ctx);
	if (preflightResult) return preflightResult;
	const isTransientEnvelopeFailure =
		AIError.isTransientStreamParseError(streamFailure) || AIError.isStreamEnvelopeError(streamFailure);
	const isLocalIdleTimeout =
		streamFailure === ctx.idleTimeoutAbortError ||
		(streamFailure instanceof Error && streamFailure.message === ctx.idleTimeoutAbortError.message);
	const canRetryTransientEnvelopeFailure = isTransientEnvelopeFailure && !ctx.streamedReplayUnsafeContent;
	const canRetryProviderFailure =
		!isLocalIdleTimeout &&
		ctx.firstTokenTime === undefined &&
		!ctx.streamedReplayUnsafeContent &&
		isAnthropicStreamRetryable(streamFailure, ctx.model.provider);
	const nothingArrivedOutlivedBudget =
		ctx.firstTokenTime === undefined &&
		(isPreResponseStall(streamFailure) || AIError.isEmptyStreamEnvelopeError(streamFailure)) &&
		ctx.firstEventBudget.spent();
	if (
		ctx.activeAbortTracker.wasCallerAbort() ||
		ctx.providerRetryAttempt >= PROVIDER_MAX_RETRIES ||
		nothingArrivedOutlivedBudget ||
		(!canRetryTransientEnvelopeFailure && !canRetryProviderFailure)
	) {
		throw streamFailure;
	}
	const nextAttempt = ctx.providerRetryAttempt + 1;
	const backoffDelayMs = calculateAnthropicRetryDelayMs(ctx.providerRetryAttempt);
	const headerDelayMs =
		streamFailure instanceof Error && streamFailure instanceof AnthropicApiError
			? retryDelayFromHeaders(streamFailure.headers)
			: undefined;
	const maxRetryDelayMs = ctx.options?.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS;
	if (headerDelayMs !== undefined && headerDelayMs > maxRetryDelayMs) throw streamFailure;
	const delayMs = headerDelayMs !== undefined ? Math.max(headerDelayMs, backoffDelayMs) : backoffDelayMs;
	if (ctx.options?.providerRetryWait) {
		await ctx.options.providerRetryWait(delayMs, ctx.options.signal);
	} else {
		await scheduler.wait(delayMs, { signal: ctx.options?.signal });
	}
	discardAnthropicAttempt(ctx.model, ctx.output, ctx.copilotDynamicHeaders?.premiumRequests);
	return {
		disableStrictTools: ctx.disableStrictTools,
		forceDemoteUnsignedThinking: ctx.forceDemoteUnsignedThinking,
		dropFastMode: ctx.dropFastMode,
		providerRetryAttempt: nextAttempt,
		params: ctx.params,
	};
}

const streamAnthropicOnce = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;
		let anthropicWireBodyJson: string | undefined;
		let activeAbortTracker = createAbortSourceTracker(options?.signal);

		const onSseEvent = options?.onSseEvent;
		const rawSseObserver = onSseEvent ? (event: RawSseEvent) => onSseEvent(event, model) : undefined;

		try {
			const copilotDynamicHeaders =
				anthropicWire(model).credential === "copilot-bearer"
					? buildCopilotDynamicHeaders({
							messages: context.messages,
							hasImages: hasCopilotVisionInput(context.messages),
							premiumMultiplier: model.premiumMultiplier,
							headers: { ...(model.headers ?? {}), ...(options?.headers ?? {}) },
							initiatorOverride: options?.initiatorOverride,
						})
					: undefined;
			if (copilotDynamicHeaders?.premiumRequests !== undefined) {
				output.usage.premiumRequests = copilotDynamicHeaders.premiumRequests;
			}
			const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
			const baseUrl = resolveAnthropicBaseUrl(model, apiKey) ?? ANTHROPIC_API_ENDPOINT;
			const providerSessionState = getAnthropicProviderSessionState(
				options?.providerSessionState,
				baseUrl,
				model.id,
			);
			let disableStrictTools =
				(providerSessionState?.strictToolsDisabled ?? false) || (model.compat?.disableStrictTools ?? false);
			let dropFastMode = providerSessionState?.fastModeDisabled ?? false;
			let forceDemoteUnsignedThinking = providerSessionState?.replayUnsignedThinkingDisabled ?? false;
			const mergedCallerHeaders = mergeHeaders(model.headers, options?.headers);
			const umansGatewayWebSearchHeader = getUmansWebSearchHeader(model, mergedCallerHeaders);

			let client: AnthropicMessagesClientLike;
			let isOAuthToken: boolean;

			if (options?.client) {
				client = options.client;
				isOAuthToken = false;
			} else {
				const extraBetas = resolveAnthropicStreamBetas(model, options, dropFastMode);
				const created = createClient(model, {
					model,
					apiKey,
					extraBetas,
					stream: true,
					interleavedThinking: options?.interleavedThinking ?? true,
					headers: options?.headers,
					dynamicHeaders: copilotDynamicHeaders?.headers,
					isOAuth: options?.isOAuth,
					hasTools: !!context.tools?.length,
					thinkingEnabled: options?.thinkingEnabled,
					thinkingDisplay: options?.thinkingDisplay,
					fetch: options?.fetch,
					claudeCodeSessionId: options?.sessionId ?? extractClaudeMetadataSessionId(options?.metadata?.user_id),
					disableStrictTools,
				});
				client = created.client;
				isOAuthToken = created.isOAuthToken;
			}
			const preparedContext = await prepareAnthropicManyImageContext(context, model.input.includes("image"));
			const prepareParams = async (
				currentDisableStrict = disableStrictTools,
				currentDropFast = dropFastMode,
				currentForceDemote = forceDemoteUnsignedThinking,
			): Promise<MessageCreateParamsStreaming> => {
				let nextParams = buildParams(
					model,
					preparedContext,
					isOAuthToken,
					options,
					currentDisableStrict,
					umansGatewayWebSearchHeader !== undefined,
					currentForceDemote,
				);
				if (currentDisableStrict) dropAnthropicStrictTools(nextParams);
				if (currentDropFast) dropAnthropicFastMode(nextParams);
				const replacementPayload = await options?.onPayload?.(nextParams, model);
				if (replacementPayload !== undefined) {
					nextParams = replacementPayload as typeof nextParams;
				}
				nextParams = toWellFormedDeep(nextParams) as typeof nextParams;
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: `${baseUrl}/v1/messages${isOAuthToken ? "?beta=true" : ""}`,
				};
				anthropicWireBodyJson = JSON.stringify(nextParams);
				return nextParams;
			};
			let params = await prepareParams();

			const cacheEnforcement: CacheEnforcement = resolveCacheEnforcement(options?.cacheEnforcement);
			const cacheTracker: CacheTrackerState | undefined = providerSessionState?.cacheTracker;
			if (cacheTracker && cacheEnforcement !== "off") {
				const pending = takePendingCacheFailure(cacheTracker, options?.promptCacheKey);
				if (pending) throw new CacheRejectedError(pending, model.provider, model.id);
			}
			const cacheTracked = cacheTracker
				? beginCacheTrackedRequest(cacheTracker, {
						anchors: countCacheControlBreakpoints(params),
						retention: anthropicRetentionFromParams(params),
						reportsCacheWrites: true,
						...(options?.promptCacheKey === undefined ? {} : { cacheKey: options.promptCacheKey }),
					})
				: undefined;

			const serverSideFallback = !!options?.fallbacks?.length;
			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const requestTimeoutMs =
				firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
			const blocks = output.content as AnthropicStreamBlock[];

			stream.push({ type: "start", partial: output });
			let providerRetryAttempt = 0;
			const firstEventBudget = openStallLadderBudget(firstEventTimeoutMs);
			const firstEventTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream timed out while waiting for the first event",
			);
			const idleTimeoutAbortError = new AIError.StreamTimeoutError(
				"Anthropic stream stalled while waiting for the next event",
			);

			while (true) {
				activeAbortTracker = createAbortSourceTracker(options?.signal);
				const { requestSignal } = activeAbortTracker;
				const requestOptions = {
					...createSdkStreamRequestOptions(requestSignal, requestTimeoutMs),
					maxRetries: 0,
					...(umansGatewayWebSearchHeader ? { headers: umansGatewayWebSearchHeader } : {}),
				};
				const anthropicRequest: unknown =
					isOAuthToken && client.beta
						? client.beta.messages.create({ ...params, stream: true }, requestOptions)
						: client.messages.create({ ...params, stream: true }, requestOptions);

				const streamContext: AnthropicStreamContext = {
					model,
					output,
					stream,
					serverSideFallback,
					isOAuthToken,
					openBlocks: new Map(),
					closedBlockIndexes: new Set(),
					blocks,
					firstTokenTime,
					streamedReplayUnsafeContent: false,
					sawEvent: false,
					sawMessageStart: false,
					sawTerminalEnvelope: false,
					sawMessageStop: false,
					sawSplicedEnvelope: false,
				};

				try {
					let requestTimeout: NodeJS.Timeout | undefined;
					if (requestTimeoutMs !== undefined) {
						requestTimeout = setTimeout(
							() => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
							requestTimeoutMs,
						);
					}
					let anthropicStream: AsyncIterable<AnthropicStreamEvent>;
					let response: Response;
					let requestId: string | null;
					let recordsRawSseEvents: boolean;
					try {
						({
							events: anthropicStream,
							response,
							requestId,
							recordsRawSseEvents,
						} = await getAnthropicStreamResponse(anthropicRequest, requestSignal, rawSseObserver));
					} catch (error) {
						if (error instanceof AnthropicConnectionTimeoutError && !activeAbortTracker.wasCallerAbort()) {
							throw firstEventTimeoutAbortError;
						}
						throw error;
					} finally {
						if (requestTimeout !== undefined) clearTimeout(requestTimeout);
					}
					await notifyProviderResponse(options, response, model, requestId);

					let sawNonPingEvent = false;
					let lastNonPingProgressAtMs = 0;
					const pingProgressCapMs =
						idleTimeoutMs !== undefined && idleTimeoutMs > 0
							? idleTimeoutMs * PING_PROGRESS_MAX_IDLE_MULTIPLIER
							: undefined;
					const timedAnthropicStream = iterateWithIdleTimeout(anthropicStream, {
						idleTimeoutMs,
						firstItemTimeoutMs: firstEventTimeoutMs,
						errorMessage: idleTimeoutAbortError.message,
						firstItemErrorMessage: firstEventTimeoutAbortError.message,
						onIdle: () => activeAbortTracker.abortLocally(idleTimeoutAbortError),
						onFirstItemTimeout: () => activeAbortTracker.abortLocally(firstEventTimeoutAbortError),
						abortSignal: options?.signal,
						isProgressItem: item => {
							if ((item as AnthropicStreamEvent).type === "ping") {
								if (!sawNonPingEvent) return false;
								if (pingProgressCapMs === undefined) return true;
								return Date.now() - lastNonPingProgressAtMs < pingProgressCapMs;
							}
							sawNonPingEvent = true;
							lastNonPingProgressAtMs = Date.now();
							return true;
						},
					});
					const observedAnthropicStream =
						rawSseObserver && !recordsRawSseEvents
							? observeDecodedAnthropicSdkEvents(timedAnthropicStream, rawSseObserver)
							: timedAnthropicStream;

					for await (const event of observedAnthropicStream) {
						processAnthropicStreamEvent(event, streamContext);
					}
					firstTokenTime = streamContext.firstTokenTime;

					finalizeAnthropicStreamTurn(streamContext, activeAbortTracker);
					recordAnthropicCacheResult(cacheTracker, cacheTracked, cacheEnforcement, params, output, model);
					break;
				} catch (streamError) {
					firstTokenTime = streamContext.firstTokenTime;
					const streamFailure = activeAbortTracker.getLocalAbortReason() ?? streamError;
					const retryResult = await handleAnthropicStreamRetry(streamFailure, {
						model,
						output,
						options,
						activeAbortTracker,
						firstEventBudget,
						idleTimeoutAbortError,
						firstTokenTime,
						streamedReplayUnsafeContent: streamContext.streamedReplayUnsafeContent,
						providerRetryAttempt,
						copilotDynamicHeaders,
						params,
						rawRequestDump,
						anthropicWireBodyJson,
						providerSessionState,
						baseUrl,
						disableStrictTools,
						forceDemoteUnsignedThinking,
						dropFastMode,
						prepareParams,
					});
					disableStrictTools = retryResult.disableStrictTools;
					forceDemoteUnsignedThinking = retryResult.forceDemoteUnsignedThinking;
					dropFastMode = retryResult.dropFastMode;
					providerRetryAttempt = retryResult.providerRetryAttempt;
					params = retryResult.params;
					firstTokenTime = undefined;
				}
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			if (dropFastMode && realizesPriorityServiceTier(options?.serviceTier, model)) {
				output.disabledFeatures = (output.disabledFeatures ?? []).concat(["priority"]);
			}
			if (forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking) {
				output.disabledFeatures = (output.disabledFeatures ?? []).concat(["unsigned-thinking-replay"]);
			}
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				abortTracker: activeAbortTracker,
				rawRequestDump: materializeDumpBody(rawRequestDump, anthropicWireBodyJson),
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = maybeAddReplayUnsignedThinkingHint(model, result.message);
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamAnthropic: StreamFunction<"anthropic-messages"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamAnthropicOnce, { providerRetriesStalls: true });

export type AnthropicSystemBlock = {
	type: "text";
	text: string;
	cache_control?: AnthropicCacheControl;
};
type SystemBlockOptions = {
	includeClaudeCodeInstruction?: boolean;
	extraInstructions?: string[];

	firstUserMessageText?: string;
	cacheControl?: AnthropicCacheControl;
};

function applyClaudeCodeSystemCache(
	blocks: AnthropicSystemBlock[],
	cacheControl: AnthropicCacheControl | undefined,
): number {
	if (!cacheControl || blocks.length === 0) return 0;
	const lastIndex = blocks.length - 1;
	if (blocks[lastIndex].cache_control != null) return 0;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cloneAnthropicCacheControl(cacheControl) };
	return 1;
}

export function buildAnthropicSystemBlocks(
	systemPrompt: readonly string[] | undefined,
	options: SystemBlockOptions = {},
): AnthropicSystemBlock[] | undefined {
	const { includeClaudeCodeInstruction = false, extraInstructions = [], firstUserMessageText, cacheControl } = options;
	const sanitizedPrompts = normalizeSystemPrompts(systemPrompt);
	const trimmedInstructions = extraInstructions.map(instruction => instruction.trim()).filter(Boolean);
	const hasBillingHeader = sanitizedPrompts.some(prompt => prompt.startsWith(CLAUDE_BILLING_HEADER_PREFIX));

	if (includeClaudeCodeInstruction && !hasBillingHeader) {
		const blocks: AnthropicSystemBlock[] = [
			{ type: "text", text: createClaudeBillingHeader(firstUserMessageText ?? "") },
			{ type: "text", text: claudeCodeSystemInstruction },
		];

		for (const instruction of trimmedInstructions) {
			blocks.push({ type: "text", text: instruction });
		}
		for (const prompt of sanitizedPrompts) {
			blocks.push({ type: "text", text: prompt });
		}
		applyClaudeCodeSystemCache(blocks, cacheControl);

		return blocks;
	}

	const blocks: AnthropicSystemBlock[] = [];
	for (const instruction of trimmedInstructions) {
		blocks.push({ type: "text", text: instruction });
	}
	for (const prompt of sanitizedPrompts) {
		blocks.push({ type: "text", text: prompt });
	}
	const lastIndex = blocks.length - 1;
	if (cacheControl && lastIndex >= 0 && blocks[lastIndex].cache_control == null) {
		blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cloneAnthropicCacheControl(cacheControl) };
	}
	return blocks.length > 0 ? blocks : undefined;
}

export function normalizeExtraBetas(betas?: string[] | string): string[] {
	if (!betas) return [];
	const raw = Array.isArray(betas) ? betas : betas.split(",");
	return raw.map(beta => beta.trim()).filter(beta => beta.length > 0);
}

export function buildAnthropicClientOptions(args: AnthropicClientOptionsArgs): AnthropicClientOptionsResult {
	const {
		model,
		apiKey,
		extraBetas = [],
		stream = true,
		interleavedThinking = true,
		headers,
		dynamicHeaders,
		hasTools = false,
		thinkingEnabled = false,
		thinkingDisplay,
		isOAuth,
		claudeCodeSessionId,
		disableStrictTools: disableStrictToolsOverride,
	} = args;
	const compat = model.compat;
	const disableStrictTools = disableStrictToolsOverride ?? compat.disableStrictTools;
	const needsInterleavedBeta = interleavedThinking && !model.thinking?.supportsDisplay;
	const needsFineGrainedToolStreamingBeta = hasTools && !compat.supportsEagerToolInputStreaming;
	const oauthToken = isOAuth ?? isAnthropicOAuthToken(apiKey);
	const baseUrl = resolveAnthropicBaseUrl(model, apiKey);
	const foundryCustomHeaders = resolveAnthropicCustomHeaders(model);
	const tlsFetchOptions = buildClaudeCodeTlsFetchOptions(model, baseUrl);
	const fetchOptions: AnthropicFetchOptions = { ...(tlsFetchOptions ?? {}), timeout: false };
	const baseFetch = args.fetch ?? fetch;

	const cchFetch = oauthToken ? wrapFetchForCch(baseFetch) : baseFetch;
	const wire = anthropicWire(model);
	if (wire.credential === "copilot-bearer") {
		const copilotApiKey = parseGitHubCopilotApiKey(apiKey).accessToken;
		const betaFeatures = extraBetas.slice();
		const defaultHeaders = mergeHeaders(
			{
				Accept: stream ? "text/event-stream" : "application/json",
				"Content-Type": "application/json",
				"anthropic-version": "2023-06-01",
				"Anthropic-Dangerous-Direct-Browser-Access": "true",
				Authorization: `Bearer ${copilotApiKey}`,
				...(betaFeatures.length > 0 ? { "anthropic-beta": buildBetaHeader([], betaFeatures) } : {}),
			},
			model.headers,
			dynamicHeaders,
			headers,
		);

		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: copilotApiKey,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	const betaFeatures = extraBetas.slice();
	if (needsFineGrainedToolStreamingBeta) {
		betaFeatures.push(fineGrainedToolStreamingBeta);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(interleavedThinkingBeta);
	}

	const defaultHeaders = buildAnthropicHeaders({
		apiKey,
		baseUrl,
		isOAuth: oauthToken,
		extraBetas: betaFeatures,
		stream,
		modelHeaders: mergeHeaders(
			model.headers,
			foundryCustomHeaders,
			getUmansWebSearchHeader(model, mergeHeaders(model.headers, headers)),
			headers,
			dynamicHeaders,
		),
		isCloudflareAiGateway: wire.credential === "gateway-managed",
		claudeCodeSessionId,
		claudeCodeBetas: oauthToken
			? buildClaudeCodeBetas(
					hasTools || thinkingEnabled,
					thinkingEnabled,
					thinkingDisplay === "omitted",
					disableStrictTools,
				)
			: [],
	});

	if (wire.credential === "gateway-managed") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	if (wire.credential === "api-key-header") {
		delete defaultHeaders.Authorization;
		return {
			isOAuthToken: false,
			apiKey,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	if (wire.credential === "bearer-only") {
		return {
			isOAuthToken: false,
			apiKey: null,
			authToken: null,
			baseURL: baseUrl,
			maxRetries: 5,
			defaultHeaders,
			fetch: cchFetch,
			fetchOptions,
		};
	}

	const authorizationHeader = getHeaderCaseInsensitive(defaultHeaders, "Authorization");
	const shouldSuppressClientApiKey =
		!oauthToken && !model.compat.officialEndpoint && typeof authorizationHeader === "string";

	return {
		isOAuthToken: oauthToken,
		apiKey: oauthToken || shouldSuppressClientApiKey ? null : apiKey,
		authToken: oauthToken ? apiKey : undefined,
		baseURL: baseUrl,
		maxRetries: 5,
		defaultHeaders,
		fetch: cchFetch,
		fetchOptions,
	};
}

function createClient(
	model: Model<"anthropic-messages">,
	args: AnthropicClientOptionsArgs,
): { client: AnthropicMessagesClient; isOAuthToken: boolean } {
	const { isOAuthToken: oauthToken, ...clientOptions } = buildAnthropicClientOptions({ ...args, model });
	const client = new AnthropicMessagesClient(clientOptions);
	return { client, isOAuthToken: oauthToken };
}

function disableThinkingIfToolChoiceForced(params: MessageCreateParamsStreaming): void {
	const toolChoice = params.tool_choice;
	if (!toolChoice) return;
	if (toolChoice.type !== "any" && toolChoice.type !== "tool") return;

	delete params.thinking;
	delete params.context_management;
	const outputConfig = params.output_config as AnthropicOutputConfig | undefined;
	if (!outputConfig) return;

	delete outputConfig.effort;
	if (Object.keys(outputConfig).length === 0) {
		delete params.output_config;
	}
}

function ensureMaxTokensForThinking(params: MessageCreateParamsStreaming, maxAllowedTokens: number): void {
	const thinking = params.thinking;
	if (thinking?.type !== "enabled") return;

	const budgetTokens = thinking.budget_tokens ?? 0;
	if (budgetTokens <= 0) return;

	const currentMaxTokens = Math.min(params.max_tokens ?? maxAllowedTokens, maxAllowedTokens);
	const raisedMaxTokens = Math.min(
		Math.max(currentMaxTokens, budgetTokens + OUTPUT_FALLBACK_BUFFER),
		maxAllowedTokens,
	);
	params.max_tokens = raisedMaxTokens;

	if (budgetTokens + OUTPUT_FALLBACK_BUFFER <= raisedMaxTokens) return;

	const clampedBudget = raisedMaxTokens - OUTPUT_FALLBACK_BUFFER;
	if (clampedBudget <= 0) {
		throw new AIError.ConfigurationError(
			`Anthropic thinking budget requires max_tokens greater than ${OUTPUT_FALLBACK_BUFFER}; got ${raisedMaxTokens}`,
		);
	}
	thinking.budget_tokens = clampedBudget;
}

type CacheControlBlock = {
	cache_control?: AnthropicCacheControl | null;
};

function applyCacheControlToLastBlock<T extends CacheControlBlock>(
	blocks: T[],
	cacheControl: AnthropicCacheControl,
): boolean {
	if (blocks.length === 0) return false;
	const lastIndex = blocks.length - 1;
	if (blocks[lastIndex].cache_control != null) return false;
	blocks[lastIndex] = { ...blocks[lastIndex], cache_control: cloneAnthropicCacheControl(cacheControl) };
	return true;
}
function applyCacheControlToStableSystemPrefix<T extends CacheControlBlock>(
	blocks: T[],
	cacheControl: AnthropicCacheControl,
	index: number,
): boolean {
	if (index < 0 || index >= blocks.length - 1) return false;
	if (blocks[index].cache_control != null) return false;
	blocks[index] = { ...blocks[index], cache_control: cloneAnthropicCacheControl(cacheControl) };
	return true;
}

function applyCacheControlToLastTextBlock(
	blocks: Array<ContentBlockParam & CacheControlBlock>,
	cacheControl: AnthropicCacheControl,
): boolean {
	if (blocks.length === 0) return false;
	for (let i = blocks.length - 1; i >= 0; i--) {
		if (blocks[i].type === "text") {
			if (blocks[i].cache_control != null) return false;
			blocks[i] = { ...blocks[i], cache_control: cloneAnthropicCacheControl(cacheControl) };
			return true;
		}
	}
	for (let i = blocks.length - 1; i >= 0; i--) {
		const type = blocks[i].type;
		if (type === "thinking" || type === "redacted_thinking") continue;
		if (blocks[i].cache_control != null) return false;
		blocks[i] = { ...blocks[i], cache_control: cloneAnthropicCacheControl(cacheControl) };
		return true;
	}
	return false;
}

function applyPromptCaching(params: MessageCreateParamsStreaming, cacheControl?: AnthropicCacheControl): void {
	if (!cacheControl) return;

	const MAX_CACHE_BREAKPOINTS = 4;
	let cacheBreakpointsUsed = countCacheControlBreakpoints(params);
	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;
	let isCCLayout = false;

	if (params.system && Array.isArray(params.system) && params.system.length > 0) {
		isCCLayout =
			params.system.length >= 3 &&
			(params.system[0] as { text?: string }).text?.startsWith(CLAUDE_BILLING_HEADER_PREFIX) === true;
		if (isCCLayout) {
			const placed = Math.min(
				MAX_CACHE_BREAKPOINTS - cacheBreakpointsUsed,
				applyClaudeCodeSystemCache(params.system as AnthropicSystemBlock[], cacheControl),
			);
			cacheBreakpointsUsed += placed;
		} else if (applyCacheControlToLastBlock(params.system, cacheControl)) {
			cacheBreakpointsUsed++;
		}

		const stablePrefixIndex = isCCLayout ? 2 : 0;
		if (
			cacheBreakpointsUsed < MAX_CACHE_BREAKPOINTS &&
			applyCacheControlToStableSystemPrefix(params.system, cacheControl, stablePrefixIndex)
		) {
			cacheBreakpointsUsed++;
		}
	}

	if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;

	const start = isCCLayout ? Math.max(0, params.messages.length - 1) : Math.max(0, params.messages.length - 2);
	for (let i = start; i < params.messages.length; i++) {
		if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) break;
		const message = params.messages[i];
		if (!message) continue;
		if (typeof message.content === "string") {
			message.content = [
				{ type: "text", text: message.content, cache_control: cloneAnthropicCacheControl(cacheControl) },
			];
			cacheBreakpointsUsed++;
		} else if (Array.isArray(message.content) && message.content.length > 0) {
			if (
				applyCacheControlToLastTextBlock(
					message.content as Array<ContentBlockParam & CacheControlBlock>,
					cacheControl,
				)
			) {
				cacheBreakpointsUsed++;
			}
		}
	}
}

function normalizeCacheControlBlockTtl(block: CacheControlBlock, seenFiveMinute: { value: boolean }): void {
	const cacheControl = block.cache_control;
	if (!cacheControl) return;
	if (cacheControl.ttl !== "1h") {
		seenFiveMinute.value = true;
		return;
	}
	if (seenFiveMinute.value) {
		const normalized = cloneAnthropicCacheControl(cacheControl);
		delete normalized.ttl;
		block.cache_control = normalized;
	}
}

function normalizeCacheControlTtlOrdering(params: MessageCreateParamsStreaming): void {
	const seenFiveMinute = { value: false };
	if (params.tools) {
		for (const tool of params.tools as Array<AnthropicWireTool & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(tool, seenFiveMinute);
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			normalizeCacheControlBlockTtl(block, seenFiveMinute);
		}
	}
}

function findLastCacheControlIndex<T extends CacheControlBlock>(blocks: T[]): number {
	for (let index = blocks.length - 1; index >= 0; index--) {
		if (blocks[index]?.cache_control != null) return index;
	}
	return -1;
}

function stripCacheControlExceptIndex<T extends CacheControlBlock>(
	blocks: T[],
	preserveIndex: number,
	excessCounter: { value: number },
): void {
	for (let index = 0; index < blocks.length && excessCounter.value > 0; index++) {
		if (index === preserveIndex) continue;
		if (!blocks[index]?.cache_control) continue;
		delete blocks[index].cache_control;
		excessCounter.value--;
	}
}

function stripAllCacheControl<T extends CacheControlBlock>(blocks: T[], excessCounter: { value: number }): void {
	for (const block of blocks) {
		if (excessCounter.value <= 0) return;
		if (!block.cache_control) continue;
		delete block.cache_control;
		excessCounter.value--;
	}
}

function stripMessageCacheControl(
	messages: MessageCreateParamsStreaming["messages"],
	excessCounter: { value: number },
): void {
	for (const message of messages) {
		if (excessCounter.value <= 0) return;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (excessCounter.value <= 0) return;
			if (!block.cache_control) continue;
			delete block.cache_control;
			excessCounter.value--;
		}
	}
}

function anthropicRetentionFromParams(params: MessageCreateParamsStreaming): CacheRetention {
	let sawMarker = false;
	const inspect = (cacheControl: AnthropicCacheControl | null | undefined): boolean => {
		if (!cacheControl) return false;
		sawMarker = true;
		return cacheControl.ttl === "1h";
	};
	if (params.tools) {
		for (const tool of params.tools as Array<AnthropicWireTool & CacheControlBlock>) {
			if (inspect(tool.cache_control)) return "long";
		}
	}
	if (Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (inspect(block.cache_control)) return "long";
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (inspect(block.cache_control)) return "long";
		}
	}
	return sawMarker ? "short" : "none";
}

function countCacheControlBreakpoints(params: MessageCreateParamsStreaming): number {
	let total = 0;
	if (params.tools) {
		for (const tool of params.tools as Array<AnthropicWireTool & CacheControlBlock>) {
			if (tool.cache_control) total++;
		}
	}
	if (params.system && Array.isArray(params.system)) {
		for (const block of params.system as Array<AnthropicSystemBlock & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	for (const message of params.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as Array<ContentBlockParam & CacheControlBlock>) {
			if (block.cache_control) total++;
		}
	}
	return total;
}

function enforceCacheControlLimit(params: MessageCreateParamsStreaming, maxBreakpoints: number): void {
	const total = countCacheControlBreakpoints(params);
	if (total <= maxBreakpoints) return;
	const excessCounter = { value: total - maxBreakpoints };
	const systemBlocks =
		params.system && Array.isArray(params.system)
			? (params.system as Array<AnthropicSystemBlock & CacheControlBlock>)
			: [];
	const toolBlocks = (params.tools ?? []) as Array<AnthropicWireTool & CacheControlBlock>;
	const lastSystemIndex = findLastCacheControlIndex(systemBlocks);
	const lastToolIndex = findLastCacheControlIndex(toolBlocks);
	if (systemBlocks.length > 0) {
		stripCacheControlExceptIndex(systemBlocks, lastSystemIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripCacheControlExceptIndex(toolBlocks, lastToolIndex, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	stripMessageCacheControl(params.messages, excessCounter);
	if (excessCounter.value <= 0) return;
	if (systemBlocks.length > 0) {
		stripAllCacheControl(systemBlocks, excessCounter);
	}
	if (excessCounter.value <= 0) return;
	if (toolBlocks.length > 0) {
		stripAllCacheControl(toolBlocks, excessCounter);
	}
}

function usesAdaptiveThinkingTagOnly(model: Model<"anthropic-messages">): boolean {
	const thinking = model.thinking;
	if (thinking?.mode !== "anthropic-adaptive") return false;
	const effortMap = thinking.effortMap;
	if (!effortMap) return false;
	for (const effort of thinking.efforts) {
		if (effortMap[effort] !== "adaptive") return false;
	}
	return thinking.efforts.length > 0;
}

function resolveAnthropicAdaptiveEffort(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
): AnthropicEffort | undefined {
	if (options.effort) return usesAdaptiveThinkingTagOnly(model) ? "adaptive" : options.effort;
	const requestedEffort = options.reasoning;
	if (!requestedEffort) return undefined;
	return mapEffortToAnthropicAdaptiveEffort(model, requestedEffort);
}

function extractClaudeCodeFirstUserMessageText(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		for (const block of content) {
			if (block.type === "text") return block.text;
		}
		return "";
	}
	return "";
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
	disableStrictTools = false,
	useUmansGatewayWebSearch = false,
	forceDemoteUnsignedThinking = false,
): MessageCreateParamsStreaming {
	const effectiveModel =
		forceDemoteUnsignedThinking && model.compat.replayUnsignedThinking
			? { ...model, compat: { ...model.compat, replayUnsignedThinking: false } }
			: model;
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, isOAuthToken);

	const shouldInjectClaudeCodeInstruction = isOAuthToken && !model.id.startsWith("claude-3-5-haiku");
	const firstUserMessageText = shouldInjectClaudeCodeInstruction
		? extractClaudeCodeFirstUserMessageText(context.messages)
		: "";
	const systemBlocks = buildAnthropicSystemBlocks(context.systemPrompt, {
		includeClaudeCodeInstruction: shouldInjectClaudeCodeInstruction,
		firstUserMessageText,
	});

	let tools: AnthropicWireTool[] | undefined;
	if (context.tools) {
		tools = convertTools(
			context.tools,
			isOAuthToken,
			disableStrictTools || anthropicWire(model).rejectsBetas === true,
			model.compat.supportsEagerToolInputStreaming,
			model.compat.escapeBuiltinToolNames,
			useUmansGatewayWebSearch,
		);
	} else if (isOAuthToken) {
		tools = [];
	}

	const metadataAccountId = readAnthropicMetadataAccountId(options?.metadata);
	const metadataUserId = resolveAnthropicMetadataUserId(
		options?.metadata?.user_id,
		isOAuthToken,
		options?.sessionId,
		metadataAccountId,
	);
	const metadata = metadataUserId ? { user_id: metadataUserId } : undefined;

	let thinking: MessageCreateParamsStreaming["thinking"] | undefined;
	let outputConfigEffort: AnthropicOutputEffort | undefined;
	if (model.reasoning) {
		if (options?.thinkingEnabled || model.compat.requiresThinkingEnabled) {
			const thinkingOptions = options ?? {};
			const mode = model.thinking?.mode;
			const effort = resolveAnthropicAdaptiveEffort(model, thinkingOptions);
			const compat = model.compat;
			if (mode === "anthropic-adaptive" && !compat.disableAdaptiveThinking) {
				const adaptive: { type: "adaptive"; display?: AnthropicThinkingDisplay } = { type: "adaptive" };
				if (model.thinking?.supportsDisplay) {
					adaptive.display = thinkingOptions.thinkingDisplay ?? "summarized";
				}
				thinking = adaptive;
				if (effort && effort !== "adaptive") outputConfigEffort = effort;
			} else {
				thinking = {
					type: "enabled",
					budget_tokens: thinkingOptions.thinkingBudgetTokens || 1024,
					display: thinkingOptions.thinkingDisplay ?? "summarized",
				};
				if (mode === "anthropic-budget-effort" && effort && effort !== "adaptive") outputConfigEffort = effort;
			}
		} else if (options?.thinkingEnabled === false) {
			const compat = model.compat;
			if (
				model.thinking?.mode === "anthropic-adaptive" &&
				!compat.disableAdaptiveThinking &&
				!usesAdaptiveThinkingTagOnly(model)
			) {
				outputConfigEffort = "low";
			} else {
				thinking = { type: "disabled" };
			}
		}
	}

	const shouldKeepThinkingContext =
		!options?.client &&
		!anthropicWire(model).rejectsContextManagement &&
		(thinking?.type === "adaptive" || thinking?.type === "enabled");
	const contextManagement = shouldKeepThinkingContext
		? { edits: [{ type: "clear_thinking_20251015" as const, keep: "all" as const }] }
		: undefined;

	const outputConfigEntries: AnthropicOutputConfig = {};
	if (outputConfigEffort) outputConfigEntries.effort = outputConfigEffort;
	if (options?.taskBudget) outputConfigEntries.task_budget = options.taskBudget;
	const outputConfig = Object.keys(outputConfigEntries).length ? outputConfigEntries : undefined;

	const modelMaxTokens = model.maxTokens ?? CLAUDE_CODE_MAX_OUTPUT_TOKENS;
	const maxOutputTokens = isOAuthToken ? Math.min(CLAUDE_CODE_MAX_OUTPUT_TOKENS, modelMaxTokens) : modelMaxTokens;

	const params: MessageCreateParamsStreaming = {
		model: options?.requestModelId ?? model.requestModelId ?? model.id,
		messages: convertAnthropicMessages(context.messages, effectiveModel, isOAuthToken, {
			serverSideFallbackEnabled: !!options?.fallbacks?.length,
		}),
		...(systemBlocks && { system: systemBlocks }),
		...(tools !== undefined && { tools }),
		...(metadata && { metadata }),
		max_tokens: Math.min(maxOutputTokens, options?.maxTokens || modelMaxTokens),
		...(thinking && { thinking }),
		...(contextManagement && { context_management: contextManagement }),
		...(outputConfig && { output_config: outputConfig }),
		...(options?.fallbacks?.length ? { fallbacks: options.fallbacks } : {}),
		stream: true,
	};

	const thinkingType = params.thinking?.type;
	const allowSamplingParams =
		model.compat.supportsSamplingParams && (thinkingType === undefined || thinkingType === "disabled");
	if (allowSamplingParams && options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}
	if (allowSamplingParams && options?.topP !== undefined) {
		params.top_p = options.topP;
	}
	if (allowSamplingParams && options?.topK !== undefined) {
		params.top_k = options.topK;
	}
	if (options?.stopSequences?.length) {
		const seqs = options.stopSequences;
		if (seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX && !warnedStopSequencesTrim) {
			warnedStopSequencesTrim = true;
			logger.warn("anthropic: stop_sequences exceeds 4; extra entries dropped", {
				received: seqs.length,
				kept: ANTHROPIC_STOP_SEQUENCES_MAX,
			});
		}
		params.stop_sequences =
			seqs.length > ANTHROPIC_STOP_SEQUENCES_MAX ? seqs.slice(0, ANTHROPIC_STOP_SEQUENCES_MAX) : seqs;
	}

	if (realizesPriorityServiceTier(options?.serviceTier, model)) {
		params.speed = "fast";
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else if (options.toolChoice.name) {
			params.tool_choice = {
				...options.toolChoice,
				name: encodeAnthropicToolName(
					options.toolChoice.name,
					isOAuthToken,
					model.compat.escapeBuiltinToolNames,
					useUmansGatewayWebSearch,
				),
			};
		}
		const choiceType = params.tool_choice?.type;
		if ((choiceType === "any" || choiceType === "tool") && !model.compat.supportsForcedToolChoice) {
			params.tool_choice = { type: "auto" };
		}
	}

	disableThinkingIfToolChoiceForced(params);
	ensureMaxTokensForThinking(params, maxOutputTokens);
	applyPromptCaching(params, cacheControl);
	enforceCacheControlLimit(params, 4);
	normalizeCacheControlTtlOrdering(params);

	return params;
}

function isEmptyToolResultWireContent(content: AnthropicToolResultContent): boolean {
	if (typeof content === "string") {
		return content.trim().length === 0;
	}
	return content.length === 0;
}

function ensureErrorToolResultWireContent(
	content: AnthropicToolResultContent,
	isError: boolean | undefined,
): AnthropicToolResultContent {
	if (!isError || !isEmptyToolResultWireContent(content)) {
		return content;
	}
	return typeof content === "string"
		? EMPTY_ERROR_TOOL_RESULT_TEXT
		: [{ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT }];
}

function buildToolResultBlock(
	model: Model<"anthropic-messages">,
	msg: ToolResultMessage,
	hoistedImages: ContentBlockParam[],
): ContentBlockParam {
	let content = convertContentBlocks(msg.content, model.input.includes("image"));
	if (msg.isError && typeof content !== "string" && content.some(block => block.type === "image")) {
		for (const block of content) {
			if (block.type === "image") hoistedImages.push(block);
		}
		content = content.filter(block => block.type === "text");
	}
	content = ensureErrorToolResultWireContent(content, msg.isError);
	const block: ContentBlockParam = {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content,
		is_error: msg.isError,
	};
	if (model.compat.requiresToolResultId) {
		(block as unknown as Record<string, unknown>).id = msg.toolCallId;
	}
	return block;
}

export type AnthropicMessageParam = MessageParam;

function toWellFormedDeep(value: unknown): unknown {
	if (typeof value === "string") {
		const wellFormed = value.toWellFormed();
		return wellFormed === value ? value : wellFormed;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map(entry => {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			return sanitized;
		});
		return changed ? next : value;
	}
	if (isRecord(value)) {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const sanitized = toWellFormedDeep(entry);
			if (sanitized !== entry) changed = true;
			next[key] = sanitized;
		}
		return changed ? next : value;
	}
	return value;
}

export function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	opts?: { serverSideFallbackEnabled?: boolean },
): AnthropicMessageParam[] {
	const developerParamIndices: number[] = [];
	const params: AnthropicMessageParam[] = [];

	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user" || msg.role === "developer") {
			if (!msg.content) continue;

			let content: string | ContentBlockParam[];
			if (typeof msg.content === "string") {
				if (msg.content.trim().length === 0) continue;
				content = msg.content.toWellFormed();
			} else {
				const contentBlocks = convertContentBlocks(msg.content, model.input.includes("image"));
				if (typeof contentBlocks === "string") {
					if (contentBlocks.trim().length === 0) continue;
					content = contentBlocks;
				} else {
					if (contentBlocks.length === 0) continue;
					content = contentBlocks;
				}
			}
			if (msg.role === "developer") developerParamIndices.push(params.length);
			params.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			const hasSignedThinking = msg.content.some(
				block =>
					block.type === "thinking" && !!block.thinkingSignature && block.thinkingSignature.trim().length > 0,
			);

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: block.text.toWellFormed(),
					});
				} else if (block.type === "thinking") {
					if (hasSignedThinking) {
						if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
							if (block.thinking.trim().length === 0) continue;
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking: block.thinking,
							signature: block.thinkingSignature,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						if (model.compat.replayUnsignedThinking) {
							blocks.push({
								type: "thinking",
								thinking: block.thinking.toWellFormed(),
								signature: "",
							});
						} else {
							blocks.push({
								type: "text",
								text: renderDemotedThinking(model.id, block.thinking),
							});
						}
					} else {
						blocks.push({
							type: "thinking",
							thinking: block.thinking.toWellFormed(),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "redactedThinking") {
					if (block.data.trim().length === 0) continue;
					blocks.push({
						type: "redacted_thinking",
						data: block.data,
					});
				} else if (block.type === "fallback") {
					if (!opts?.serverSideFallbackEnabled || !model.compat.officialEndpoint) continue;
					blocks.push({
						type: "fallback",
						from: block.from,
						to: block.to,
					});
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: encodeAnthropicToolName(block.name, isOAuthToken, model.compat.escapeBuiltinToolNames),
						input: toWellFormedDeep(block.arguments ?? {}),
					});
				}
			}
			let sawToolUse = false;
			let needsPartition = false;
			for (const block of blocks) {
				if (block.type === "tool_use") {
					sawToolUse = true;
				} else if (sawToolUse) {
					needsPartition = true;
					break;
				}
			}
			if (needsPartition) {
				const nonToolUse: ContentBlockParam[] = [];
				const toolUse: ContentBlockParam[] = [];
				for (const block of blocks) {
					if (block.type === "tool_use") toolUse.push(block);
					else nonToolUse.push(block);
				}
				blocks.length = 0;
				for (let bi = 0; bi < nonToolUse.length; bi++) blocks.push(nonToolUse[bi]!);
				for (let bi = 0; bi < toolUse.length; bi++) blocks.push(toolUse[bi]!);
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			const toolResults: ContentBlockParam[] = [];

			const hoistedImages: ContentBlockParam[] = [];

			toolResults.push(buildToolResultBlock(model, msg, hoistedImages));

			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push(buildToolResultBlock(model, nextMsg, hoistedImages));
				j++;
			}

			i = j - 1;

			if (hoistedImages.length > 0) {
				toolResults.push(
					{ type: "text", text: "Attached image(s) from the tool result(s) above:" },
					...hoistedImages,
				);
			}

			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	if (developerParamIndices.length > 0 && model.compat.supportsMidConversationSystem) {
		for (const idx of developerParamIndices) {
			const followsUser = idx > 0 && params[idx - 1]?.role === "user";
			const next = params[idx + 1];
			const lastOrBeforeAssistant = idx === params.length - 1 || next?.role === "assistant";

			const content = params[idx].content;
			const textOnly = typeof content === "string" || content.every(block => block.type === "text");
			if (followsUser && lastOrBeforeAssistant && textOnly) {
				params[idx] = { role: "system", content };
			}
		}
	}
	for (let i = params.length - 1; i > 0; i--) {
		if (params[i].role === "assistant" && params[i - 1]?.role === "assistant") {
			params.splice(i, 0, { role: "user", content: "Continue." });
		}
	}
	if (params.length > 0 && params[params.length - 1]?.role === "assistant") {
		params.push({ role: "user", content: "Continue." });
	}

	return params;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	disableStrictTools = false,
	supportsEagerToolInputStreaming = true,
	escapeBuiltinToolNames = false,
	useUmansGatewayWebSearch = false,
): AnthropicWireTool[] {
	if (!tools) return [];
	const schemaPlans = buildAnthropicToolSchemaPlans(tools, disableStrictTools);

	return tools.map((tool, index) => {
		const plan = schemaPlans[index];
		const baseTool = {
			name: encodeAnthropicToolName(tool.name, isOAuthToken, escapeBuiltinToolNames, useUmansGatewayWebSearch),
			description: tool.description || "",
			input_schema: plan.inputSchema,
		};
		return {
			...baseTool,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(plan.strict ? { strict: true } : {}),
		};
	});
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		case "refusal":
			return "error";
		case "pause_turn": // Stop is good enough -> resubmit
			return "stop";
		case "stop_sequence":
			return "stop"; // A caller-supplied stop_sequences entry matched; the turn completed normally.
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return "error";
		default:
			reportAnthropicEnvelopeAnomaly(`unhandled stop reason: ${reason}`);
			return "stop";
	}
}
