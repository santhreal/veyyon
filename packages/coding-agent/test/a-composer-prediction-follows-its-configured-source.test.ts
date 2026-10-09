/**
 * Composer predictions come from one of two sources, and each must reach the model the way it
 * claims to. `codex` sends the prompt and effort the ChatGPT backend serves, refuses the models
 * the backend lists, and marks the turn as an ephemeral fork with
 * `thread_source: "composer_predictions"`. `model` sends this package's prompt to any model.
 * Both read the reply as `{"suggestion": string | null}` and neither writes to the session.
 *
 * These drive a real `AgentSession` and its `runEphemeralTurn`; only the provider stream and the
 * config endpoint are replaced. Not covered: the bytes the Codex provider puts on the wire for a
 * fork, which `packages/ai/test/openai-codex-stream.test.ts` pins.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
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
const OTHER_MODEL = model("anthropic", "claude-test", "anthropic");

interface Sent {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

function configFetch(payload: Record<string, unknown>) {
	return vi.fn(
		async (_input: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
	);
}

const CODEX_CONFIG = {
	is_enabled: true,
	prompt: CODEX_PROMPT,
	prompt_version: "5",
	prediction_reasoning_effort: "high",
	unsupported_models: ["gpt-5.5"],
};

describe("ComposerPredictor", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function setup(activeModel: Model<Api>, source: "codex" | "model", reply: string) {
		const sent: Sent[] = [];
		const sideStreamFn: StreamFn = (_model, context, options) => {
			sent.push({ context, options });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage(reply);
				stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"composer.predictions.enabled": true,
			"composer.predictions.source": source,
		});
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: activeModel,
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
			modelRegistry: { getApiKey: vi.fn(async () => "token"), resolver: vi.fn(() => async () => "token") } as never,
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

	it("sends the backend's prompt and effort as a Codex prediction fork", async () => {
		const { session, settings, sent } = setup(CODEX_MODEL, "codex", '{"suggestion":"run the parser tests"}');
		const fetchImpl = configFetch(CODEX_CONFIG);
		const outcome = await new ComposerPredictor(session, settings, fetchImpl).predict(new AbortController().signal);

		expect(outcome).toEqual({ kind: "prediction", text: "run the parser tests" });
		expect(sent).toHaveLength(1);
		expect(lastUserText(sent[0]?.context)).toStartWith(CODEX_PROMPT);
		expect(sent[0]?.options?.codexFork).toEqual({
			parentSessionId: expect.any(String),
			threadSource: "composer_predictions",
		});
		expect(sent[0]?.options?.reasoning).toBe(Effort.High);
		expect(session.messages).toHaveLength(2);
	});

	it("reads the Codex config once across consecutive predictions", async () => {
		const { session, settings } = setup(CODEX_MODEL, "codex", '{"suggestion":null}');
		const fetchImpl = configFetch(CODEX_CONFIG);
		const predictor = new ComposerPredictor(session, settings, fetchImpl);
		await predictor.predict(new AbortController().signal);
		await predictor.predict(new AbortController().signal);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it.each([
		["the account has predictions disabled", { ...CODEX_CONFIG, is_enabled: false }, CODEX_MODEL],
		[
			"the backend lists the model as unsupported",
			CODEX_CONFIG,
			model("openai-codex-responses", "gpt-5.5", "openai-codex"),
		],
		["the model is not an OpenAI Codex model", CODEX_CONFIG, OTHER_MODEL],
	])("reports Codex predictions unavailable when %s, sending nothing", async (_case, payload, activeModel) => {
		const { session, settings, sent } = setup(activeModel, "codex", '{"suggestion":"x"}');
		const outcome = await new ComposerPredictor(session, settings, configFetch(payload)).predict(
			new AbortController().signal,
		);
		expect(outcome.kind).toBe("unavailable");
		expect(sent).toHaveLength(0);
	});

	it("sends the built-in prompt to a non-Codex model without fork metadata", async () => {
		const { session, settings, sent } = setup(OTHER_MODEL, "model", '{"suggestion":null}');
		const fetchImpl = configFetch(CODEX_CONFIG);
		const outcome = await new ComposerPredictor(session, settings, fetchImpl).predict(new AbortController().signal);

		expect(outcome).toEqual({ kind: "none" });
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(lastUserText(sent[0]?.context)).toStartWith(
			sideChannelPrompts["side-channel/composer-prediction"].text.trim(),
		);
		expect(sent[0]?.options?.codexFork).toBeUndefined();
	});

	it("fails on a reply with no suggestion object", async () => {
		const { session, settings } = setup(OTHER_MODEL, "model", "Sure! You could run the tests.");
		await expect(
			new ComposerPredictor(session, settings, configFetch(CODEX_CONFIG)).predict(new AbortController().signal),
		).rejects.toThrow("not a JSON suggestion");
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
