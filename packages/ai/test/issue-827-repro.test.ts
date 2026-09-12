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
 * The OpenCode gateways later stopped accepting any `tool_choice` but `"auto"`
 * (`only '"auto"' is supported for 'tool_choice'`), so on those hosts the
 * `"required"` that #827 sent became its own 400 and the choice is dropped
 * instead — which satisfies the same invariant from the other side and lets
 * reasoning through, since nothing is being forced. The strip-reasoning
 * mechanism still governs Moonshot and OpenRouter, which take a forced choice;
 * those cases are below and unchanged.
 *
 * So the assertions are written against the invariant rather than either
 * mechanism: whichever half is present on the wire, the other must be absent.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, Model, ModelSpec, Tool } from "@veyyon/ai/types";
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

describe("issue #827 — kimi reasoning models drop reasoning under forced tool_choice", () => {
	it("never puts a forced choice and a thinking signal on the wire together, on any gateway shape", async () => {
		// Every shape a caller can force. The gateway takes none of them, so each
		// must leave the wire with no `tool_choice` — and with reasoning intact,
		// because there is no longer anything for thinking to be incompatible with.
		for (const toolChoice of ["any", "required", { type: "tool", name: "echo" }] as const) {
			const body = (await captureBody(kimiOpencodeGoModel(), {
				reasoning: "high",
				toolChoice,
			})) as CompletionsBody;
			const label = JSON.stringify(toolChoice);

			expect(body.tool_choice, `${label} reaches an upstream that accepts only "auto"`).toBeUndefined();
			// The invariant: nothing is forced, so the thinking signal is allowed.
			expect(body.reasoning_effort, label).toBe("high");
			expect(body.thinking, label).toBeUndefined();
			// And the tool stays offered, or dropping the choice would cost the call.
			expect(JSON.stringify(body.tools ?? []), label).toContain("echo");
		}
	});

	it("preserves reasoning_effort when toolChoice is auto", async () => {
		const body = (await captureBody(kimiOpencodeGoModel(), {
			reasoning: "high",
			toolChoice: "auto",
		})) as CompletionsBody;

		// `"auto"` is the one value the gateway accepts, and an omitted field is
		// the same request; it is dropped with the rest so one rule covers them all.
		expect(body.tool_choice).toBeUndefined();
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
