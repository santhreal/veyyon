/**
 * An OpenCode gateway turn carries no `tool_choice` field on either
 * OpenAI-shaped endpoint.
 *
 * WHY THIS SUITE EXISTS. OpenCode's gateways accept exactly one value and
 * reject the rest:
 *
 *   400 [invalid_request_error] only '"auto"' is supported for 'tool_choice'.
 *   '"none"', '"required"', and named function choices are not currently supported
 *
 * Both OpenAI compat builders declared `supportsToolChoice: true` for them, so
 * every request that expressed a preference 400ed. The guided goal pins its
 * `respond` tool by name, which made the failure total: every interview turn died
 * on the upstream before a question reached the operator. Reported against
 * `opencode-go/muse-spark-1.3-contributor`.
 *
 * The three rejected forms all reach the same upstream and no single fallback
 * satisfies them, because the ladder in the request builders degrades a named
 * choice to `"required"` and a forced choice to `"auto"` but leaves `"none"`
 * alone. Declaring the field unsupported is the only setting that covers all of
 * them, and it costs nothing: omitting `tool_choice` is what `"auto"` means on an
 * OpenAI-compatible endpoint.
 *
 * WHY IT SWEEPS THE BUNDLE. The first version of this suite built one synthetic
 * `openai-completions` model and passed while the reported bug was still live,
 * because these gateways serve `muse-spark-1.3-contributor` on `/responses` and
 * the Responses compat builder is a separate function with its own hardcoded
 * `supportsToolChoice: true`. So the members come from the bundled catalog at run
 * time and each is driven through the stream function for its own `api`.
 *
 * WHAT IS OUT OF SCOPE, AND WHY IT IS PINNED. These gateways also serve
 * `anthropic-messages` and `google-generative-ai` rows. Neither speaks this
 * field: Anthropic's `tool_choice` is a different object with different values
 * and Google encodes the same intent as `toolConfig.functionCallingConfig`. The
 * reported 400 is the OpenAI-shaped gateway's own wording, and there is no
 * evidence either passthrough rejects its native form, so changing them would be
 * a guess that could break working turns. The endpoint split is asserted by exact
 * equality below, so a gateway model on a fifth endpoint — or a move of one of
 * these two onto an OpenAI-shaped path — stops the suite instead of shipping.
 *
 * WHAT IT DOES NOT CATCH. Whether the model then chooses the tool. Dropping the
 * pin means the upstream is asked rather than told, so a turn that depended on
 * forcing a call now depends on the model complying; both callers survive that
 * by parsing a JSON text reply when no tool call arrives (`parseJsonPayload`, in
 * guided goal setup and in the eval completion bridge).
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry/registry";
import type { Api, Context, Model, ModelSpec, Tool, ToolChoice } from "@veyyon/ai/types";
import { mapToOpenAICompletionsToolChoice } from "@veyyon/ai/utils/tool-choice";
import { buildModel } from "@veyyon/catalog/build";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { type } from "arktype";

const respondTool: Tool = {
	name: "respond",
	description: "Answer with structured fields",
	parameters: type({ text: "string" }),
};

/** The endpoints that speak an OpenAI-shaped `tool_choice`, and so carry the rule. */
const OPENAI_SHAPED_APIS: readonly Api[] = ["openai-completions", "openai-responses"];

/**
 * Every gateway, from two independent sources: the provider registry and the
 * bundled catalog's own keys. They do not match, and that asymmetry is the point.
 * The bundle carries a bare `opencode` key the registry never lists, whose rows
 * all sit on `https://opencode.ai/zen/v1`. A rule written as an equality on the
 * two registry ids would miss all five of them; the URL marker in `KNOWN_HOSTS`
 * is what reaches them, which is why the fix matches on host. Sweeping the
 * bundle rather than the registry is what puts them under test at all.
 */
const REGISTRY_GATEWAYS: readonly string[] = PROVIDER_REGISTRY.map(provider => provider.id)
	.filter(id => id.startsWith("opencode"))
	.sort();
