/**
 * Composer predictions run after every turn, unasked, so the mode decides what each one may cost.
 * `chatgpt-pro` (the default) requests one only where OpenAI states predictions draw on no Codex
 * limits or credits: a ChatGPT Pro plan login and a model OpenAI lists as supported
 * (`INCLUDED_PREDICTION_MODELS`). The request carries that Pro login's own token, never one the
 * session's account routing picks. Any other plan, a token that is not a JWT, no Codex login, a
 * runtime or configured key that replaces the Codex logins, or no supported model sends nothing at
 * all, not even the config read, and reports nothing. `off` sends nothing. `custom` sends this
 * package's prompt to the first Prediction Model with credentials, from any provider, or to the
 * session's model when none is set.
 *
 * These drive a real `AgentSession`, its `runEphemeralTurn` and a real `AuthStorage` holding the
 * Codex logins; only the provider stream, the model lookup and the config endpoint are replaced.
 * Not covered: whether the backend in fact exempts a prediction turn from usage, which only the
 * backend states; a `models.yml` key command, which the settings screen suite drives through a real
 * `ModelRegistry`; and the bytes the Codex provider puts on the wire for a fork, which
 * `packages/ai/test/openai-codex-stream.test.ts` pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import type { FetchImpl } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { sideChannelPrompts } from "@veyyon/coding-agent/prompts/side-channel/rows";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	ComposerPredictor,
	INCLUDED_PREDICTION_MODELS,
	parsePredictionReply,
} from "@veyyon/coding-agent/session/composer-prediction";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";
import { CODEX_ENV_TOKEN, codexToken, storeCodexLogins } from "./helpers/codex-logins";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const CODEX_PROMPT = "Predict the user's next message from the conversation.";
const CODEX = "openai-codex";

function model(api: Api, id: string, provider: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as ModelSpec<Api>) as Model<Api>;
}

const [SUPPORTED_ID, SECOND_SUPPORTED_ID] = INCLUDED_PREDICTION_MODELS;
if (!SUPPORTED_ID || !SECOND_SUPPORTED_ID) throw new Error("expected two supported prediction models");
const CODEX_MODEL = model("openai-codex-responses", SUPPORTED_ID, CODEX);
const SECOND_CODEX_MODEL = model("openai-codex-responses", SECOND_SUPPORTED_ID, CODEX);
/** An OpenAI Codex model OpenAI does not list for predictions. */
const UNLISTED_CODEX_MODEL = model("openai-codex-responses", "gpt-5.5", CODEX);
/** A supported model id served by another provider on the Codex API, which must never receive a ChatGPT token. */
const FOREIGN_CODEX_API_MODEL = model("openai-codex-responses", SUPPORTED_ID, "codex-proxy");
const ANTHROPIC_MODEL = model("anthropic-messages", "claude-test", "anthropic");
const OPENAI_MODEL = model("openai-responses", "gpt-test", "openai");
const ALL_MODELS = [
	CODEX_MODEL,
	SECOND_CODEX_MODEL,
	UNLISTED_CODEX_MODEL,
	FOREIGN_CODEX_API_MODEL,
	ANTHROPIC_MODEL,
	OPENAI_MODEL,
];

