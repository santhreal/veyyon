import { isAbortError } from "@veyyon/utils/abortable";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { VALIDATION_TIMEOUT_MS } from "../api-key-validation";
import type { OAuthController } from "./types";

const PROVIDER_ID = "xiaomi";
const PROVIDER_NAME = "Xiaomi MiMo";
const STANDARD_AUTH_URL = "https://platform.xiaomimimo.com/#/console/api-keys";
const TOKEN_PLAN_AUTH_URL = "https://platform.xiaomimimo.com/console/plan-manage";
const STANDARD_API_BASE_URL = "https://api.xiaomimimo.com/v1";
const TOKEN_PLAN_KEY_PREFIX = "tp-";
const STANDARD_VALIDATION_MODEL = "mimo-v2.5";
const TOKEN_PLAN_VALIDATION_MODEL = "mimo-v2.5";
const TOKEN_PLAN_SGP_API_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";
const TOKEN_PLAN_AMS_API_BASE_URL = "https://token-plan-ams.xiaomimimo.com/v1";
const TOKEN_PLAN_CN_API_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";

export type XiaomiTokenPlanRegion = "sgp" | "ams" | "cn";

type XiaomiValidationEndpoint = {
	baseUrl: string;
	model: string;
};

const TOKEN_PLAN_VALIDATION_ENDPOINTS: Record<XiaomiTokenPlanRegion, XiaomiValidationEndpoint> = {
	sgp: { baseUrl: TOKEN_PLAN_SGP_API_BASE_URL, model: TOKEN_PLAN_VALIDATION_MODEL },
	ams: { baseUrl: TOKEN_PLAN_AMS_API_BASE_URL, model: TOKEN_PLAN_VALIDATION_MODEL },
	cn: { baseUrl: TOKEN_PLAN_CN_API_BASE_URL, model: TOKEN_PLAN_VALIDATION_MODEL },
};

const TOKEN_PLAN_REGION_NAMES: Record<XiaomiTokenPlanRegion, string> = {
	sgp: "Singapore",
	ams: "Europe",
	cn: "China",
};

function isTokenPlanKey(apiKey: string): boolean {
	return apiKey.startsWith(TOKEN_PLAN_KEY_PREFIX);
}

async function validateXiaomiApiKey(
	apiKey: string,
	tokenPlanRegion: XiaomiTokenPlanRegion | undefined,
	signal?: AbortSignal,
	fetchOverride?: FetchImpl,
): Promise<void> {
	const fetchImpl = fetchOverride ?? fetch;
	const endpoints = tokenPlanRegion
		? [TOKEN_PLAN_VALIDATION_ENDPOINTS[tokenPlanRegion]]
		: isTokenPlanKey(apiKey)
			? [
					TOKEN_PLAN_VALIDATION_ENDPOINTS.sgp,
					TOKEN_PLAN_VALIDATION_ENDPOINTS.ams,
					TOKEN_PLAN_VALIDATION_ENDPOINTS.cn,
				]
			: [{ baseUrl: STANDARD_API_BASE_URL, model: STANDARD_VALIDATION_MODEL }];

	let lastError: Error | null = null;

	for (const ep of endpoints) {
		const attemptTimeout = scopedTimeoutSignal(VALIDATION_TIMEOUT_MS, signal);
		try {
			const response = await fetchImpl(`${ep.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: ep.model,
					max_tokens: 1,
					messages: [{ role: "user", content: "ping" }],
				}),
				signal: attemptTimeout.signal,
			});

			if (response.ok) {
				return;
			}

			if (response.status === 401) {
				let details = "";
				try {
					details = (await response.text()).trim();
				} catch {}
				lastError = new AIError.OAuthError(
					details
						? `${PROVIDER_NAME} API key validation failed (${response.status}): ${details}`
						: `${PROVIDER_NAME} API key validation failed (${response.status})`,
					{ kind: "validation", provider: PROVIDER_ID, status: response.status },
				);
				continue;
			}

			let details = "";
			try {
				details = (await response.text()).trim();
			} catch {}
			const message = details
				? `${PROVIDER_NAME} API key validation failed (${response.status}): ${details}`
				: `${PROVIDER_NAME} API key validation failed (${response.status})`;
			throw new AIError.OAuthError(message, {
				kind: "validation",
				provider: PROVIDER_ID,
				status: response.status,
			});
		} catch (e) {
			if (isAbortError(e) && signal?.aborted) {
				throw e;
			}
			lastError = e instanceof Error ? e : new Error(String(e));
		} finally {
			attemptTimeout.cancel();
		}
	}
	throw (
		lastError ??
		new AIError.OAuthError(`${PROVIDER_NAME} API key validation failed`, {
			kind: "validation",
			provider: PROVIDER_ID,
		})
	);
}

export async function loginXiaomi(options: OAuthController): Promise<string> {
	const fetchImpl = options.fetch ?? fetch;
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(PROVIDER_NAME);
	}
	options.onAuth?.({
		url: STANDARD_AUTH_URL,
		instructions: "Copy your API key from the Xiaomi MiMo console",
	});
	const apiKey = await options.onPrompt({
		message: "Paste your Xiaomi API key (sk-... or token-plan tp-...)",
		placeholder: "sk-... or tp-...",
		secret: true,
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.(`Validating ${PROVIDER_ID} API key...`);
	await validateXiaomiApiKey(trimmed, undefined, options.signal, fetchImpl);
	return trimmed;
}

export async function loginXiaomiTokenPlan(options: OAuthController, region: XiaomiTokenPlanRegion): Promise<string> {
	const fetchImpl = options.fetch ?? fetch;
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(`Xiaomi Token Plan (${TOKEN_PLAN_REGION_NAMES[region]})`);
	}
	options.onAuth?.({
		url: TOKEN_PLAN_AUTH_URL,
		instructions: `Copy your token-plan API key for the ${TOKEN_PLAN_REGION_NAMES[region]} region`,
	});
	const apiKey = await options.onPrompt({
		message: `Paste your Xiaomi Token Plan ${TOKEN_PLAN_REGION_NAMES[region]} API key (tp-...)`,
		placeholder: "tp-...",
		secret: true,
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.(`Validating Xiaomi Token Plan (${TOKEN_PLAN_REGION_NAMES[region]}) API key...`);
	await validateXiaomiApiKey(trimmed, region, options.signal, fetchImpl);
	return trimmed;
}
