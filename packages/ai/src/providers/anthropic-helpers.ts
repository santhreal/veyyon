import * as logger from "@veyyon/utils/logger";
import { trimTrailingSlashes } from "@veyyon/utils/url";

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

export const midConversationSystemBeta = "mid-conversation-system-2026-04-07";
export const contextManagementBeta = "context-management-2025-06-27";
export const structuredOutputsBeta = "structured-outputs-2025-12-15";
export const claudeCodeUtilityBetaDefaults = [
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	structuredOutputsBeta,
] as const;
export const claudeCodeAgentBetaDefaults = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	contextManagementBeta,
	"prompt-caching-scope-2026-01-05",
	midConversationSystemBeta,
	"advanced-tool-use-2025-11-20",
] as const;
export const claudeCodeAgentPostEffortBetas = ["extended-cache-ttl-2025-04-11"] as const;
export const fineGrainedToolStreamingBeta = "fine-grained-tool-streaming-2025-05-14";
export const interleavedThinkingBeta = "interleaved-thinking-2025-05-14";
export const redactThinkingBeta = "redact-thinking-2026-02-12";
export const fastModeBeta = "fast-mode-2026-02-01";
export const taskBudgetBeta = "task-budgets-2026-03-13";
export const effortBeta = "effort-2025-11-24";
export const serverSideFallbackBeta = "server-side-fallback-2026-06-01";

export function buildClaudeCodeBetas(
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

export function getHeaderCaseInsensitive(
	headers: Record<string, string> | undefined,
	headerName: string,
): string | undefined {
	if (!headers) return undefined;
	const normalizedName = headerName.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalizedName) return value;
	}
	return undefined;
}

export function isClaudeCodeClientUserAgent(userAgent: string | undefined): userAgent is string {
	if (!userAgent) return false;
	return userAgent.toLowerCase().startsWith("claude-cli");
}

export const sharedHeaders = {
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Connection: "keep-alive",
	"Content-Type": "application/json",
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
	"x-app": "cli",
};

export const reportedDroppedEnforcedHeaders = new Set<string>();

