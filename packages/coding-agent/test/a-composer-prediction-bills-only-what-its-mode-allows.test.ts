/**
 * Composer predictions run after every turn, unasked, so the mode decides what each one may cost.
 * `chatgpt-pro` (the default) requests one only through a Codex login whose token states a ChatGPT
 * Pro plan, the usage that subscription covers: any other plan, a token that is not a JWT, or no
 * Codex login sends nothing at all, not even the config read, and reports nothing. `off` sends
 * nothing. `custom` sends this package's prompt to the first Prediction Model with credentials,
 * from any provider, or to the session's model when none is set.
 *
 * These drive a real `AgentSession` and its `runEphemeralTurn`; only the provider stream, the model
 * registry and the config endpoint are replaced. Not covered: whether a ChatGPT Pro plan in fact
 * covers a Codex prediction turn, which only the backend states; and the bytes the Codex provider
 * puts on the wire for a fork, which `packages/ai/test/openai-codex-stream.test.ts` pins.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@veyyon/ai";
import type { FetchImpl } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { CODEX_JWT_AUTH_CLAIM } from "@veyyon/catalog/wire/codex";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { sideChannelPrompts } from "@veyyon/coding-agent/prompts/side-channel/rows";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { ComposerPredictor, parsePredictionReply } from "@veyyon/coding-agent/session/composer-prediction";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const CODEX_PROMPT = "Predict the user's next message from the conversation.";

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

const CODEX_MODEL = model("openai-codex-responses", "gpt-5.4", "openai-codex");
/** The OpenAI Codex provider's default model, the included-prediction fallback. */
const CODEX_DEFAULT_MODEL = model("openai-codex-responses", "gpt-5.5", "openai-codex");
const ANTHROPIC_MODEL = model("anthropic-messages", "claude-test", "anthropic");
const OPENAI_MODEL = model("openai-responses", "gpt-test", "openai");
const ALL_MODELS = [CODEX_MODEL, CODEX_DEFAULT_MODEL, ANTHROPIC_MODEL, OPENAI_MODEL];

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function codexToken(plan: string | undefined): string {
	return jwt({ [CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: "acct_test", chatgpt_plan_type: plan } });
}

const PRO_LOGIN = { "openai-codex": codexToken("pro") };

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

/** A model registry over `ALL_MODELS` where a provider has credentials exactly when `logins` holds a key for it. */
function registry(logins: Record<string, string>) {
	const authed = (candidate: Model<Api>) => candidate.provider in logins;
	return {
		getAll: () => ALL_MODELS,
		getAvailable: () => ALL_MODELS.filter(authed),
		getProviderModels: (provider: string) =>
			ALL_MODELS.filter(candidate => candidate.provider.toLowerCase() === provider.toLowerCase()),
		find: (provider: string, id: string) =>
			ALL_MODELS.find(candidate => candidate.provider === provider && candidate.id === id),
		hasConfiguredAuth: authed,
		getApiKey: vi.fn(async (candidate: Model<Api>) => logins[candidate.provider]),
		resolver: vi.fn(() => async () => "token"),
	};
}

