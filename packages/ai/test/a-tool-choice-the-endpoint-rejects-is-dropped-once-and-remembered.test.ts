/**
 * A `tool_choice` the endpoint rejects is dropped for one retry and remembered for the session; a
 * `tool_choice` the endpoint accepts reaches the wire.
 *
 * WHY THIS SUITE EXISTS. The OpenCode gateways answer some models' pins with a 400 and take them for
 * others. Measured one turn per model, the rejecting set spans four unrelated families and two
 * upstream messages:
 *
 *   only '"auto"' is supported for 'tool_choice'. ...          (the muse-spark rows)
 *   Thinking mode does not support this tool_choice            (deepseek, kimi-k2.5, mimo rows)
 *
 * No id, endpoint or host predicts membership, so the request builders used to leave `tool_choice`
 * out for every model on an opencode.ai host. That fixed the rejecting rows and turned every forced
 * call on the accepting rows (guided goal setup, `completion(schema:)`, the executor's reminder
 * retry, the forced-choice queue) into a suggestion.
 *
 * THE CLASS THIS CLOSES. A `tool_choice` decision made from a static list, in either direction:
 * a model that takes a pin but never receives one, and a model that rejects a form and receives
 * it on every turn. The recovery is per model and per form, so both sides are asserted on the wire.
 *
 * WHAT IS SWEPT FROM SOURCE. The gateway models come from the bundled catalog at run time and are
 * driven through the stream function for their own endpoint; a new gateway row or a row that moves
 * endpoint is covered without an edit, and a row on an endpoint nobody decided about is red. The
 * rejection messages come from the field corpus's recorded wording, and both endpoints run every
 * case.
 *
 * WHAT IT DOES NOT CATCH. Whether the live gateway still answers with these messages: that is the
 * live sweep's job. Whether a model complies with a suggestion once the pin is dropped: the callers
 * that force a tool parse a JSON text reply when no call arrives.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	ProviderSessionState,
	Tool,
	ToolChoice,
} from "@veyyon/ai/types";
import { mapToOpenAICompletionsToolChoice } from "@veyyon/ai/utils/tool-choice";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { type } from "arktype";

type OpenAIShapedApi = "openai-completions" | "openai-responses";

const OPENAI_SHAPED_APIS: readonly OpenAIShapedApi[] = ["openai-completions", "openai-responses"];

const GATEWAY_BASE_URL = "https://opencode.ai/zen/go/v1";

/** The two upstream wordings the live sweep recorded, each as the gateway's JSON error body. */
const REJECTIONS: readonly { label: string; message: string }[] = [
	{
		label: "only auto is supported",
		message:
			"only '\"auto\"' is supported for 'tool_choice'. '\"none\"', '\"required\"', and named function choices are not currently supported",
	},
	{ label: "thinking mode", message: "Thinking mode does not support this tool_choice" },
];

/** Every shape a caller can hand to `toolChoice`, including both spellings of a named pin. */
const TOOL_CHOICES: readonly { label: string; value: ToolChoice }[] = [
	{ label: "auto", value: "auto" },
	{ label: "none", value: "none" },
	{ label: "required", value: "required" },
	{ label: "any", value: "any" },
	{ label: "named via type:tool", value: { type: "tool", name: "respond" } },
	{ label: "named via type:function", value: { type: "function", name: "respond" } },
];

/** The rejectable forms a caller sends, one per recorded kind. */
const REJECTED_FORMS: readonly { label: string; value: ToolChoice }[] = [
	{ label: "a named pin", value: { type: "tool", name: "respond" } },
	{ label: "required", value: "required" },
	{ label: "none", value: "none" },
];

const respondTool: Tool = {
	name: "respond",
	description: "Answer with structured fields",
	parameters: type({ text: "string" }),
};

function context(): Context {
	return {
		messages: [{ role: "user", content: "start the interview", timestamp: 0 }],
		tools: [respondTool],
	};
}

const BUNDLED_GATEWAYS = getBundledProviders().filter(id => id.startsWith("opencode"));
const GATEWAY_MODELS: readonly { provider: string; model: Model<Api> }[] = BUNDLED_GATEWAYS.flatMap(provider =>
	getBundledModels(provider).map(model => ({ provider, model })),
);
const OPENAI_SHAPED = GATEWAY_MODELS.filter(({ model }) => (OPENAI_SHAPED_APIS as readonly Api[]).includes(model.api));

function gatewayModel(api: OpenAIShapedApi, id: string): Model<OpenAIShapedApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider: "opencode-go",
		baseUrl: GATEWAY_BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as ModelSpec<OpenAIShapedApi>) as Model<OpenAIShapedApi>;
}

