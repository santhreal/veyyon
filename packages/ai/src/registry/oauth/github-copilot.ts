import { scheduler } from "node:timers/promises";
import { getBundledModels } from "@veyyon/catalog/models";
import {
	COPILOT_API_HEADERS,
	getGitHubCopilotBaseUrl,
	isPublicGitHubHost,
	normalizeDomain,
	normalizeGitHubCopilotApiEndpoint,
	normalizeGitHubCopilotEnterpriseDomain,
	OPENCODE_HEADERS,
} from "@veyyon/catalog/wire/github-copilot";
import { batched } from "@veyyon/utils/array";
import { DAY_MS } from "@veyyon/utils/time";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { fetchGitHubCopilotJson } from "../../utils/github-copilot-http";
import { emitOAuthSuccessPage } from "./success-page";
import type { OAuthCredentials } from "./types";

const CLIENT_ID = "Ov23li8tweQw6odWQebz";

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

type GitHubCopilotLoginOptions = {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: {
		message: string;
		placeholder?: string;
		allowEmpty?: boolean;
		secret?: boolean;
	}) => Promise<string>;
	onProgress?: (message: string) => void;
	onSuccessPage?: (url: string) => void;
	signal?: AbortSignal;
	pollIntervalFloorMs?: number;
	pollIntervalScaleMs?: number;
	fetch?: FetchImpl;
};
type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	};
}

async function startDeviceFlow(domain: string, fetchImpl: FetchImpl): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchGitHubCopilotJson(fetchImpl, urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			...OPENCODE_HEADERS,
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new AIError.OAuthError("Invalid device code response", { kind: "validation", provider: "github-copilot" });
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new AIError.OAuthError("Invalid device code response fields", {
			kind: "validation",
			provider: "github-copilot",
		});
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
	pollIntervalFloorMs = 1000,
	pollIntervalScaleMs = 1000,
) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(pollIntervalFloorMs, Math.floor(intervalSeconds * pollIntervalScaleMs));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		try {
			await scheduler.wait(waitMs, { signal });
		} catch {
			throw new AIError.LoginCancelledError();
		}

		const raw = await fetchGitHubCopilotJson(fetchImpl, urls.accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				...OPENCODE_HEADERS,
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return (raw as DeviceTokenSuccessResponse).access_token;
		}

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0
						? Math.max(pollIntervalFloorMs, interval * pollIntervalScaleMs)
						: Math.max(pollIntervalFloorMs, intervalMs + 5 * pollIntervalScaleMs);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new AIError.OAuthError(`Device flow failed: ${error}${descriptionSuffix}`, {
				kind: "polling",
				provider: "github-copilot",
			});
		}
	}

	if (slowDownResponses > 0) {
		throw new AIError.OAuthError(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
			{ kind: "timeout", provider: "github-copilot" },
		);
	}

	throw new AIError.OAuthError("Device flow timed out", { kind: "timeout", provider: "github-copilot" });
}

const FAR_FUTURE_MS = Date.now() + 10 * 365.25 * DAY_MS;

export function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
	apiEndpoint?: string,
): OAuthCredentials {
	return {
		refresh: refreshToken,
		access: refreshToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain,
		apiEndpoint,
	};
}

async function discoverGitHubCopilotApiEndpoint(token: string, fetchImpl: FetchImpl): Promise<string | undefined> {
	try {
		const data = await fetchGitHubCopilotJson(fetchImpl, "https://api.github.com/copilot_internal/user", {
			headers: {
				Accept: "application/json",
				Authorization: `token ${token}`,
				...OPENCODE_HEADERS,
			},
		});
		if (!data || typeof data !== "object") return undefined;
		const endpoints = (data as { endpoints?: { api?: unknown } }).endpoints;
		return typeof endpoints?.api === "string" ? normalizeGitHubCopilotApiEndpoint(endpoints.api) : undefined;
	} catch {
		return undefined;
	}
}

async function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	fetchImpl: FetchImpl,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
): Promise<boolean> {
	const baseUrl = apiEndpoint ?? getGitHubCopilotBaseUrl(enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_API_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
	fetchImpl: FetchImpl,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
	const wireModelIds = Array.from(
		new Set(getBundledModels("github-copilot").map(model => model.requestModelId ?? model.id)),
	);
	const BATCH_SIZE = 5;
	for (const batch of batched(wireModelIds, BATCH_SIZE)) {
		await Promise.all(
			batch.map(async modelId => {
				const success = await enableGitHubCopilotModel(token, modelId, fetchImpl, enterpriseDomain, apiEndpoint);
				onProgress?.(modelId, success);
			}),
		);
	}
}

export async function loginGitHubCopilot(options: GitHubCopilotLoginOptions): Promise<OAuthCredentials> {
	const fetchImpl = options.fetch ?? fetch;
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
		secret: false,
	});

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = input.trim();
	const normalizedDomain = normalizeDomain(input);
	if (trimmed && !normalizedDomain) {
		throw new AIError.OAuthError("Invalid GitHub Enterprise URL/domain", {
			kind: "validation",
			provider: "github-copilot",
		});
	}
	const enterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(normalizedDomain ?? undefined);
	const domain =
		normalizedDomain && isPublicGitHubHost(normalizedDomain) ? "github.com" : (normalizedDomain ?? "github.com");

	const device = await startDeviceFlow(domain, fetchImpl);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
		fetchImpl,
		options.pollIntervalFloorMs,
		options.pollIntervalScaleMs,
	);

	const apiEndpoint = await discoverGitHubCopilotApiEndpoint(githubAccessToken, fetchImpl);

	const credentials: OAuthCredentials = {
		refresh: githubAccessToken,
		access: githubAccessToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain ?? undefined,
		apiEndpoint,
	};

	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(githubAccessToken, enterpriseDomain ?? undefined, apiEndpoint, fetchImpl);
	emitOAuthSuccessPage(options);
	return credentials;
}