describe("ComposerPredictor", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function setup(options: {
		activeModel: Model<Api>;
		logins: Record<string, string>;
		reply?: string;
		settings?: Record<string, unknown>;
	}) {
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
			modelRegistry: registry(options.logins) as never,
			sideStreamFn,
		});
		sessions.push(session);
		return { session, settings, sent };
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

		it("sends the backend's prompt and effort as a Codex prediction fork on a Pro login", async () => {
			const { session, settings, sent } = setup({ activeModel: CODEX_MODEL, logins: PRO_LOGIN });
			const config = configFetch(CODEX_CONFIG);
			const outcome = await new ComposerPredictor(session, settings, config.fetch).predict(
				new AbortController().signal,
			);

			expect(outcome).toEqual({ kind: "prediction", text: "run the parser tests" });
			expect(sent).toHaveLength(1);
			expect(sent[0]?.model.id).toBe(CODEX_MODEL.id);
			expect(lastUserText(sent[0]?.context)).toStartWith(CODEX_PROMPT);
			expect(sent[0]?.options?.codexFork).toEqual({
				parentSessionId: expect.any(String),
				threadSource: "composer_predictions",
			});
			expect(sent[0]?.options?.reasoning).toBe(Effort.High);
			expect(session.messages).toHaveLength(2);
		});

		it("predicts with the Codex default model when the session's model is from another provider", async () => {
			const { session, settings, sent } = setup({
				activeModel: ANTHROPIC_MODEL,
				logins: { ...PRO_LOGIN, anthropic: "sk-ant-test" },
			});
			const outcome = await new ComposerPredictor(session, settings, configFetch(CODEX_CONFIG).fetch).predict(
				new AbortController().signal,
			);

			expect(outcome.kind).toBe("prediction");
			expect(sent.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual([
				`${CODEX_DEFAULT_MODEL.provider}/${CODEX_DEFAULT_MODEL.id}`,
			]);
		});

		it("falls back to the Codex default model when the backend refuses the session's", async () => {
			const { session, settings, sent } = setup({ activeModel: CODEX_MODEL, logins: PRO_LOGIN });
			const config = configFetch({ ...CODEX_CONFIG, unsupported_models: [CODEX_MODEL.id] });
			await new ComposerPredictor(session, settings, config.fetch).predict(new AbortController().signal);

			expect(sent.map(entry => entry.model.id)).toEqual([CODEX_DEFAULT_MODEL.id]);
			expect(config.requested).toHaveLength(1);
		});

		it("reads the Codex config once across consecutive predictions", async () => {
			const { session, settings } = setup({
				activeModel: CODEX_MODEL,
				logins: PRO_LOGIN,
				reply: '{"suggestion":null}',
			});
			const config = configFetch(CODEX_CONFIG);
			const predictor = new ComposerPredictor(session, settings, config.fetch);
			await predictor.predict(new AbortController().signal);
			await predictor.predict(new AbortController().signal);
			expect(config.requested).toHaveLength(1);
		});

		it.each([
			["the Codex login is on the Plus plan", { "openai-codex": codexToken("plus") }],
			["the Codex login is on the Pro Lite plan", { "openai-codex": codexToken("prolite") }],
			["the Codex token states no plan", { "openai-codex": codexToken(undefined) }],
			["the Codex credential is not a JWT", { "openai-codex": "sk-codex-not-a-jwt" }],
			["there is no Codex login", { anthropic: "sk-ant-test" }],
		])("requests and reports nothing when %s", async (_case, logins) => {
			for (const activeModel of [CODEX_MODEL, ANTHROPIC_MODEL]) {
				const { session, settings, sent } = setup({ activeModel, logins });
				const config = configFetch(CODEX_CONFIG);
				const outcome = await new ComposerPredictor(session, settings, config.fetch).predict(
					new AbortController().signal,
				);
				expect(outcome).toEqual({ kind: "skipped" });
				expect(config.requested).toEqual([]);
				expect(sent).toHaveLength(0);
			}
		});

		it.each([
			["the account has predictions disabled", { ...CODEX_CONFIG, is_enabled: false }],
			[
				"the backend refuses every candidate model",
				{ ...CODEX_CONFIG, unsupported_models: [CODEX_MODEL.id, CODEX_DEFAULT_MODEL.id] },
			],
		])("sends no prediction and reports nothing when %s", async (_case, payload) => {
			const { session, settings, sent } = setup({ activeModel: CODEX_MODEL, logins: PRO_LOGIN });
			const outcome = await new ComposerPredictor(session, settings, configFetch(payload).fetch).predict(
				new AbortController().signal,
			);
			expect(outcome).toEqual({ kind: "skipped" });
			expect(sent).toHaveLength(0);
		});
	});

	it("Off requests nothing, even on a Pro login", async () => {
		const { session, settings, sent } = setup({
			activeModel: CODEX_MODEL,
			logins: PRO_LOGIN,
			settings: { "composer.predictions.mode": "off" },
		});
		const config = configFetch(CODEX_CONFIG);
		const outcome = await new ComposerPredictor(session, settings, config.fetch).predict(
			new AbortController().signal,
		);

		expect(outcome).toEqual({ kind: "skipped" });
		expect(config.requested).toEqual([]);
		expect(sent).toHaveLength(0);
	});

	describe("Custom", () => {
		it("sends the built-in prompt to the session's model when no Prediction Model is set", async () => {
			const { session, settings, sent } = setup({
				activeModel: ANTHROPIC_MODEL,
				logins: { anthropic: "sk-ant-test" },
				reply: '{"suggestion":null}',
				settings: { "composer.predictions.mode": "custom" },
			});
			const config = configFetch(CODEX_CONFIG);
			const outcome = await new ComposerPredictor(session, settings, config.fetch).predict(
				new AbortController().signal,
			);

			expect(outcome).toEqual({ kind: "none" });
			expect(config.requested).toEqual([]);
			expect(sent[0]?.model.id).toBe(ANTHROPIC_MODEL.id);
			expect(lastUserText(sent[0]?.context)).toStartWith(
				sideChannelPrompts["side-channel/composer-prediction"].text.trim(),
			);
			expect(sent[0]?.options?.codexFork).toBeUndefined();
		});

		it("uses the first Prediction Model with credentials, from any provider", async () => {
			const { session, settings, sent } = setup({
				activeModel: CODEX_MODEL,
				logins: { ...PRO_LOGIN, openai: "sk-openai-test" },
				settings: {
					"composer.predictions.mode": "custom",
					"composer.predictions.model": ["anthropic/claude-test", "openai/gpt-test:low"],
				},
			});
			const outcome = await new ComposerPredictor(session, settings, configFetch(CODEX_CONFIG).fetch).predict(
				new AbortController().signal,
			);

			expect(outcome.kind).toBe("prediction");
			expect(sent.map(entry => `${entry.model.provider}/${entry.model.id}`)).toEqual(["openai/gpt-test"]);
			expect(sent[0]?.options?.reasoning).toBe(Effort.Low);
		});

		it("reports every Prediction Model it could not use, sending nothing", async () => {
			const { session, settings, sent } = setup({
				activeModel: CODEX_MODEL,
				logins: PRO_LOGIN,
				settings: {
					"composer.predictions.mode": "custom",
					"composer.predictions.model": ["anthropic/claude-test", "openai/gpt-test"],
				},
			});
			const outcome = await new ComposerPredictor(session, settings, configFetch(CODEX_CONFIG).fetch).predict(
				new AbortController().signal,
			);

			expect(outcome).toEqual({
				kind: "unavailable",
				reason:
					"No Prediction Model is usable: anthropic/claude-test has no credentials; openai/gpt-test has no credentials. Log in to a provider or choose another model.",
			});
			expect(sent).toHaveLength(0);
		});

		it("fails on a reply with no suggestion object", async () => {
			const { session, settings } = setup({
				activeModel: ANTHROPIC_MODEL,
				logins: { anthropic: "sk-ant-test" },
				reply: "Sure! You could run the tests.",
				settings: { "composer.predictions.mode": "custom" },
			});
			await expect(
				new ComposerPredictor(session, settings, configFetch(CODEX_CONFIG).fetch).predict(
					new AbortController().signal,
				),
			).rejects.toThrow("not a JSON suggestion");
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