const BUNDLED_GATEWAYS: readonly GeneratedProvider[] = getBundledProviders()
	.filter(id => id.startsWith("opencode"))
	.sort();

/** Every bundled model those gateways serve, whatever endpoint each one uses. */
const GATEWAY_MODELS: readonly { provider: string; model: Model<Api> }[] = BUNDLED_GATEWAYS.flatMap(provider =>
	getBundledModels(provider).map(model => ({ provider, model })),
);

const OPENAI_SHAPED = GATEWAY_MODELS.filter(({ model }) => OPENAI_SHAPED_APIS.includes(model.api));
const OTHER_SHAPED = GATEWAY_MODELS.filter(({ model }) => !OPENAI_SHAPED_APIS.includes(model.api));

/**
 * Every shape a caller can hand to `toolChoice`, including the two spellings of
 * a named pin: `{ type: "tool" }` is what guided goal setup and the eval
 * completion bridge send, and `{ type: "function" }` is what
 * `buildNamedToolChoice` returns for these APIs.
 */
const TOOL_CHOICES: readonly { label: string; value: ToolChoice }[] = [
	{ label: "auto", value: "auto" },
	{ label: "none", value: "none" },
	{ label: "required", value: "required" },
	{ label: "any", value: "any" },
	{ label: "named via type:tool", value: { type: "tool", name: "respond" } },
	{ label: "named via type:function", value: { type: "function", name: "respond" } },
];

