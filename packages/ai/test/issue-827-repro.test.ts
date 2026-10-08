/**
 * Repro for #827 — `opencode-go/kimi-k2.6` returns 400 with
 * `tool_choice 'specified' is incompatible with thinking enabled`
 * whenever the agent forces a tool call while reasoning is on.
 *
 * THE INVARIANT, which outlived two mechanisms. A Kimi reasoning turn must never
 * put a forced `tool_choice` and a thinking signal on the wire together. #827
 * satisfied that by following the Anthropic pattern
 * (`disableThinkingIfToolChoiceForced`): keep the forced choice and strip
 * reasoning for that one turn.
 *
 * The OpenCode gateways take a forced choice for some models and answer others with
 * `Thinking mode does not support this tool_choice`. The forced choice reaches the wire first,
 * with reasoning stripped as #827 does; when the gateway rejects it, the retry drops the choice
 * and the reasoning policy re-reads the choice actually sent, so the retry carries reasoning and
 * nothing forced. Moonshot and OpenRouter take a forced choice; those cases are below.
 *
 * So the assertions are written against the invariant rather than either mechanism: whichever
 * half is present on the wire, the other must be absent, before and after a rejection.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec, Tool } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { type } from "arktype";

const echoTool: Tool = {
	name: "echo",
	description: "Echo input",
	parameters: type({ text: "string" }),
};

const ctx: Context = {
	messages: [{ role: "user", content: "do it", timestamp: Date.now() }],
	tools: [echoTool],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function kimiOpencodeGoModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/v1",
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function kimiOpenRouterModel(): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		id: "moonshotai/kimi-k2",
		name: "Kimi K2 (OpenRouter)",
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function captureBody(
	model: Model<"openai-completions">,
	opts: Parameters<typeof streamOpenAICompletions>[2],
): Promise<unknown> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	streamOpenAICompletions(model, ctx, {
		...opts,
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => resolve(payload),
	});
	return promise;
}

interface CompletionsBody {
	tool_choice?: unknown;
	tools?: unknown[];
	reasoning_effort?: unknown;
	reasoning?: unknown;
	thinking?: unknown;
}

function isForced(choice: unknown): boolean {
	return choice !== undefined && choice !== "auto" && choice !== "none";
}

/** Any field that asks the upstream to think. An explicit `thinking: { type: "disabled" }` is not one. */
function hasThinkingSignal(body: CompletionsBody): boolean {
	const thinking = body.thinking as { type?: unknown } | undefined;
	return (
		body.reasoning_effort !== undefined ||
		body.reasoning !== undefined ||
		(thinking !== undefined && thinking.type !== "disabled")
	);
}