function sse(events: readonly unknown[]): Response {
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function successFor(api: OpenAIShapedApi): Response {
	if (api === "openai-completions") {
		const chunk = (delta: unknown, finish: string | null) => ({
			id: "chatcmpl-tool-choice",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
		return sse([chunk({ content: "ok" }, null), chunk({}, "stop"), "[DONE]"]);
	}
	return sse([
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_tool_choice", role: "assistant", content: [] },
		},
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: "msg_tool_choice",
				role: "assistant",
				content: [{ type: "output_text", text: "ok" }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_tool_choice",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	]);
}

function rejection(message: string, status = 400): Response {
	return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * A gateway that answers `message` with a 400 for every request `rejects` matches and serves the
 * rest. Records each request body, and aborts the turn once it sends more than `cap` requests, so
 * a retry that does not end is observed as a count rather than as a hung test.
 */
class FakeGateway {
	readonly bodies: Record<string, unknown>[] = [];
	#controller = new AbortController();

	constructor(
		readonly api: OpenAIShapedApi,
		readonly rejects: (body: Record<string, unknown>) => boolean,
		readonly message: string,
		readonly cap = 6,
		readonly status = 400,
	) {}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** Start a new turn: clear the request log and re-arm the runaway cap. */
	turn(): void {
		this.bodies.length = 0;
		this.#controller = new AbortController();
	}

	readonly fetch: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			this.bodies.push(body);
			if (this.bodies.length > this.cap) {
				this.#controller.abort();
				return rejection("runaway retry");
			}
			return this.rejects(body) ? rejection(this.message, this.status) : successFor(this.api);
		},
		{ preconnect: fetch.preconnect },
	);
}

function kindOf(choice: unknown): "auto" | "none" | "forced" | undefined {
	if (choice === undefined) return undefined;
	if (choice === "auto" || choice === "none") return choice;
	return "forced";
}

async function runTurn(
	gateway: FakeGateway,
	model: Model<OpenAIShapedApi>,
	toolChoice: ToolChoice | undefined,
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): Promise<AssistantMessage> {
	gateway.turn();
	const options = {
		apiKey: "test-key",
		fetch: gateway.fetch,
		signal: gateway.signal,
		toolChoice,
		sessionId: "tool-choice-session",
		providerSessionState,
	};
	return model.api === "openai-completions"
		? streamOpenAICompletions(model as Model<"openai-completions">, context(), options).result()
		: streamOpenAIResponses(model as Model<"openai-responses">, context(), options).result();
}

/** Read the payload the request builder assembles, without sending it. */
async function payloadFor(model: Model<Api>, toolChoice: ToolChoice): Promise<Record<string, unknown>> {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const controller = new AbortController();
	controller.abort();
	const options = {
		apiKey: "test-key",
		signal: controller.signal,
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

describe("a tool choice the endpoint accepts reaches the wire", () => {
	it("sweeps a non-empty gateway catalog on both OpenAI-shaped endpoints", () => {
		expect(BUNDLED_GATEWAYS.sort()).toEqual(["opencode", "opencode-go", "opencode-zen"]);
		expect(OPENAI_SHAPED.length).toBeGreaterThanOrEqual(90);
		expect([...new Set(OPENAI_SHAPED.map(({ model }) => model.api))].sort()).toEqual([
			"openai-completions",
			"openai-responses",
		]);
		for (const { label, value } of TOOL_CHOICES) {
			expect(mapToOpenAICompletionsToolChoice(value), label).toBeDefined();
		}
	});

	it("sends every tool choice shape for every bundled gateway model", async () => {
		const dropped: string[] = [];
		for (const { provider, model } of OPENAI_SHAPED) {
			for (const { label, value } of TOOL_CHOICES) {
				const payload = await payloadFor(model, value);
				if (!("tool_choice" in payload)) dropped.push(`${provider}/${model.id} (${model.api}) / ${label}`);
			}
		}

		expect(dropped).toEqual([]);
	}, 30_000);

	it("sends a named pin for a custom provider pointed at the gateway", async () => {
		for (const api of OPENAI_SHAPED_APIS) {
			const model = buildModel({
				id: "glm-5.3",
				name: "glm-5.3",
				api,
				provider: "my-proxy",
				baseUrl: GATEWAY_BASE_URL,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			} as ModelSpec<Api>) as Model<Api>;
			const payload = await payloadFor(model, { type: "tool", name: "respond" });

			expect(kindOf(payload.tool_choice), api).toBe("forced");
		}
	});
});

describe("a tool choice the endpoint rejects is dropped once and remembered", () => {
	for (const api of OPENAI_SHAPED_APIS) {
		for (const { label: rejectionLabel, message } of REJECTIONS) {
			for (const { label: formLabel, value } of REJECTED_FORMS) {
				it(`${api}: retries ${formLabel} without it after "${rejectionLabel}", then leaves it out for the session`, async () => {
					const rejectedKind = kindOf(mapToOpenAICompletionsToolChoice(value));
					const gateway = new FakeGateway(api, body => kindOf(body.tool_choice) === rejectedKind, message);
					const model = gatewayModel(api, "muse-spark-1.3-contributor");
					const session = new Map<string, ProviderSessionState>();

					const first = await runTurn(gateway, model, value, session);
					expect(first.stopReason, first.errorMessage).toBe("stop");
					expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toStrictEqual([rejectedKind, undefined]);
					expect(JSON.stringify(gateway.bodies[1]?.tools ?? []), "the retry still offers the tool").toContain(
						"respond",
					);

					const second = await runTurn(gateway, model, value, session);
					expect(second.stopReason, second.errorMessage).toBe("stop");
					expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toStrictEqual([undefined]);
				});
			}
		}
	}

	for (const api of OPENAI_SHAPED_APIS) {
		it(`${api}: remembers the rejected form only, so auto and none still reach the wire`, async () => {
			const gateway = new FakeGateway(
				api,
				body => kindOf(body.tool_choice) === "forced",
				"Thinking mode does not support this tool_choice",
			);
			const model = gatewayModel(api, "deepseek-v4-pro");
			const session = new Map<string, ProviderSessionState>();

			await runTurn(gateway, model, { type: "tool", name: "respond" }, session);
			expect(gateway.bodies).toHaveLength(2);

			for (const choice of ["auto", "none"] as const) {
				const result = await runTurn(gateway, model, choice, session);
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(gateway.bodies.map(body => body.tool_choice)).toEqual([choice]);
			}
		});

		it(`${api}: remembers the rejection for that model only`, async () => {
			const rejectingId = "muse-spark-1.3-contributor";
			const gateway = new FakeGateway(
				api,
				body => body.model === rejectingId && body.tool_choice !== undefined,
				REJECTIONS[0]!.message,
			);
			const session = new Map<string, ProviderSessionState>();

			await runTurn(gateway, gatewayModel(api, rejectingId), { type: "tool", name: "respond" }, session);
			expect(gateway.bodies).toHaveLength(2);

			const other = await runTurn(gateway, gatewayModel(api, "glm-5.3"), { type: "tool", name: "respond" }, session);
			expect(other.stopReason, other.errorMessage).toBe("stop");
			expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toEqual(["forced"]);
		});

		it(`${api}: forgets the rejection when the session closes`, async () => {
			const gateway = new FakeGateway(api, body => body.tool_choice !== undefined, REJECTIONS[0]!.message);
			const model = gatewayModel(api, "muse-spark-1.3-contributor");
			const session = new Map<string, ProviderSessionState>();

			await runTurn(gateway, model, "required", session);
			for (const state of session.values()) state.close();

			await runTurn(gateway, model, "required", session);
			expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toStrictEqual(["forced", undefined]);
		});

		it(`${api}: without a session, each turn pays its own single retry`, async () => {
			const gateway = new FakeGateway(api, body => body.tool_choice !== undefined, REJECTIONS[1]!.message);
			const model = gatewayModel(api, "kimi-k2.5");

			for (let turn = 0; turn < 2; turn++) {
				const result = await runTurn(gateway, model, "required", undefined);
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toStrictEqual(["forced", undefined]);
			}
		});

		it(`${api}: retries once and stops when the endpoint rejects the request without the field too`, async () => {
			const gateway = new FakeGateway(api, () => true, REJECTIONS[0]!.message);
			const model = gatewayModel(api, "muse-spark-1.3-contributor");

			const result = await runTurn(gateway, model, { type: "tool", name: "respond" }, undefined);

			expect(result.stopReason).toBe("error");
			expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toStrictEqual(["forced", undefined]);
		});

		it(`${api}: does not retry a 400 that names no tool_choice`, async () => {
			const gateway = new FakeGateway(api, () => true, "The model does not support image input");
			const model = gatewayModel(api, "muse-spark-1.3-contributor");

			const result = await runTurn(gateway, model, { type: "tool", name: "respond" }, undefined);

			expect(result.stopReason).toBe("error");
			expect(gateway.bodies).toHaveLength(1);
		});

		it(`${api}: does not retry a tool_choice 400 for a request that sent no tool_choice`, async () => {
			const gateway = new FakeGateway(api, () => true, REJECTIONS[1]!.message);
			const model = gatewayModel(api, "muse-spark-1.3-contributor");

			const result = await runTurn(gateway, model, undefined, undefined);

			expect(result.stopReason).toBe("error");
			expect(gateway.bodies.map(body => body.tool_choice)).toStrictEqual([undefined]);
		});

		it(`${api}: does not retry a tool_choice rejection that arrives with a status other than 400`, async () => {
			// 422 is the status a validator answers with and is not retried by the transport, so the
			// one request on the log is the rule's decision alone.
			const gateway = new FakeGateway(api, () => true, REJECTIONS[0]!.message, 6, 422);
			const model = gatewayModel(api, "muse-spark-1.3-contributor");

			const result = await runTurn(gateway, model, { type: "tool", name: "respond" }, undefined);

			expect(result.stopReason).toBe("error");
			expect(gateway.bodies.map(body => kindOf(body.tool_choice))).toStrictEqual(["forced"]);
		});
	}
});
