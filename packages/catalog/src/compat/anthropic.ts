import { modelMatchesHost } from "../hosts";
import {
	hasOpus47ApiRestrictions,
	isAnthropicFableOrMythosModel,
	supportsMidConversationSystemMessages,
} from "../identity/family";
import { ANTHROPIC_API_ENDPOINT } from "../provider-endpoints";
import type { ModelSpec, ResolvedAnthropicCompat } from "../types";
import { applyCompatOverrides } from "./apply";
import { matchesKimiK27CodeFamily } from "./kimi";

export function isOfficialAnthropicApiUrl(baseUrl?: string): boolean {
	if (!baseUrl) return true;
	const lower = baseUrl.toLowerCase();
	return lower === ANTHROPIC_API_ENDPOINT || lower.startsWith(`${ANTHROPIC_API_ENDPOINT}/`);
}

const CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER = /gateway\.ai\.cloudflare\.com\/.+\/anthropic(?:\/|$)/i;
const VERTEX_ANTHROPIC_URL_MARKER = /aiplatform\.googleapis\.com\/.+\/publishers\/anthropic\//i;
const BEDROCK_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com/i;
const AZURE_ANTHROPIC_URL_MARKER = /(?:^|\/\/|\.)[a-z0-9-]+\.(?:inference|services)\.ai\.azure\.com/i;

function isCloudflareAnthropicGateway(baseUrl?: string): boolean {
	return baseUrl !== undefined && CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER.test(baseUrl);
}

function isVertexAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && VERTEX_ANTHROPIC_URL_MARKER.test(baseUrl);
}

function isBedrockAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && BEDROCK_ANTHROPIC_URL_MARKER.test(baseUrl);
}

function isAzureAnthropicRoute(baseUrl?: string): boolean {
	return baseUrl !== undefined && AZURE_ANTHROPIC_URL_MARKER.test(baseUrl);
}

export function buildAnthropicCompat(spec: ModelSpec<"anthropic-messages">): ResolvedAnthropicCompat {
	const baseUrl = spec.baseUrl;
	const official = isOfficialAnthropicApiUrl(baseUrl);
	const isZai = modelMatchesHost(spec, "zai");
	const isCopilot = modelMatchesHost(spec, "githubCopilot");
	const isZenmux = modelMatchesHost(spec, "zenmux");
	const requiresThinkingEnabled = modelMatchesHost(spec, "moonshotNative") && matchesKimiK27CodeFamily(spec);
	const isVertex = isVertexAnthropicRoute(baseUrl);
	const isBedrock = isBedrockAnthropicRoute(baseUrl);
	const isAzure = isAzureAnthropicRoute(baseUrl);
	const signingEndpoint =
		official || isCopilot || isZenmux || isCloudflareAnthropicGateway(baseUrl) || isVertex || isBedrock || isAzure;
	const compat: ResolvedAnthropicCompat = {
		officialEndpoint: official,
		signingEndpoint,
		disableStrictTools: isAzure,
		disableAdaptiveThinking: false,
		supportsEagerToolInputStreaming: !isCopilot,
		supportsLongCacheRetention: official,
		supportsMidConversationSystem: official && supportsMidConversationSystemMessages(spec.id),
		supportsForcedToolChoice: !requiresThinkingEnabled && !isAnthropicFableOrMythosModel(spec.id),
		supportsSamplingParams: !hasOpus47ApiRestrictions(spec.id),
		requiresToolResultId: isZai,
		requiresThinkingEnabled,
		replayUnsignedThinking: !signingEndpoint && (Boolean(spec.reasoning) || modelMatchesHost(spec, "deepseekFamily")),
		escapeBuiltinToolNames: modelMatchesHost(spec, "umans"),
	};
	applyCompatOverrides(compat, spec.compat);
	return compat;
}
