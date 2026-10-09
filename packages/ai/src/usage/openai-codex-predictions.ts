/**
 * OpenAI Codex composer-prediction configuration client.
 *
 *   GET /wham/predictions/config
 *
 * The ChatGPT backend serves the remote half of the Codex desktop "suggested
 * next message" feature: whether the account may request predictions, the
 * prompt that asks for one, its version, the reasoning effort to request it
 * at, and the models the backend refuses predictions for. The prediction
 * itself is an ordinary Codex turn sent as an ephemeral fork of the session
 * (`thread_source: "composer_predictions"`); this module covers only the
 * configuration read.
 */
import { OPENAI_HEADER_VALUES, OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";
import type { FetchImpl } from "../types";
import { isRecord } from "../utils";
import { normalizeCodexBaseUrl } from "./openai-codex-base-url";

const PREDICTIONS_CONFIG_PATH = "wham/predictions/config";

/** Remote composer-prediction configuration for one ChatGPT account. */
export interface CodexPredictionsConfig {
	enabled: boolean;
	/** Instruction sent as the prediction turn's user message. */
	prompt: string;
	promptVersion: string;
	/** Effort the prediction turn requests; `undefined` keeps the session's. */
	reasoningEffort?: string;
	/** Model ids the backend serves no predictions for. */
	unsupportedModels: string[];
}

export interface CodexPredictionsAuth {
	accessToken: string;
	accountId?: string;
	/** Provider base URL override; defaults to the Codex backend. */
	baseUrl?: string;
	fetch: FetchImpl;
	signal?: AbortSignal;
}

/**
 * Parse a `/wham/predictions/config` payload. Returns `null` when a required
 * field is missing or mistyped, so a changed contract reads as "unavailable"
 * rather than as a prediction sent with a half-read prompt.
 */
export function parseCodexPredictionsConfig(payload: unknown): CodexPredictionsConfig | null {
	if (!isRecord(payload)) return null;
	const { is_enabled, prompt, prompt_version, prediction_reasoning_effort, unsupported_models } = payload;
	if (typeof is_enabled !== "boolean" || typeof prompt !== "string" || typeof prompt_version !== "string") {
		return null;
	}
	return {
		enabled: is_enabled,
		prompt,
		promptVersion: prompt_version,
		reasoningEffort:
			typeof prediction_reasoning_effort === "string" && prediction_reasoning_effort
				? prediction_reasoning_effort
				: undefined,
		unsupportedModels: Array.isArray(unsupported_models)
			? unsupported_models.filter((id): id is string => typeof id === "string")
			: [],
	};
}

/**
 * Read the account's composer-prediction configuration. Throws on a non-2xx
 * response or an unparseable body, naming the status, so the caller can show
 * why predictions are unavailable.
 */
export async function fetchCodexPredictionsConfig(auth: CodexPredictionsAuth): Promise<CodexPredictionsConfig> {
	const base = normalizeCodexBaseUrl(auth.baseUrl);
	const url = `${base.endsWith("/") ? base : `${base}/`}${PREDICTIONS_CONFIG_PATH}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.accessToken}`,
		[OPENAI_HEADERS.ORIGINATOR]: OPENAI_HEADER_VALUES.ORIGINATOR_CODEX,
	};
	if (auth.accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = auth.accountId;
	const response = await auth.fetch(url, { headers, signal: auth.signal });
	if (!response.ok) {
		throw new Error(`Codex predictions config request failed: HTTP ${response.status}`);
	}
	const config = parseCodexPredictionsConfig(await response.json());
	if (!config) throw new Error("Codex predictions config response is malformed");
	return config;
}