export function reportDroppedEnforcedHeaders(keys: string[]): void {
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

import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import * as tls from "node:tls";
import { isOfficialAnthropicApiUrl } from "@veyyon/catalog/compat/anthropic";
import { calculateCost, discardAttemptUsage, emptyCost, emptyUsage, getBundledModel } from "@veyyon/catalog/models";
import { ANTHROPIC_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import type { ProviderAnthropicMessagesCapability } from "@veyyon/catalog/provider-models/wire-capabilities";
import { providerWireCapabilities } from "@veyyon/catalog/provider-models/wire-capabilities";
import { isAnthropicOAuthToken } from "@veyyon/catalog/utils";
import { ANTHROPIC_WEB_SEARCH_TOOL, CLAUDE_CODE_VERSION as claudeCodeVersion } from "@veyyon/catalog/wire/anthropic";
import { getInstallId } from "@veyyon/utils/dirs";
import { $env } from "@veyyon/utils/env";
import { isEnoent } from "@veyyon/utils/fs-error";
import { parseJsonWithRepair, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import { clampLow } from "@veyyon/utils/math";
import { looksLikeFilePath } from "@veyyon/utils/path";
import { readSseEvents } from "@veyyon/utils/stream";
import { errorMessage } from "@veyyon/utils/type-guards";
import { type CacheTrackerState, createCacheTrackerState } from "../cache";
import { XML_THINKING_CLOSE, XML_THINKING_OPEN } from "../dialect/wire-tags";
import * as AIError from "../error";
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
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types";
import { realizesPriorityServiceTier } from "../types";
import { isRecord, resolveCacheRetention } from "../utils";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { isFoundryEnabled } from "../utils/foundry";
import { notifyRawSseEvent } from "../utils/sse-debug";
import type { AnthropicFetchOptions, AnthropicMessagesClientLike } from "./anthropic-client";
import type {
	AnthropicWireUsage,
	FallbackParam,
	MessageCreateParamsStreaming,
	RawMessageStreamEvent,
	TextBlockParam,
} from "./anthropic-wire";
import { resolveGitHubCopilotBaseUrl } from "./github-copilot-headers";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export { normalizeAnthropicToolSchema } from "./anthropic-schema";

import { normalizeExtraBetas, usesAdaptiveThinkingTagOnly } from "./anthropic";

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

export type AnthropicCacheControl = NonNullable<TextBlockParam["cache_control"]>;
export type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

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

export function cloneAnthropicCacheControl(cacheControl: AnthropicCacheControl): AnthropicCacheControl {
	return { ...cacheControl };
}

export type AnthropicOutputConfig = NonNullable<MessageCreateParamsStreaming["output_config"]>;

export const ANTHROPIC_STOP_SEQUENCES_MAX = 4;

export const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

export type AnthropicProviderSessionState = ProviderSessionState & {
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

export function getAnthropicProviderSessionState(
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

export function hasStrictAnthropicTools(params: MessageCreateParamsStreaming): boolean {
	return params.tools?.some(tool => tool.strict === true) ?? false;
}

export function dropAnthropicFastMode(params: MessageCreateParamsStreaming): void {
	delete params.speed;
}

export function dropAnthropicStrictTools(params: MessageCreateParamsStreaming): void {
	if (!params.tools) return;
	for (const tool of params.tools) {
		delete tool.strict;
	}
}

export function getCacheControl(
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

export function anthropicWire(
	model: Pick<Model<"anthropic-messages">, "provider">,
): ProviderAnthropicMessagesCapability {
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

export const enforcedHeaderKeys = new Set(
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

export const CLAUDE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

export function createClaudeBillingHeader(firstUserMessageText: string): string {
	const k = [4, 7, 20].map(i => firstUserMessageText[i] ?? "0").join("");
	const versionSuffix = nodeCrypto
		.createHash("sha256")
		.update(`59cf53e54c78${k}${claudeCodeVersion}`)
		.digest("hex")
		.slice(0, 3);
	return `${CLAUDE_BILLING_HEADER_PREFIX} cc_version=${claudeCodeVersion}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER_STR};`;
}

export const CCH_SEED = 0x4d659218e32a3268n;
export const CCH_PLACEHOLDER_STR = "cch=00000";
export const cchEncoder = new TextEncoder();
export const CCH_PLACEHOLDER = cchEncoder.encode(CCH_PLACEHOLDER_STR);
export const BILLING_SYSTEM_MARKER = cchEncoder.encode(
	`"system":[{"type":"text","text":"${CLAUDE_BILLING_HEADER_PREFIX}`,
);
export const CCH_BILLING_SEARCH_WINDOW = 150;

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

export const CLAUDE_CLOAKING_USER_ID_REGEX =
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

export function extractClaudeMetadataSessionId(userId: unknown): string | undefined {
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

export const CLAUDE_DEVICE_ID_INSTALL_HASH_DOMAIN = "veyyon-claude-device-id-v1:";
export const CLAUDE_DEVICE_ID_ACCOUNT_HASH_DOMAIN = "veyyon-claude-device-id-v2";

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

export function readMetadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readAnthropicMetadataAccountId(metadata: Record<string, unknown> | undefined): string | undefined {
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

export const ANTHROPIC_BUILTIN_TOOL_NAMES = new Set([
	ANTHROPIC_WEB_SEARCH_TOOL,
	"code_execution",
	"text_editor",
	"computer",
]);
export const UMANS_WEBSEARCH_PROVIDER_HEADER = "X-Umans-Websearch-Provider";
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

export function getUmansWebSearchHeader(
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

export function encodeAnthropicToolName(
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

export const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
export const ANTHROPIC_MANY_IMAGE_MAX_DIMENSION = 2000;

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

export const ANTHROPIC_IMAGE_RESIZE_CONCURRENCY = 4;

export const anthropicManyImageResizeCache = new WeakMap<ImageContent, ImageContent>();

export type ResizeLimiter = <R>(fn: () => Promise<R>) => Promise<R>;

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

export async function prepareAnthropicManyImageContext(context: Context, supportsImages: boolean): Promise<Context> {
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

export type AnthropicToolResultContent =
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

export function convertContentBlocks(
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

export const CLAUDE_CODE_TLS_CIPHERS = tls.DEFAULT_CIPHERS;

export type FoundryTlsOptions = {
	ca?: string | string[];
	cert?: string;
	key?: string;
};

export const CERTIFICATE_EXTENSIONS = ["pem", "crt", "cer", "key"] as const;

export const foundryTlsOptionsCache = new Map<string, FoundryTlsOptions | undefined>();

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

export function resolveAnthropicBaseUrl(model: Model<"anthropic-messages">, apiKey?: string): string | undefined {
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

export function resolveAnthropicCustomHeaders(model: Model<"anthropic-messages">): Record<string, string> | undefined {
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

export function buildClaudeCodeTlsFetchOptions(
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
export function mergeHeaders(...headerSources: (Record<string, string> | undefined)[]): Record<string, string> {
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

export const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

export type RawMessagePingEvent = { type: "ping" };
export type AnthropicStreamEvent = RawMessageStreamEvent | RawMessagePingEvent;
export const ANTHROPIC_PING_EVENT: RawMessagePingEvent = { type: "ping" };

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

export type AnthropicRawResponseRequest = {
	asResponse(): Promise<Response>;
};

function hasAnthropicRawResponseRequest(request: unknown): request is AnthropicRawResponseRequest {
	return isRecord(request) && typeof request.asResponse === "function";
}

export type AnthropicStreamWithResponseRequest = {
	withResponse(): Promise<{
		data: AsyncIterable<RawMessageStreamEvent>;
		response: Response;
		request_id: string | null;
	}>;
};

function hasAnthropicStreamWithResponseRequest(request: unknown): request is AnthropicStreamWithResponseRequest {
	return isRecord(request) && typeof request.withResponse === "function";
}

export async function getAnthropicStreamResponse(
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

export async function* observeDecodedAnthropicSdkEvents(
	events: AsyncIterable<AnthropicStreamEvent>,
	observer: (event: RawSseEvent) => void,
): AsyncGenerator<AnthropicStreamEvent> {
	for await (const event of events) {
		const data = JSON.stringify(event);

		notifyRawSseEvent(observer, { event: event.type, data, raw: [`event: ${event.type}`, `data: ${data}`] });
		yield event;
	}
}

export const PROVIDER_MAX_RETRIES = 10;

export const PING_PROGRESS_MAX_IDLE_MULTIPLIER = 3;

export function reportAnthropicEnvelopeAnomaly(detail: string): void {
	logger.warn(`anthropic: ignoring malformed stream envelope: ${detail}`);
}

export function shouldIgnoreAnthropicPreambleEvent(eventType: unknown): boolean {
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

export function createEmptyUsage(premiumRequests?: number): Usage {
	const usage = emptyUsage();
	if (premiumRequests !== undefined) usage.premiumRequests = premiumRequests;
	return usage;
}

export function discardAnthropicAttempt(
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

export function fallbackServedModelFromUsage(source: AnthropicWireUsage): string | undefined {
	const iterations = source.iterations ?? [];
	for (let index = iterations.length - 1; index >= 0; index -= 1) {
		const iteration = iterations[index];
		if (iteration?.type === "fallback_message" && iteration.model?.trim()) return iteration.model;
	}
	return undefined;
}

export function resolveIterationModel(
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

export function calculateFallbackTurnCost(
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

export const INVALID_THINKING_SIGNATURE_PATTERN = /invalid\s+`?signature`?\s+in\s+`?thinking`?(?:\s+block)?/i;
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

export type AnthropicStreamBlock = (
	| ThinkingContent
	| RedactedThinkingContent
	| TextContent
	| AnthropicFallbackContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number })
) & { [kStreamingBlockIndex]: number };

export interface AnthropicStreamContext {
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

export function finalizeAnthropicStreamBlock(
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

export function resolveAnthropicStreamBetas(
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

export function handleAnthropicMessageStartEvent(
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

export function handleAnthropicContentBlockStartEvent(
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

export function handleAnthropicContentBlockDeltaEvent(
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