interface Sent {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

/**
 * The Codex prediction config endpoint answering `payload`. `requested` holds the URL of every request
 * the endpoint received, so a case reads which config reads the predictor made.
 */
function configFetch(payload: Record<string, unknown>): { fetch: FetchImpl; requested: string[] } {
	const requested: string[] = [];
	const fetch: FetchImpl = async input => {
		requested.push(input instanceof Request ? input.url : String(input));
		return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { fetch, requested };
}

const CODEX_CONFIG = {
	is_enabled: true,
	prompt: CODEX_PROMPT,
	prompt_version: "5",
	prediction_reasoning_effort: "high",
	unsupported_models: [],
};

/** The Codex logins a case starts with. */
interface CodexLogins {
	/** Plans of the stored OpenAI Codex accounts, in storage order. */
	stored?: readonly string[];
	/** The `OPENAI_CODEX_OAUTH_TOKEN` value. */
	env?: string;
	/** An `--api-key` for the Codex provider. */
	runtimeKey?: string;
	/** A `models.yml` key for the Codex provider. */
	configKey?: string;
}

const makeTempDir = useTrackedTempDirs("veyyon-composer-prediction-");

/**
 * A model registry over `models` whose credentials are `auth`: a provider has credentials when
 * `keys` holds one for it or `auth` has a login for it.
 */
function registry(auth: AuthStorage, keys: Record<string, string>, models: readonly Model<Api>[]) {
	const authed = (candidate: Model<Api>) => candidate.provider in keys || auth.hasAuth(candidate.provider);
	return {
		authStorage: auth,
		hasApiKeyOverride: (provider: string) => auth.hasApiKeyOverride(provider),
		getAll: () => models,
		getAvailable: () => models.filter(authed),
		getProviderModels: (provider: string) =>
			models.filter(candidate => candidate.provider.toLowerCase() === provider.toLowerCase()),
		find: (provider: string, id: string) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: authed,
		getApiKey: vi.fn(async (candidate: Model<Api>) => keys[candidate.provider]),
		resolver: vi.fn(() => async () => "routed-token"),
	};
}

describe("ComposerPredictor", () => {
	const sessions: AgentSession[] = [];
	const stores: AuthStorage[] = [];
	let hostEnvToken: string | undefined;

	beforeEach(() => {
		// The host's own Codex login must not decide what this suite observes.
		hostEnvToken = Bun.env[CODEX_ENV_TOKEN];
		delete Bun.env[CODEX_ENV_TOKEN];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const auth of stores.splice(0)) auth.close();
		if (hostEnvToken === undefined) delete Bun.env[CODEX_ENV_TOKEN];
		else Bun.env[CODEX_ENV_TOKEN] = hostEnvToken;
	});

	async function setup(options: {
		activeModel: Model<Api>;
		codex?: CodexLogins;
		keys?: Record<string, string>;
		models?: readonly Model<Api>[];
		reply?: string;
		settings?: Record<string, unknown>;
	}) {
		const auth = await AuthStorage.create(path.join(makeTempDir(), "auth.db"));
		stores.push(auth);
		const codex = options.codex ?? {};
		const tokens = await storeCodexLogins(auth, codex.stored ?? []);
		if (codex.env !== undefined) Bun.env[CODEX_ENV_TOKEN] = codex.env;
		if (codex.runtimeKey !== undefined) auth.setRuntimeApiKey(CODEX, codex.runtimeKey);
		if (codex.configKey !== undefined) auth.setConfigApiKey(CODEX, codex.configKey);

		const reply = options.reply ?? '{"suggestion":"run the parser tests"}';
		const sent: Sent[] = [];
		const sideStreamFn: StreamFn = (streamModel, context, streamOptions) => {
			sent.push({ model: streamModel, context, options: streamOptions });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(reply);
				stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const settings = Settings.isolated({ "compaction.enabled": false, ...options.settings });
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: options.activeModel,
					systemPrompt: ["system prompt"],
					messages: [
						{ role: "user", content: "fix the build", timestamp: 1 },
						createAssistantMessage("The build is fixed. Tests still fail in parser.test.ts."),
					],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry(auth, options.keys ?? {}, options.models ?? ALL_MODELS) as never,
			sideStreamFn,
		});
		sessions.push(session);
		return { session, settings, sent, auth, tokens };
	}

	async function predict(
		session: AgentSession,
		settings: Settings,
		fetchImpl: FetchImpl = configFetch(CODEX_CONFIG).fetch,
	) {
		return new ComposerPredictor(session, settings, fetchImpl).predict(new AbortController().signal);
	}

	function lastUserText(context: Context | undefined): string {
		const message = context?.messages.at(-1);
		if (message?.role !== "user") throw new Error("expected the prompt as the last user message");
		return typeof message.content === "string"
			? message.content
			: message.content.map(block => (block.type === "text" ? block.text : "")).join("");
	}

	describe("ChatGPT Pro included prediction (the default)", () => {
		it("is the default mode", () => {
			expect(Settings.isolated({}).get("composer.predictions.mode")).toBe("chatgpt-pro");
		});

		it("sends the backend's prompt and effort as a Codex prediction fork with the Pro login's token", async () => {
			const { session, settings, sent, tokens } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["pro"] },
			});
			const outcome = await predict(session, settings);

			expect(outcome).toEqual({ kind: "prediction", text: "run the parser tests" });
			expect(sent).toHaveLength(1);
			expect(sent[0]?.model.id).toBe(CODEX_MODEL.id);
			expect(sent[0]?.options?.apiKey).toBe(tokens[0]);
			expect(lastUserText(sent[0]?.context)).toStartWith(CODEX_PROMPT);
			expect(sent[0]?.options?.codexFork).toEqual({
				parentSessionId: expect.any(String),
				threadSource: "composer_predictions",
			});
			expect(sent[0]?.options?.reasoning).toBe(Effort.High);
			expect(session.messages).toHaveLength(2);
		});

