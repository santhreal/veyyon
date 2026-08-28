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
