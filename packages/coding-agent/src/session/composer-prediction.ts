/**
 * Composer predictions: the message the user is likely to send next, requested
 * after a turn ends and shown as ghost text in the empty composer.
 *
 * A prediction is an ephemeral side turn over the session's history (the
 * `/btw` pipeline): it reads the conversation and writes nothing back.
 * `composer.predictions.mode` selects who answers it:
 *
 * - `chatgpt-pro` follows the Codex desktop app, and only where OpenAI states
 *   predictions use no Codex limits or credits during the beta: a ChatGPT Pro
 *   plan and a model in {@link INCLUDED_PREDICTION_MODELS}.
 *   {@link includedPredictionLogins} selects the Codex logins whose access
 *   token states the Pro plan; the request is sent with that exact token,
 *   never one the session's account routing picks, so no other account can
 *   serve it. Any other plan, no Codex login, a key that replaces the Codex
 *   logins, or no supported model requests nothing and reports nothing. The
 *   ChatGPT backend serves the prompt, the reasoning effort and the models it
 *   refuses (`/wham/predictions/config`), and the turn goes to an OpenAI Codex
 *   model classified as an ephemeral fork with
 *   `thread_source: "composer_predictions"`.
 * - `custom` sends this package's prompt to the first Prediction Model with
 *   credentials, from any provider, or to the session's model when none is set.
 * - `off` requests nothing.
 *
 * Both ask for `{"suggestion": string | null}` and read it the same way.
 */
import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import type { FetchImpl } from "@veyyon/ai/types";
import { type CodexPredictionsConfig, fetchCodexPredictionsConfig } from "@veyyon/ai/usage/openai-codex-predictions";
import { getCodexAccountId, getCodexPlanType } from "@veyyon/catalog/wire/codex";
import type { ModelRegistry } from "../config/model-registry";
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

/**
 * Models OpenAI lists as supported for composer predictions
 * (https://help.openai.com/en/articles/20001601-composer-predictions-in-codex). A prediction runs
 * only on one of these that the backend config does not refuse; a model outside the list predicts
 * nothing rather than risk a turn the beta does not cover, which could draw on purchased credits.
 */
export const INCLUDED_PREDICTION_MODELS: readonly string[] = ["gpt-6-astra", "gpt-6.1-sol"];

/** Provider of the logins and models that answer `chatgpt-pro` predictions. */
const CODEX_PROVIDER = "openai-codex";

const CODEX_API: Api = "openai-codex-responses";

/** A Codex login that can answer a `chatgpt-pro` prediction. */
export type IncludedPredictionLogin =
	/** A stored OAuth account, by its position in `AuthStorage.listOAuthAccounts`. */
	| { kind: "account"; position: number }
	/** The `OPENAI_CODEX_OAUTH_TOKEN` environment token. */
	| { kind: "env"; token: string };

function statesIncludedPlan(token: string | undefined): boolean {
	return token !== undefined && getCodexPlanType(token) === INCLUDED_PREDICTION_PLAN;
}

/**
 * The Codex logins whose access token states the ChatGPT Pro plan, in the order a prediction tries
 * them: stored OAuth accounts, the one routed to `sessionId` first, then the environment token.
 * Empty when a runtime or configured key replaces the Codex logins, since every Codex request then
 * authenticates with that key. Reads stored tokens without refreshing them, so the settings screen
 * and the predictor select from the same set; the predictor checks the plan again on the
 * refreshed token it sends.
 */
export function includedPredictionLogins(registry: ModelRegistry, sessionId?: string): IncludedPredictionLogin[] {
	if (registry.hasApiKeyOverride(CODEX_PROVIDER)) return [];
	const auth = registry.authStorage;
	const accessById = new Map<number, string>();
	for (const row of auth.listStoredCredentials(CODEX_PROVIDER)) {
		if (row.credential.type === "oauth") accessById.set(row.id, row.credential.access);
	}
	const routed = sessionId ? auth.sessionCredentialRouting(CODEX_PROVIDER, sessionId)?.activeCredentialId : undefined;
	const accounts = auth
		.listOAuthAccounts(CODEX_PROVIDER)
		.filter(account => statesIncludedPlan(accessById.get(account.credentialId)))
		.sort((a, b) => Number(b.credentialId === routed) - Number(a.credentialId === routed));
	const logins: IncludedPredictionLogin[] = accounts.map(account => ({ kind: "account", position: account.position }));
	const envToken = getEnvApiKey(CODEX_PROVIDER);
	if (envToken && statesIncludedPlan(envToken)) logins.push({ kind: "env", token: envToken });
	return logins;
}

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
	/** The bearer the turn is sent with, bypassing the session's account routing. */
	apiKey?: string;
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
	 * A prediction covered by a ChatGPT Pro subscription. Each Pro login from
	 * {@link includedPredictionLogins} is refreshed on its own, its plan read
	 * again from the refreshed token, and that token sent as the request's key,
	 * so neither a missing login, another plan, nor an account rotation can put
	 * the request on credentials the subscription does not cover.
	 */
	async #predictIncluded(signal: AbortSignal): Promise<ComposerPredictionOutcome> {
		const logins = includedPredictionLogins(this.session.modelRegistry, this.session.sessionId);
		const models = logins.length === 0 ? [] : this.#includedCandidates();
		for (const login of logins) {
			if (models.length === 0) break;
			const accessToken = await this.#includedAccessToken(login, signal);
			if (!accessToken) continue;
			for (const model of models) {
				const config = await this.#codexConfig(model, accessToken, signal);
				if (!config.enabled) break;
				if (config.unsupportedModels.includes(model.id)) continue;
				return this.#run(
					{
						model,
						promptText: `${config.prompt}\n\nReturn only JSON matching this schema: ${SUGGESTION_SCHEMA}.`,
						thinkingLevel: parseThinkingLevel(config.reasoningEffort),
						codexThreadSource: CODEX_PREDICTION_THREAD_SOURCE,
						apiKey: accessToken,
					},
					signal,
				);
			}
		}
		return { kind: "skipped" };
	}

	/** The login's current access token when it still states the Pro plan; refreshes a stored account alone. */
	async #includedAccessToken(login: IncludedPredictionLogin, signal: AbortSignal): Promise<string | undefined> {
		if (login.kind === "env") return login.token;
		const access = await this.session.modelRegistry.authStorage.getOAuthAccessAt(CODEX_PROVIDER, login.position, {
			signal,
		});
		return access?.ok && statesIncludedPlan(access.accessToken) ? access.accessToken : undefined;
	}

	/**
	 * The session's model when it is a supported OpenAI Codex model, then each other supported model
	 * the registry has. Only the `openai-codex` provider qualifies: another provider on the Codex API
	 * has its own endpoint, which must never receive a ChatGPT token.
	 */
	#includedCandidates(): Model<Api>[] {
		const registry = this.session.modelRegistry;
		const current = this.session.model;
		const candidates: Model<Api>[] =
			current?.provider === CODEX_PROVIDER &&
			current.api === CODEX_API &&
			INCLUDED_PREDICTION_MODELS.includes(current.id)
				? [current]
				: [];
		for (const id of INCLUDED_PREDICTION_MODELS) {
			if (id === candidates[0]?.id) continue;
			const model = registry.find(CODEX_PROVIDER, id);
			if (model?.provider === CODEX_PROVIDER && model.api === CODEX_API) candidates.push(model);
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
