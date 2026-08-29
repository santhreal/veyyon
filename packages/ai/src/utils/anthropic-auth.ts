import { ANTHROPIC_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { $env } from "@veyyon/utils/env";
import { normalizeBaseUrl } from "@veyyon/utils/url";
import {
	buildAnthropicHeaders as buildProviderAnthropicHeaders,
	normalizeAnthropicBaseUrl,
	resolveAnthropicCustomHeadersForBaseUrl,
} from "../providers/anthropic";
import { isFoundryEnabled } from "./foundry";

export interface AnthropicAuthConfig {
	apiKey: string;
	baseUrl: string;
	isOAuth: boolean;
}

function resolveAnthropicBaseUrlFromEnv(): string | undefined {
	if (isFoundryEnabled()) {
		const foundryBaseUrl = normalizeBaseUrl($env.FOUNDRY_BASE_URL);
		if (foundryBaseUrl) return foundryBaseUrl;
	}
	const anthropicBaseUrl = normalizeBaseUrl($env.ANTHROPIC_BASE_URL);
	return anthropicBaseUrl || undefined;
}

export function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

export function buildAnthropicAuthConfig(apiKey: string, baseUrl?: string): AnthropicAuthConfig {
	return {
		apiKey,
		baseUrl: normalizeBaseUrl(baseUrl) ?? resolveAnthropicBaseUrlFromEnv() ?? ANTHROPIC_API_ENDPOINT,
		isOAuth: isOAuthToken(apiKey),
	};
}

export function buildAnthropicSearchHeaders(auth: AnthropicAuthConfig): Record<string, string> {
	return buildProviderAnthropicHeaders({
		apiKey: auth.apiKey,
		baseUrl: auth.baseUrl,
		isOAuth: auth.isOAuth,
		extraBetas: ["web-search-2025-03-05"],
		stream: false,
		modelHeaders: resolveAnthropicCustomHeadersForBaseUrl(auth.baseUrl),
	});
}

export function buildAnthropicUrl(auth: AnthropicAuthConfig): string {
	const normalizedBaseUrl = normalizeAnthropicBaseUrl(auth.baseUrl);
	const base = `${normalizedBaseUrl}/v1/messages`;
	return `${base}?beta=true`;
}