		it("predicts with the first supported Codex model when the session's model is from another provider", async () => {
			const { session, settings, sent } = await setup({
				activeModel: ANTHROPIC_MODEL,
				codex: { stored: ["pro"] },
				keys: { anthropic: "sk-ant-test" },
			});
			const outcome = await predict(session, settings);

			expect(outcome.kind).toBe("prediction");
			expect(sent.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual([`${CODEX}/${CODEX_MODEL.id}`]);
		});

		it("predicts with a supported model, never the session's, when the session's Codex model is not listed", async () => {
			const { session, settings, sent } = await setup({
				activeModel: UNLISTED_CODEX_MODEL,
				codex: { stored: ["pro"] },
			});
			await predict(session, settings);

			expect(sent.map(entry => entry.model.id)).toEqual([CODEX_MODEL.id]);
		});

		it("falls back to the next supported model when the backend refuses the session's", async () => {
			const { session, settings, sent } = await setup({ activeModel: CODEX_MODEL, codex: { stored: ["pro"] } });
			const config = configFetch({ ...CODEX_CONFIG, unsupported_models: [CODEX_MODEL.id] });
			await predict(session, settings, config.fetch);

			expect(sent.map(entry => entry.model.id)).toEqual([SECOND_CODEX_MODEL.id]);
			expect(config.requested).toHaveLength(1);
		});

		it("reads the Codex config once across consecutive predictions", async () => {
			const { session, settings } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["pro"] },
				reply: '{"suggestion":null}',
			});
			const config = configFetch(CODEX_CONFIG);
			const predictor = new ComposerPredictor(session, settings, config.fetch);
			await predictor.predict(new AbortController().signal);
			await predictor.predict(new AbortController().signal);
			expect(config.requested).toHaveLength(1);
		});

		it("sends a stored Pro account's token when an earlier stored account is on another plan", async () => {
			const { session, settings, sent, tokens } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["plus", "pro"] },
			});
			const outcome = await predict(session, settings);

			expect(outcome.kind).toBe("prediction");
			expect(sent).toHaveLength(1);
			expect(sent[0]?.options?.apiKey).toBe(tokens[1]);
		});

		it("prefers the Pro account the session is routed to over an earlier stored one", async () => {
			const { session, settings, sent, auth, tokens } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["pro", "pro"] },
			});
			const second = auth.listStoredCredentials(CODEX)[1];
			if (!second) throw new Error("expected two stored Codex accounts");
			expect(auth.selectProviderCredential(CODEX, second.id, { sessionId: session.sessionId })).toBe(true);
			await predict(session, settings);

			expect(sent[0]?.options?.apiKey).toBe(tokens[1]);
		});

		it("sends the environment login's token when it is the only Pro login", async () => {
			const envToken = codexToken("pro", "acct_env");
			const { session, settings, sent } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["plus"], env: envToken },
			});
			const outcome = await predict(session, settings);

			expect(outcome.kind).toBe("prediction");
			expect(sent[0]?.options?.apiKey).toBe(envToken);
		});

		const unpaidLogins: [string, CodexLogins, Record<string, string>?][] = [
			["the Codex login is on the Plus plan", { stored: ["plus"] }],
			["the Codex login is on the Pro Lite plan", { stored: ["prolite"] }],
			["the Codex token states no plan", { env: codexToken(undefined) }],
			["the Codex credential is not a JWT", { env: "sk-codex-not-a-jwt" }],
			["there is no Codex login", {}, { anthropic: "sk-ant-test" }],
			["an --api-key replaces a stored Pro login", { stored: ["pro"], runtimeKey: "sk-runtime" }],
			["a models.yml key replaces a stored Pro login", { stored: ["pro"], configKey: "sk-config" }],
			["an --api-key replaces an environment Pro login", { env: codexToken("pro"), runtimeKey: "sk-runtime" }],
		];
		it.each(
			unpaidLogins.flatMap(([label, codex, keys]) =>
				[CODEX_MODEL, ANTHROPIC_MODEL].map(
					activeModel => [label, activeModel.provider, activeModel, codex, keys ?? {}] as const,
				),
			),
		)("requests and reports nothing when %s, on a %s session", async (_case, _provider, activeModel, codex, keys) => {
			const { session, settings, sent } = await setup({ activeModel, codex, keys });
			const config = configFetch(CODEX_CONFIG);
			const outcome = await predict(session, settings, config.fetch);
			expect(outcome).toEqual({ kind: "skipped" });
			expect(config.requested).toEqual([]);
			expect(sent).toHaveLength(0);
		});

		it("requests and reports nothing on a Pro login when no supported model is from OpenAI Codex", async () => {
			const { session, settings, sent } = await setup({
				activeModel: UNLISTED_CODEX_MODEL,
				codex: { stored: ["pro"] },
				models: [UNLISTED_CODEX_MODEL, FOREIGN_CODEX_API_MODEL, ANTHROPIC_MODEL],
			});
			const config = configFetch(CODEX_CONFIG);
			const outcome = await predict(session, settings, config.fetch);

			expect(outcome).toEqual({ kind: "skipped" });
			expect(config.requested).toEqual([]);
			expect(sent).toHaveLength(0);
		});

		it.each([
			["the account has predictions disabled", { ...CODEX_CONFIG, is_enabled: false }],
			[
				"the backend refuses every supported model",
				{ ...CODEX_CONFIG, unsupported_models: [CODEX_MODEL.id, SECOND_CODEX_MODEL.id] },
			],
		])("sends no prediction and reports nothing when %s", async (_case, payload) => {
			const { session, settings, sent } = await setup({ activeModel: CODEX_MODEL, codex: { stored: ["pro"] } });
			const outcome = await predict(session, settings, configFetch(payload).fetch);
			expect(outcome).toEqual({ kind: "skipped" });
			expect(sent).toHaveLength(0);
		});
	});

	it("Off requests nothing, even on a Pro login", async () => {
		const { session, settings, sent } = await setup({
			activeModel: CODEX_MODEL,
			codex: { stored: ["pro"] },
			settings: { "composer.predictions.mode": "off" },
		});
		const config = configFetch(CODEX_CONFIG);
		const outcome = await predict(session, settings, config.fetch);

		expect(outcome).toEqual({ kind: "skipped" });
		expect(config.requested).toEqual([]);
		expect(sent).toHaveLength(0);
	});

	describe("Custom", () => {
		it("sends the built-in prompt to the session's model when no Prediction Model is set", async () => {
			const { session, settings, sent } = await setup({
				activeModel: ANTHROPIC_MODEL,
				keys: { anthropic: "sk-ant-test" },
				reply: '{"suggestion":null}',
				settings: { "composer.predictions.mode": "custom" },
			});
			const config = configFetch(CODEX_CONFIG);
			const outcome = await predict(session, settings, config.fetch);

			expect(outcome).toEqual({ kind: "none" });
			expect(config.requested).toEqual([]);
			expect(sent[0]?.model.id).toBe(ANTHROPIC_MODEL.id);
			expect(lastUserText(sent[0]?.context)).toStartWith(
				sideChannelPrompts["side-channel/composer-prediction"].text.trim(),
			);
			expect(sent[0]?.options?.codexFork).toBeUndefined();
		});

		it("uses the first Prediction Model with credentials, from any provider", async () => {
			const { session, settings, sent } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["pro"] },
				keys: { openai: "sk-openai-test" },
				settings: {
					"composer.predictions.mode": "custom",
					"composer.predictions.model": ["anthropic/claude-test", "openai/gpt-test:low"],
				},
			});
			const outcome = await predict(session, settings);

			expect(outcome.kind).toBe("prediction");
			expect(sent.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual(["openai/gpt-test"]);
			expect(sent[0]?.options?.reasoning).toBe(Effort.Low);
		});

		it("reports every Prediction Model it could not use, sending nothing", async () => {
			const { session, settings, sent } = await setup({
				activeModel: CODEX_MODEL,
				codex: { stored: ["pro"] },
				settings: {
					"composer.predictions.mode": "custom",
					"composer.predictions.model": ["anthropic/claude-test", "openai/gpt-test"],
				},
			});
			const outcome = await predict(session, settings);

			expect(outcome).toEqual({
				kind: "unavailable",
				reason:
					"No Prediction Model is usable: anthropic/claude-test has no credentials; openai/gpt-test has no credentials. Log in to a provider or choose another model.",
			});
			expect(sent).toHaveLength(0);
		});

		it("fails on a reply with no suggestion object", async () => {
			const { session, settings } = await setup({
				activeModel: ANTHROPIC_MODEL,
				keys: { anthropic: "sk-ant-test" },
				reply: "Sure! You could run the tests.",
				settings: { "composer.predictions.mode": "custom" },
			});
			await expect(predict(session, settings)).rejects.toThrow("not a JSON suggestion");
		});
	});
});

describe("parsePredictionReply", () => {
	it.each([
		['{"suggestion":"run it"}', "run it"],
		['Here you go:\n```json\n{"suggestion": "run it"}\n```', "run it"],
		['{"suggestion":"run\\n  it"}', "run it"],
		['{"suggestion":null}', null],
		['{"suggestion":"   "}', null],
		['{"suggestion":42}', undefined],
		['{"other":"run it"}', undefined],
		["no json here", undefined],
		[`{"suggestion":"${"a".repeat(1001)}"}`, undefined],
	])("reads %j as %j", (reply, expected) => {
		expect(parsePredictionReply(reply)).toBe(expected);
	});
});
