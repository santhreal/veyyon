/**
 * Composer predictions: the message the user is likely to send next, requested
 * after a turn ends and shown as ghost text in the empty composer.
 *
 * A prediction is an ephemeral side turn over the session's history (the
 * `/btw` pipeline): it reads the conversation and writes nothing back. Two
 * sources request it:
 *
 * - `codex` follows the Codex desktop app. The ChatGPT backend serves the
 *   prompt, its version, the reasoning effort and the models it refuses
 *   (`/wham/predictions/config`), and the turn goes to an OpenAI Codex model
 *   classified as an ephemeral fork with `thread_source: "composer_predictions"`.
 * - `model` sends this package's prompt to any model with credentials.
 *
 * Both ask for `{"suggestion": string | null}` and read it the same way.
 */
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import type { FetchImpl } from "@veyyon/ai/types";
import { type CodexPredictionsConfig, fetchCodexPredictionsConfig } from "@veyyon/ai/usage/openai-codex-predictions";
import { getCodexAccountId } from "@veyyon/catalog/wire/codex";
import { getModelMatchPreferences, normalizeModelPatternList, resolveCliModel } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import { concreteThinkingLevel, parseThinkingLevel } from "../thinking";
import type { AgentSession } from "./agent-session";

/** `thread_source` of a Codex prediction fork, spelled as codex-rs spells it. */
export const CODEX_PREDICTION_THREAD_SOURCE = "composer_predictions";

/** How long a fetched Codex predictions config is reused; the Codex app caches it for five minutes. */
const CODEX_CONFIG_TTL_MS = 5 * 60 * 1000;

/** JSON Schema of the reply, appended to the Codex prompt as the Codex app appends it. */
const SUGGESTION_SCHEMA =
	'{"type":"object","properties":{"suggestion":{"anyOf":[{"type":"string"},{"type":"null"}]}},"required":["suggestion"],"additionalProperties":false}';

/** Upper bound on an accepted suggestion; both prompts ask for at most 240 characters. */
const MAX_SUGGESTION_CHARS = 1000;

export type ComposerPredictionOutcome =
	/** A suggestion to show. */
	| { kind: "prediction"; text: string }
	/** The model saw no grounded next message. */
	| { kind: "none" }
	/** The configuration cannot produce predictions; `reason` states why and what to change. */
	| { kind: "unavailable"; reason: string };

/**
 * Read a prediction reply. Accepts the JSON object alone or wrapped in prose or
 * a code fence. Returns `undefined` when the reply has no readable
 * `suggestion`, and `null` when the model returned `null` or an empty string.
 */
export function parsePredictionReply(reply: string): string | null | undefined {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("suggestion" in parsed)) return undefined;
	const { suggestion } = parsed;
	if (suggestion === null) return null;
	if (typeof suggestion !== "string") return undefined;
	// The composer shows one row and the user sends one message: fold line
	// breaks the model added despite the one-line instruction.
	const text = suggestion.replace(/\s*\n\s*/g, " ").trim();
	if (!text) return null;
	return text.length > MAX_SUGGESTION_CHARS ? undefined : text;
}

interface CachedCodexConfig {
	config: CodexPredictionsConfig;
	fetchedAt: number;
}

/**
 * Requests composer predictions for one session. Holds the Codex config cache,
 * keyed by ChatGPT account, so a run of turns reads the config once.
 */
export class ComposerPredictor {
	#codexConfigs = new Map<string, CachedCodexConfig>();

	constructor(
		private readonly session: AgentSession,
		private readonly settings: Settings,
		private readonly fetchImpl: FetchImpl = fetch,
	) {}

	async predict(signal: AbortSignal): Promise<ComposerPredictionOutcome> {
		const target = this.#resolveTarget();
		if ("reason" in target) return { kind: "unavailable", reason: target.reason };
		const { model, thinkingLevel } = target;

		let promptText: string;
		let effort = thinkingLevel;
		let codexThreadSource: string | undefined;
		if (this.settings.get("composer.predictions.source") === "codex") {
			if (model.api !== "openai-codex-responses") {
				return {
					kind: "unavailable",
					reason: `Codex predictions need an OpenAI Codex model; ${model.provider}/${model.id} is not one. Set Prediction Model to an OpenAI Codex model or Prediction Source to Model.`,
				};
			}
			const config = await this.#codexConfig(model, signal);
			if (!config.enabled) {
				return { kind: "unavailable", reason: "Codex predictions are disabled for this ChatGPT account." };
			}
			if (config.unsupportedModels.includes(model.id)) {
				return {
					kind: "unavailable",
					reason: `Codex serves no predictions for ${model.id}. Set Prediction Model to another OpenAI Codex model.`,
				};
			}
			promptText = `${config.prompt}\n\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`;
			effort = thinkingLevel ?? parseThinkingLevel(config.reasoningEffort);
			codexThreadSource = CODEX_PREDICTION_THREAD_SOURCE;
		} else {
			promptText = `${sideChannelPrompts["side-channel/composer-prediction"].text}\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`;
			if (model.api === "openai-codex-responses") codexThreadSource = CODEX_PREDICTION_THREAD_SOURCE;
		}

		const { replyText } = await this.session.runEphemeralTurn({
			promptText,
			signal,
			model,
			thinkingLevel: effort,
			codexThreadSource,
		});
		const text = parsePredictionReply(replyText);
		if (text === undefined) throw new Error("Prediction reply is not a JSON suggestion object");
		return text === null ? { kind: "none" } : { kind: "prediction", text };
	}

	/** The model a prediction goes to: Prediction Model when set, else the session's. */
	#resolveTarget(): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | { reason: string } {
		const pattern = normalizeModelPatternList(this.settings.get("composer.predictions.model"))[0];
		if (!pattern) {
			const model = this.session.model;
			return model ? { model } : { reason: "No active model to predict with." };
		}
		const registry = this.session.modelRegistry;
		const resolved = resolveCliModel({
			cliModel: pattern,
			modelRegistry: registry,
			preferences: getModelMatchPreferences(this.settings),
			settings: this.settings,
		});
		if (resolved.error || !resolved.model) {
			return { reason: `Prediction Model "${pattern}" does not resolve: ${resolved.error ?? "no matching model"}.` };
		}
		if (!registry.hasConfiguredAuth(resolved.model)) {
			return {
				reason: `Prediction Model ${resolved.model.provider}/${resolved.model.id} has no credentials. Log in to ${resolved.model.provider} or choose another model.`,
			};
		}
		return { model: resolved.model, thinkingLevel: concreteThinkingLevel(resolved.thinkingLevel) };
	}

	async #codexConfig(model: Model<Api>, signal: AbortSignal): Promise<CodexPredictionsConfig> {
		const accessToken = await this.session.modelRegistry.getApiKey(model, this.session.sessionId);
		if (!accessToken) throw new Error(`No OpenAI Codex credential for ${model.provider}`);
		const accountId = getCodexAccountId(accessToken);
		const key = accountId ?? model.provider;
		const cached = this.#codexConfigs.get(key);
		if (cached && Date.now() - cached.fetchedAt < CODEX_CONFIG_TTL_MS) return cached.config;
		const config = await fetchCodexPredictionsConfig({
			accessToken,
			accountId,
			baseUrl: model.baseUrl,
			fetch: this.fetchImpl,
			signal,
		});
		this.#codexConfigs.set(key, { config, fetchedAt: Date.now() });
		return config;
	}
}