/** A gateway that answers a forced `tool_choice` with the recorded thinking-mode 400 and serves the rest. */
function thinkingModeGateway(): { bodies: CompletionsBody[]; fetch: FetchImpl } {
	const bodies: CompletionsBody[] = [];
	const chunk = (delta: unknown, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const fetch: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as CompletionsBody;
			bodies.push(body);
			if (bodies.length > 4) throw new Error("runaway retry");
			if (isForced(body.tool_choice)) {
				return new Response(
					JSON.stringify({
						error: { message: "Thinking mode does not support this tool_choice", type: "invalid_request_error" },
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(`${chunk({ content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	return { bodies, fetch };
}

const FORCED_SHAPES = ["any", "required", { type: "tool", name: "echo" }] as const;

describe("issue #827 — kimi reasoning models drop reasoning under forced tool_choice", () => {
	it("never puts a forced choice and a thinking signal on the wire together, on any gateway shape", async () => {
		for (const toolChoice of FORCED_SHAPES) {
			const body = (await captureBody(kimiOpencodeGoModel(), {
				reasoning: "high",
				toolChoice,
			})) as CompletionsBody;
			const label = JSON.stringify(toolChoice);

			expect(isForced(body.tool_choice), `${label} reaches the gateway as a forced choice`).toBe(true);
			expect(hasThinkingSignal(body), `${label} rides with a thinking signal`).toBe(false);
			expect(JSON.stringify(body.tools ?? []), label).toContain("echo");
		}
	});

	it("drops the forced choice and restores reasoning once the gateway rejects it", async () => {
		for (const toolChoice of FORCED_SHAPES) {
			const gateway = thinkingModeGateway();
			const label = JSON.stringify(toolChoice);
			const result = await streamOpenAICompletions(kimiOpencodeGoModel(), ctx, {
				apiKey: "test-key",
				fetch: gateway.fetch,
				reasoning: "high",
				toolChoice,
			}).result();

			expect(result.stopReason, `${label}: ${result.errorMessage}`).toBe("stop");
			expect(
				gateway.bodies.map(body => isForced(body.tool_choice)),
				label,
			).toEqual([true, false]);
			for (const body of gateway.bodies) {
				expect(isForced(body.tool_choice) && hasThinkingSignal(body), label).toBe(false);
			}
			expect(gateway.bodies[1]?.tool_choice, label).toBeUndefined();
			expect(gateway.bodies[1]?.reasoning_effort, `${label}: the retry keeps its thinking signal`).toBe("high");
			expect(JSON.stringify(gateway.bodies[1]?.tools ?? []), label).toContain("echo");
		}
	});

	it("preserves reasoning_effort when toolChoice is auto", async () => {
		const body = (await captureBody(kimiOpencodeGoModel(), {
			reasoning: "high",
			toolChoice: "auto",
		})) as CompletionsBody;

		expect(body.tool_choice).toBe("auto");
		expect(body.reasoning_effort).toBe("high");
	});

	it("strips OpenRouter-shaped reasoning object on forced toolChoice for Kimi via OpenRouter", async () => {
		const body = (await captureBody(kimiOpenRouterModel(), {
			reasoning: "high",
			toolChoice: { type: "tool", name: "echo" },
		})) as CompletionsBody;

		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "echo" } });
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});
	it("sends explicit thinking disabled for Moonshot Kimi K2.6 when a named tool is forced", async () => {
		const base = getBundledModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = buildModel({
			...base,
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			reasoning: false,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);
		const body = (await captureBody(model, {
			toolChoice: { type: "tool", name: "echo" },
		})) as CompletionsBody;

		expect(body.tool_choice).toMatchObject({ type: "function", function: { name: "echo" } });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("strips reasoning_effort for Anthropic Claude models served via openai-completions (e.g. LiteLLM/OpenRouter proxies)", async () => {
		// LiteLLM / Vertex proxies often expose Claude through chat-completions; Anthropic
		// itself rejects reasoning + forced tool_choice (see anthropic.ts:disableThinkingIfToolChoiceForced),
		// so the same constraint must follow the model when it's reached through the OpenAI shape.
		const base = getBundledModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = buildModel({
			...base,
			api: "openai-completions",
			provider: "litellm",
			baseUrl: "http://localhost:4000/v1",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (LiteLLM)",
			reasoning: true,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);

		const body = (await captureBody(model, {
			reasoning: "high",
			toolChoice: "any",
		})) as CompletionsBody;

		expect(body.tool_choice).toBe("required");
		expect(body.reasoning_effort).toBeUndefined();
	});
	it("does not strip reasoning on non-Kimi models even with forced tool_choice", async () => {
		// Non-kimi reasoning model — OpenAI itself accepts forced tool_choice with reasoning.
		const base = getBundledModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = buildModel({
			...base,
			api: "openai-completions",
			id: "gpt-5-mini",
			reasoning: true,
			compat: base.compatConfig,
		} as ModelSpec<"openai-completions">);

		const body = (await captureBody(model, {
			reasoning: "high",
			toolChoice: "any",
		})) as CompletionsBody;

		expect(body.tool_choice).toBe("required");
		expect(body.reasoning_effort).toBe("high");
	});
});
