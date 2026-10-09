/**
 * Composer predictions: the message the user is likely to send next, requested
 * after a turn ends and shown as ghost text in the empty composer.
 *
 * A prediction is an ephemeral side turn over the session's history (the
 * `/btw` pipeline): it reads the conversation and writes nothing back.
 * `composer.predictions.mode` selects who answers it:
 *
 * - `chatgpt-pro` follows the Codex desktop app, and only on a ChatGPT Pro
 *   plan, so the request is covered by the subscription and bills no API
 *   usage. The plan is read from the Codex access token; any other plan, or
 *   no Codex login, requests nothing and reports nothing. The ChatGPT backend
 *   serves the prompt, the reasoning effort and the models it refuses
 *   (`/wham/predictions/config`), and the turn goes to an OpenAI Codex model
 *   classified as an ephemeral fork with `thread_source: "composer_predictions"`.
 * - `custom` sends this package's prompt to the first Prediction Model with
 *   credentials, from any provider, or to the session's model when none is set.
 * - `off` requests nothing.
 *
 * Both ask for `{"suggestion": string | null}` and read it the same way.
 */
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import type { FetchImpl } from "@veyyon/ai/types";
import { type CodexPredictionsConfig, fetchCodexPredictionsConfig } from "@veyyon/ai/usage/openai-codex-predictions";
import { DEFAULT_MODEL_PER_PROVIDER } from "@veyyon/catalog/provider-models";
import { getCodexAccountId, getCodexPlanType } from "@veyyon/catalog/wire/codex";
import { getModelMatchPreferences, normalizeModelPatternList, resolveCliModel } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import { concreteThinkingLevel, parseThinkingLevel } from "../thinking";
import type { AgentSession } from "./agent-session";

/** `thread_source` of a Codex prediction fork, spelled as codex-rs spells it. */
export const CODEX_PREDICTION_THREAD_SOURCE = "composer_predictions";

/** How long a fetched Codex predictions config is reused; the Codex app caches it for five minutes. */
const CODEX_CONFIG_TTL_MS = 5 * 60 * 1000;

/** The ChatGPT plan whose subscription covers `chatgpt-pro` predictions. */
export const INCLUDED_PREDICTION_PLAN = "pro";

/** Provider whose default model answers `chatgpt-pro` predictions when the session's model is not a Codex model. */
const CODEX_PROVIDER = "openai-codex";

const CODEX_API: Api = "openai-codex-responses";

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
	/** The mode's conditions do not hold (Off, or no ChatGPT Pro Codex login); nothing was requested or is reported. */
	| { kind: "skipped" }
	/** The configuration cannot produce predictions; `reason` states why and what to change. */
	| { kind: "unavailable"; reason: string };

interface PredictionTurn {
	model: Model<Api>;
	promptText: string;
	thinkingLevel?: ThinkingLevel;
	codexThreadSource?: string;
}

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
		switch (this.settings.get("composer.predictions.mode")) {
			case "off":
				return { kind: "skipped" };
			case "chatgpt-pro":
				return this.#predictIncluded(signal);
			case "custom":
				return this.#predictCustom(signal);
		}
	}

	/**
	 * A prediction covered by a ChatGPT Pro subscription. Every candidate whose
	 * credential is not a Pro-plan Codex token is passed over before any request,
	 * so a missing login or another plan never reaches a billable endpoint.
	 */
	async #predictIncluded(signal: AbortSignal): Promise<ComposerPredictionOutcome> {
		for (const model of this.#includedCandidates()) {
			const accessToken = await this.session.modelRegistry.getApiKey(model, this.session.sessionId);
			if (!accessToken || getCodexPlanType(accessToken) !== INCLUDED_PREDICTION_PLAN) continue;
			const config = await this.#codexConfig(model, accessToken, signal);
			if (!config.enabled || config.unsupportedModels.includes(model.id)) continue;
			return this.#run(
				{
					model,
					promptText: `${config.prompt}\n\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`,
					thinkingLevel: parseThinkingLevel(config.reasoningEffort),
					codexThreadSource: CODEX_PREDICTION_THREAD_SOURCE,
				},
				signal,
			);
		}
		return { kind: "skipped" };
	}

	/** The session's model when it is a Codex model, then the OpenAI Codex provider's default model. */
	#includedCandidates(): Model<Api>[] {
		const registry = this.session.modelRegistry;
		const candidates: Model<Api>[] = [];
		const current = this.session.model;
		if (current?.api === CODEX_API && registry.hasConfiguredAuth(current)) candidates.push(current);
		const fallback = registry.find(CODEX_PROVIDER, DEFAULT_MODEL_PER_PROVIDER[CODEX_PROVIDER]);
		if (
			fallback?.api === CODEX_API &&
			registry.hasConfiguredAuth(fallback) &&
			!(current?.provider === fallback.provider && current.id === fallback.id)
		) {
			candidates.push(fallback);
		}
		return candidates;
	}

	async #predictCustom(signal: AbortSignal): Promise<ComposerPredictionOutcome> {
		const target = this.#resolveCustomTarget();
		if ("reason" in target) return { kind: "unavailable", reason: target.reason };
		const { model, thinkingLevel } = target;
		return this.#run(
			{
				model,
				promptText: `${sideChannelPrompts["side-channel/composer-prediction"].text}\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`,
				thinkingLevel,
				codexThreadSource: model.api === CODEX_API ? CODEX_PREDICTION_THREAD_SOURCE : undefined,
			},
			signal,
		);
	}

	/** The first Prediction Model that resolves and has credentials, else the session's model when none is set. */
	#resolveCustomTarget(): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | { reason: string } {
		const patterns = normalizeModelPatternList(this.settings.get("composer.predictions.model"));
		if (patterns.length === 0) {
			const model = this.session.model;
			return model ? { model } : { reason: "No active model to predict with." };
		}
		const registry = this.session.modelRegistry;
		const failures: string[] = [];
		for (const pattern of patterns) {
			const resolved = resolveCliModel({
				cliModel: pattern,
				modelRegistry: registry,
				preferences: getModelMatchPreferences(this.settings),
				settings: this.settings,
			});
			if (resolved.error || !resolved.model) {
				failures.push(`"${pattern}" does not resolve (${resolved.error ?? "no matching model"})`);
				continue;
			}
			if (!registry.hasConfiguredAuth(resolved.model)) {
				failures.push(`${resolved.model.provider}/${resolved.model.id} has no credentials`);
				continue;
			}
			return { model: resolved.model, thinkingLevel: concreteThinkingLevel(resolved.thinkingLevel) };
		}
		return {
			reason: `No Prediction Model is usable: ${failures.join("; ")}. Log in to a provider or choose another model.`,
		};
	}

	async #run(turn: PredictionTurn, signal: AbortSignal): Promise<ComposerPredictionOutcome> {
		const { replyText } = await this.session.runEphemeralTurn({ ...turn, signal });
		const text = parsePredictionReply(replyText);
		if (text === undefined) throw new Error("Prediction reply is not a JSON suggestion object");
		return text === null ? { kind: "none" } : { kind: "prediction", text };
	}

	async #codexConfig(model: Model<Api>, accessToken: string, signal: AbortSignal): Promise<CodexPredictionsConfig> {
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