function context(): Context {
	return {
		messages: [{ role: "user", content: "start the interview", timestamp: Date.now() }],
		tools: [respondTool],
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

/**
 * Drive the real request builder for a model's own endpoint and read the payload
 * it would have sent. The signal is already aborted, so nothing leaves the
 * process; `onPayload` fires once the body is assembled.
 */
async function payloadFor(model: Model<Api>, toolChoice: ToolChoice): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const options = {
		apiKey: "test-key",
		signal: abortedSignal(),
		toolChoice,
		onPayload: (payload: unknown) => resolve(payload),
	};
	if (model.api === "openai-completions") {
		streamOpenAICompletions(model as Model<"openai-completions">, context(), options);
	} else if (model.api === "openai-responses") {
		streamOpenAIResponses(model as Model<"openai-responses">, context(), options);
	} else {
		throw new Error(`no request builder wired for ${model.api}`);
	}
	return (await promise) as Record<string, unknown>;
}

function syntheticModel(api: Api, provider: string, baseUrl: string): Model<Api> {
	return buildModel({
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 Contributor",
		api,
		provider,
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as ModelSpec<Api>) as Model<Api>;
}

describe("an opencode turn sends no tool choice", () => {
	/**
	 * NON-VACUITY AND SCOPE. Every sweep below walks a derived list, and an empty
	 * list would satisfy the whole file. The endpoint split is pinned by equality
	 * because it is the thing that went wrong: a gateway model on an endpoint
	 * nobody taught this rule about is the original defect.
	 */
	it("finds the gateways, splits their bundled models by endpoint, and knows every shape", () => {
		expect(REGISTRY_GATEWAYS).toEqual(["opencode-go", "opencode-zen"]);
		// The bundle is the wider set; a new key here is swept automatically and must
		// still come out with no tool_choice, so this pin records what exists rather
		// than demanding the two sources agree.
		expect(BUNDLED_GATEWAYS).toEqual(["opencode", "opencode-go", "opencode-zen"]);
		for (const gateway of REGISTRY_GATEWAYS) {
			expect(BUNDLED_GATEWAYS, `${gateway} is in the registry but serves no bundled model`).toContain(gateway);
		}
		expect(OPENAI_SHAPED.length).toBeGreaterThanOrEqual(90);
		expect([...new Set(OPENAI_SHAPED.map(({ model }) => model.api))].sort()).toEqual([
			"openai-completions",
			"openai-responses",
		]);
		// Out of scope, and named so that a fifth endpoint or a re-route is red.
		expect([...new Set(OTHER_SHAPED.map(({ model }) => model.api))].sort()).toEqual([
			"anthropic-messages",
			"google-generative-ai",
		]);
		// The model the failure was reported against, on the endpoint it is served on.
		expect(
			OPENAI_SHAPED.some(
				({ provider, model }) =>
					provider === "opencode-go" &&
					model.id === "muse-spark-1.3-contributor" &&
					model.api === "openai-responses",
			),
			"the reported model must be in the swept set",
		).toBe(true);
		expect(TOOL_CHOICES.length).toBe(6);
		// Each shape must be one the mapper understands, so a form that stopped
		// meaning anything cannot sit here looking like coverage.
		for (const { label, value } of TOOL_CHOICES) {
			expect(mapToOpenAICompletionsToolChoice(value), label).toBeDefined();
		}
	});

	/**
	 * THE CONTROL. An ordinary provider on each endpoint still emits every shape.
	 * Without this, the sweep below would pass just as well against builders that
	 * had stopped sending `tool_choice` for everyone, or a harness that never
	 * captured a payload.
	 */
	it("still sends tool_choice on both endpoints for a provider with no such limit", async () => {
		const controls: readonly [Api, string, string][] = [
			["openai-completions", "together", "https://api.together.xyz/v1"],
			["openai-responses", "openai", "https://api.openai.com/v1"],
		];
		for (const [api, provider, baseUrl] of controls) {
			for (const { label, value } of TOOL_CHOICES) {
				const payload = await payloadFor(syntheticModel(api, provider, baseUrl), value);
				expect(payload.tool_choice, `${api} / ${label} should survive on a normal provider`).toBeDefined();
			}
		}
	});

	/**
	 * THE FIX. No shape, on any bundled OpenAI-shaped gateway model, reaches the
	 * wire. Asserted as key absence rather than a value, because `"auto"` and an
	 * omitted field are the same request and the upstream rejects everything else.
	 */
	it("omits tool_choice for every bundled gateway model and every shape", async () => {
		const sent: string[] = [];
		for (const { provider, model } of OPENAI_SHAPED) {
			for (const { label, value } of TOOL_CHOICES) {
				const payload = await payloadFor(model, value);
				if ("tool_choice" in payload) {
					sent.push(`${provider}/${model.id} (${model.api}) / ${label} → ${JSON.stringify(payload.tool_choice)}`);
				}
			}
		}

		expect(sent, 'these reach an upstream that accepts only "auto" and 400s on everything else').toEqual([]);
	}, 30_000);

	/**
	 * AND THE TOOL IS STILL OFFERED. Dropping the pin must not drop the tool, or
	 * the model could not call it even when it wanted to and the guided goal would
	 * have nothing to answer with.
	 */
	it("keeps the tool available while dropping the choice", async () => {
		for (const { provider, model } of OPENAI_SHAPED) {
			const payload = await payloadFor(model, { type: "tool", name: "respond" });
			const offered = JSON.stringify(payload.tools ?? []);

			expect(payload.tool_choice, `${provider}/${model.id}`).toBeUndefined();
			expect(offered, `${provider}/${model.id} must still offer the tool`).toContain("respond");
		}
	}, 30_000);

	/**
	 * BY HOST TOO. A custom provider id pointed at the gateway is the same upstream
	 * and gets the same answer on both endpoints, which is why the rule reads the
	 * host table rather than an id equality.
	 */
	it("omits tool_choice for a custom provider pointed at the gateway", async () => {
		for (const api of OPENAI_SHAPED_APIS) {
			const payload = await payloadFor(syntheticModel(api, "my-proxy", "https://opencode.ai/zen/go/v1"), {
				type: "tool",
				name: "respond",
			});

			expect(payload.tool_choice, api).toBeUndefined();
		}
	});
});
