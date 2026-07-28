import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { TempDir } from "@veyyon/utils";
import { $ } from "bun";
import type { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { SecretObfuscator } from "../../secrets/obfuscator";
import type { ToolSession } from "../../tools";
import { ToolError } from "../../tools/tool-errors";
import { EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP } from "../bridge-timeout";
import { EVAL_COMPLETION_BRIDGE_NAME, runEvalCompletion } from "../completion-bridge";
import { IdleTimeout } from "../idle-timeout";
import { disposeAllVmContexts } from "../js/context-manager";
import { executeJs } from "../js/executor";
import { disposeAllKernelSessions, type PythonResult } from "../py/executor";

function makeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: {},
		...extra,
	} as Model<Api>;
}

const SMOL = makeModel("p", "smol");
const DEFAULT = makeModel("p", "default");
const SLOW = makeModel("p", "slow");
const REASONING_SLOW = makeModel("p", "slow", {
	api: "anthropic-messages",
	reasoning: true,
	thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High], mode: "anthropic-adaptive" },
});

interface SessionOptions {
	available?: Model<Api>[];
	apiKey?: string | null;
	activeModel?: string;
	roles?: Partial<Record<"smol" | "default" | "slow", string>>;
	obfuscateProviderText?: (text: string) => string;
}

function makeSession(opts: SessionOptions = {}): ToolSession {
	const settings = Settings.isolated({ "async.enabled": false, "subagent.isolation.mode": "none" });
	const roles = opts.roles ?? { smol: "p/smol", slow: "p/slow" };
	for (const role in roles) {
		const value = roles[role as keyof typeof roles];
		if (value) settings.setModelRole(role, value);
	}
	const modelRegistry = {
		getAvailable: () => opts.available ?? [SMOL, DEFAULT, SLOW],
		getApiKey: async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
		resolver: () => async () => (opts.apiKey === undefined ? "test-key" : opts.apiKey),
	} as unknown as ModelRegistry;
	return {
		settings,
		modelRegistry,
		getActiveModelString: () => opts.activeModel ?? "p/default",
		obfuscateProviderText: opts.obfuscateProviderText,
	} as unknown as ToolSession;
}

function assistant(opts: {
	text?: string;
	toolCall?: { name: string; arguments: Record<string, unknown> };
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolCall) {
		content.push({ type: "toolCall", id: "tc-1", name: opts.toolCall.name, arguments: opts.toolCall.arguments });
	}
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "p",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: opts.stopReason ?? "stop",
		errorMessage: opts.errorMessage,
		timestamp: Date.now(),
	};
}
function createOpenAiTextResponse(text = "ok"): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}
function createOpenAiToolResponse(name: string, argumentsJson: string): Response {
	const item = {
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name,
		arguments: argumentsJson,
	};
	const events = [
		{ type: "response.output_item.added", item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", item_id: item.id, delta: argumentsJson },
		{ type: "response.function_call_arguments.done", item_id: item.id, arguments: argumentsJson },
		{ type: "response.output_item.done", item },
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}



async function runPythonCompletionInSubprocess(options: {
	structured: boolean;
	tempDir: TempDir;
}): Promise<PythonResult> {
	const repoRoot = path.resolve(import.meta.dir, "../../../..");
	const scriptPath = path.join(options.tempDir.path(), "run-python-completion.ts");
	const resultPath = path.join(options.tempDir.path(), "python-completion-result.json");
	const aiPath = path.resolve(import.meta.dir, "../../../../ai/src/index.ts");
	const executorPath = path.resolve(import.meta.dir, "../py/executor.ts");
	const settingsPath = path.resolve(import.meta.dir, "../../config/settings.ts");
	const code = options.structured
		? 'import json\nprint(json.dumps(completion("hi", schema={"type": "object"})))'
		: 'print(completion("hi", model="smol"))';
	const responseContent = options.structured
		? '[{ type: "toolCall", id: "tc-1", name: "respond", arguments: { ok: true } }]'
		: '[{ type: "text", text: "hello from python" }]';
	await Bun.write(
		scriptPath,
		`
import { vi } from "bun:test";
import * as ai from ${JSON.stringify(aiPath)};
import { executePython } from ${JSON.stringify(executorPath)};
import { Settings } from ${JSON.stringify(settingsPath)};

const SMOL = {
	id: "smol",
	name: "smol",
	api: "openai-responses",
	provider: "p",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	contextWindow: 128000,
	maxTokens: 4096,
};
const settings = Settings.isolated({ "async.enabled": false, "subagent.isolation.mode": "none" });
settings.setModelRole("smol", "p/smol");
settings.setModelRole("slow", "p/slow");
const session = {
	settings,
	modelRegistry: {
		getAvailable: () => [SMOL],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	},
	getActiveModelString: () => "p/smol",
};
vi.spyOn(ai, "completeSimple").mockResolvedValue({
	role: "assistant",
	api: "openai-responses",
	provider: "p",
	model: "smol",
	stopReason: "stop",
	content: ${responseContent},
});
const result = await executePython(${JSON.stringify(code)}, {
	cwd: ${JSON.stringify(options.tempDir.path())},
	sessionId: ${JSON.stringify(`py-completion:${options.structured ? "struct" : "plain"}`)},
	sessionFile: ${JSON.stringify(path.join(options.tempDir.path(), "session.jsonl"))},
	toolSession: session,
	kernelMode: "per-call",
});
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result));
process.exit(0);
`,
	);
	const child = await $`bun ${scriptPath}`.cwd(repoRoot).quiet().nothrow();
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	if (child.exitCode !== 0)
		throw new Error(stderr || stdout || `Python completion subprocess exited with ${child.exitCode}`);
	return (await Bun.file(resultPath).json()) as PythonResult;
}

describe("runEvalCompletion", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves each tier to its expected model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession();

		await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await runEvalCompletion({ prompt: "q", model: "default" }, { session });
		await runEvalCompletion({ prompt: "q", model: "slow" }, { session });

		const resolved = spy.mock.calls.map(call => {
			const model = call[0] as Model<Api>;
			return `${model.provider}/${model.id}`;
		});
		expect(resolved).toEqual(["p/smol", "p/default", "p/slow"]);
	});

	it("prefers the session active model for the default tier, falling back to @default", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ available: [SMOL, DEFAULT, SLOW], activeModel: "p/slow" });

		await runEvalCompletion({ prompt: "q", model: "default" }, { session });

		const model = spy.mock.calls[0]?.[0] as Model<Api>;
		expect(`${model.provider}/${model.id}`).toBe("p/slow");
	});

	it("returns the completion text in plain mode", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "the answer" }));
		const result = await runEvalCompletion({ prompt: "q", model: "smol" }, { session: makeSession() });
		expect(result.text).toBe("the answer");
		expect(result.details).toEqual({ model: "p/smol", tier: "smol", structured: false });
	});

	it("supplies a non-empty systemPrompt when system is omitted (codex 'Instructions are required' guard)", async () => {
		// The openai-codex Responses transformer drops `instructions` when no
		// system prompt is provided, and the remote endpoint then 400s with
		// "Instructions are required". runEvalCompletion must always carry a non-empty
		// systemPrompt so `completion("…")` without a `system` argument works.
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletion({ prompt: "q", model: "smol" }, { session: makeSession() });
		const ctx = spy.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(ctx.systemPrompt).toBeDefined();
		expect(ctx.systemPrompt?.length).toBeGreaterThan(0);
		expect(ctx.systemPrompt?.[0]).toMatch(/.+/);
	});

	it("honors an explicit system prompt instead of overriding it", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		await runEvalCompletion({ prompt: "q", model: "smol", system: "Be terse." }, { session: makeSession() });
		const ctx = spy.mock.calls[0]?.[1] as { systemPrompt?: string[] };
		expect(ctx.systemPrompt).toEqual(["Be terse."]);
	});

	it("obfuscates both prompt and explicit system text at the final provider boundary", async () => {
		const secret = "EVAL_RAW_SECRET_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({
			obfuscateProviderText: text => obfuscator.obfuscate(text),
		});

		await runEvalCompletion(
			{
				prompt: `Use ${secret} in the answer`,
				system: `Never repeat ${secret}`,
				model: "smol",
			},
			{ session },
		);

		const providerContext = spy.mock.calls[0]?.[1] as {
			systemPrompt: string[];
			messages: Array<{ content: Array<{ type: string; text: string }> }>;
		};
		const captured = JSON.stringify(providerContext);
		expect(captured).not.toContain(secret);
		expect(providerContext.systemPrompt).toEqual([`Never repeat ${placeholder}`]);
		expect(providerContext.messages[0]?.content).toEqual([
			{ type: "text", text: `Use ${placeholder} in the answer` },
		]);
	});
	it("sanitizes every schema string and keeps mapped property references aligned", async () => {
		// WHY: schema metadata is part of the provider request even though it is
		// not conversational text, and property names are referenced by required.
		const secret = "SCHEMA_SECRET_789";
		const replacement = "#SCHEMA_REDACTED#";
		const propertyName = `answer_${secret}`;
		const safePropertyName = `answer_${replacement}`;
		const schema = {
			type: "object",
			title: `Title ${secret}`,
			description: `Description ${secret}`,
			examples: [{ [`example_${secret}`]: `Example ${secret}` }],
			properties: {
				[propertyName]: {
					type: "string",
					title: `Property title ${secret}`,
					description: `Property description ${secret}`,
					examples: [`Property example ${secret}`],
					enum: [`Enum ${secret}`],
					default: `Default ${secret}`,
				},
			},
			required: [propertyName],
		};
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const body =
				input instanceof Request
					? await input.clone().text()
					: typeof init?.body === "string"
						? init.body
						: "";
			capturedBody = JSON.parse(body) as Record<string, unknown>;
			return createOpenAiToolResponse("respond", JSON.stringify({ [safePropertyName]: "ok" }));
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			await runEvalCompletion(
				{ prompt: "q", model: "smol", schema },
				{
					session: makeSession({
						obfuscateProviderText: text => text.replaceAll(secret, replacement),
					}),
				},
			);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const tools = capturedBody?.tools as Array<{ parameters: Record<string, unknown> }> | undefined;
		const parameters = tools?.[0]?.parameters;
		expect(JSON.stringify(parameters)).not.toContain(secret);
		expect(parameters).toMatchObject({
			title: `Title ${replacement}`,
			description: `Description ${replacement}`,
			examples: [{ [`example_${replacement}`]: `Example ${replacement}` }],
			required: [safePropertyName],
			properties: {
				[safePropertyName]: {
					title: `Property title ${replacement}`,
					description: `Property description ${replacement}`,
					examples: [`Property example ${replacement}`],
					enum: [`Enum ${replacement}`],
					default: `Default ${replacement}`,
				},
			},
		});
	});

	it("leaves benign schemas unchanged when no confidentiality resolver exists", async () => {
		// WHY: local-only/no-secret sessions must retain the caller's exact schema
		// semantics rather than requiring or inventing a remote redaction runtime.
		const schema = {
			type: "object",
			properties: { answer: { type: "string", description: "A benign answer" } },
			required: ["answer"],
		};
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ toolCall: { name: "respond", arguments: { answer: "ok" } } }));

		await runEvalCompletion({ prompt: "q", model: "smol", schema }, { session: makeSession() });

		const context = spy.mock.calls[0]?.[1] as { tools?: Array<{ parameters: Record<string, unknown> }> };
		expect(context.tools?.[0]?.parameters).toEqual(schema);
	});

	it("uses a runtime installed while credential lookup is awaited", async () => {
		// WHY: credential refresh is an await boundary. Sanitizing before it would
		// leave newly authoritative prompt, system, and schema secrets exposed.
		const secret = "EVAL_REFRESH_SECRET_314";
		const replacement = "#REFRESHED#";
		const session = makeSession({ obfuscateProviderText: text => text });
		const mutableSession = session as unknown as { obfuscateProviderText?: (text: string) => string };
		const registry = session.modelRegistry as unknown as { getApiKey: () => Promise<string> };
		registry.getApiKey = async () => {
			await Promise.resolve();
			mutableSession.obfuscateProviderText = text => text.replaceAll(secret, replacement);
			return "test-key";
		};
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ toolCall: { name: "respond", arguments: { ok: true } } }));

		await runEvalCompletion(
			{
				prompt: `prompt ${secret}`,
				system: `system ${secret}`,
				model: "smol",
				schema: { type: "object", description: `schema ${secret}` },
			},
			{ session },
		);

		const context = spy.mock.calls[0]?.[1];
		expect(JSON.stringify(context)).not.toContain(secret);
		expect(JSON.stringify(context)).toContain(replacement);
	});

	it("fails closed when redacted schema keys collide without echoing either secret", async () => {
		// WHY: collapsing two properties would make required/property references
		// ambiguous; including either original key in the error would leak it.
		const firstSecret = "COLLISION_SECRET_ALPHA";
		const secondSecret = "COLLISION_SECRET_BETA";
		const session = makeSession({
			obfuscateProviderText: text =>
				text.replaceAll(firstSecret, "#REDACTED#").replaceAll(secondSecret, "#REDACTED#"),
		});
		const completeSpy = vi.spyOn(ai, "completeSimple");
		let thrown: unknown;

		try {
			await runEvalCompletion(
				{
					prompt: "q",
					model: "smol",
					schema: {
						type: "object",
						properties: {
							[`field_${firstSecret}`]: { type: "string" },
							[`field_${secondSecret}`]: { type: "string" },
						},
					},
				},
				{ session },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolError);
		expect(String(thrown)).not.toContain(firstSecret);
		expect(String(thrown)).not.toContain(secondSecret);
		expect(completeSpy).not.toHaveBeenCalled();
	});

	it("re-resolves confidentiality after a 401 before the second physical attempt", async () => {
		// WHY: auth rotation can refresh the secret runtime together with the
		// credential. Reusing attempt one's payload would expose the new secret.
		const secret = "LATE_COMPLETION_SECRET_333";
		const replacement = "#LATE_REDACTED#";
		const session = makeSession({ obfuscateProviderText: text => text });
		const mutableSession = session as unknown as { obfuscateProviderText?: (text: string) => string };
		const registry = session.modelRegistry as unknown as {
			resolver: () => (state: { error?: unknown }) => Promise<string>;
		};
		registry.resolver = () => async state => {
			if (state.error) {
				mutableSession.obfuscateProviderText = text => text.replaceAll(secret, replacement);
				return "rotated-key";
			}
			return "initial-key";
		};

		const bodies: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const body =
				input instanceof Request
					? await input.clone().text()
					: typeof init?.body === "string"
						? init.body
						: "";
			bodies.push(body);
			if (bodies.length === 1) {
				return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			return createOpenAiTextResponse();
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const result = await runEvalCompletion(
				{ prompt: `send ${secret}`, system: `guard ${secret}`, model: "smol" },
				{ session },
			);
			expect(result.text).toBe("ok");
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain(secret);
		expect(bodies[1]).not.toContain(secret);
		expect(bodies[1]).toContain(replacement);
	});


	it("forces a respond tool call and returns its arguments in structured mode", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant({ toolCall: { name: "respond", arguments: { answer: 42 } } }));
		const result = await runEvalCompletion(
			{ prompt: "q", model: "smol", schema: { type: "object", properties: { answer: { type: "number" } } } },
			{ session: makeSession() },
		);

		expect(JSON.parse(result.text)).toEqual({ answer: 42 });
		expect(result.details.structured).toBe(true);

		const ctx = spy.mock.calls[0]?.[1] as { tools?: Array<{ name: string }> };
		const opts = spy.mock.calls[0]?.[2] as { toolChoice?: unknown };
		expect(ctx.tools?.[0]?.name).toBe("respond");
		expect(opts.toolChoice).toEqual({ type: "tool", name: "respond" });
	});

	it("falls back to JSON embedded in text when the model skips the respond tool", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: 'here: {"answer": 7}' }));
		const result = await runEvalCompletion(
			{ prompt: "q", model: "smol", schema: { type: "object" } },
			{ session: makeSession() },
		);
		expect(JSON.parse(result.text)).toEqual({ answer: 7 });
	});

	it("requests reasoning only for the slow tier on a reasoning-capable model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		const session = makeSession({ available: [SMOL, DEFAULT, REASONING_SLOW] });

		await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
		await runEvalCompletion({ prompt: "q", model: "slow" }, { session });

		const smolOpts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		const slowOpts = spy.mock.calls[1]?.[2] as { reasoning?: unknown };
		expect(smolOpts.reasoning).toBeUndefined();
		expect(slowOpts.reasoning).toBe(Effort.High);
	});

	it("does not request reasoning for the slow tier on a non-reasoning model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "ok" }));
		// SLOW is reasoning:false — must not trip requireSupportedEffort downstream.
		const result = await runEvalCompletion({ prompt: "q", model: "slow" }, { session: makeSession() });
		expect(result.text).toBe("ok");
		const opts = spy.mock.calls[0]?.[2] as { reasoning?: unknown };
		expect(opts.reasoning).toBeUndefined();
	});

	it("throws ToolError on invalid arguments", async () => {
		await expect(runEvalCompletion({ prompt: "" }, { session: makeSession() })).rejects.toBeInstanceOf(ToolError);
		await expect(
			runEvalCompletion({ prompt: "q", model: "huge" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when no model resolves for the tier", async () => {
		const session = makeSession({ available: [DEFAULT], roles: { smol: "missing/model" } });
		await expect(runEvalCompletion({ prompt: "q", model: "smol" }, { session })).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when the resolved model has no API key", async () => {
		const session = makeSession({ apiKey: null });
		await expect(runEvalCompletion({ prompt: "q", model: "smol" }, { session })).rejects.toBeInstanceOf(ToolError);
	});

	it("maps error and aborted stop reasons to ToolError", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "error", errorMessage: "boom" }));
		await expect(runEvalCompletion({ prompt: "q", model: "smol" }, { session: makeSession() })).rejects.toThrow(
			"boom",
		);

		vi.spyOn(ai, "completeSimple").mockResolvedValueOnce(assistant({ stopReason: "aborted" }));
		await expect(
			runEvalCompletion({ prompt: "q", model: "smol" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("throws ToolError when plain mode produces no text", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "" }));
		await expect(
			runEvalCompletion({ prompt: "q", model: "smol" }, { session: makeSession() }),
		).rejects.toBeInstanceOf(ToolError);
	});

	it("pauses the idle watchdog while a slow completion() request is in flight", async () => {
		// A oneshot completion emits no status until it returns; delegated model
		// time must be invisible to the eval timeout budget.
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			await Bun.sleep(200);
			return assistant({ text: "the answer" });
		});

		const ops: string[] = [];
		using idle = new IdleTimeout(60);
		const result = await runEvalCompletion(
			{ prompt: "q", model: "smol" },
			{
				session: makeSession(),
				signal: idle.signal,
				emitStatus: event => {
					ops.push(event.op);
					if (event.op === EVAL_TIMEOUT_PAUSE_OP) idle.pause();
					if (event.op === EVAL_TIMEOUT_RESUME_OP) idle.resume();
				},
			},
		);

		expect(result.text).toBe("the answer");
		expect(ops).toEqual([EVAL_TIMEOUT_PAUSE_OP, EVAL_TIMEOUT_RESUME_OP, "completion"]);
		expect(idle.signal.aborted).toBe(false);
	});
});

describe("completion() through eval runtimes", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		await disposeAllKernelSessions();
	});

	it("exposes completion() in the JavaScript runtime", async () => {
		using tempDir = TempDir.createSync("@veyyon-eval-completion-js-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-completion:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant({ text: "hello from smol" }));

		const result = await executeJs('return await completion("hi", { model: "smol" });', {
			cwd: tempDir.path(),
			sessionId,
			session: makeSession(),
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("hello from smol");
	});

	it("parses structured completion() output in the JavaScript runtime", async () => {
		using tempDir = TempDir.createSync("@veyyon-eval-completion-js-struct-");
		const sessionFile = path.join(tempDir.path(), "session.jsonl");
		const sessionId = `js-completion-struct:${crypto.randomUUID()}`;
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistant({ toolCall: { name: "respond", arguments: { ok: true, n: 3 } } }),
		);

		const result = await executeJs(
			'const r = await completion("hi", { schema: { type: "object" } }); return JSON.stringify(r);',
			{ cwd: tempDir.path(), sessionId, session: makeSession(), sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output.trim())).toEqual({ ok: true, n: 3 });
	});

	// Cold-spawning the Python runtime races bun's 5s default timeout when this
	// file runs mid-chunk on a loaded machine; the explicit timeout bounds real
	// hangs without flaking on spawn latency.
	it("exposes completion() in the Python runtime", async () => {
		const tempDir = TempDir.createSync("@veyyon-eval-completion-py-");
		try {
			const result = await runPythonCompletionInSubprocess({ structured: false, tempDir });
			expect(result.exitCode).toBe(0);
			expect(result.output.trim()).toBe("hello from python");
		} finally {
			tempDir.removeSync();
		}
	}, 30_000);

	it("parses structured completion() output in the Python runtime", async () => {
		const tempDir = TempDir.createSync("@veyyon-eval-completion-py-struct-");
		try {
			const result = await runPythonCompletionInSubprocess({ structured: true, tempDir });
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.output.trim())).toEqual({ ok: true });
		} finally {
			tempDir.removeSync();
		}
	}, 30_000);
});

/**
 * The behavioral tests above assert only `instanceof ToolError` on the validation/resolution
 * guards. These pin the exact operator-facing message strings those guards emit, so a wording
 * or field-naming drift is caught at the boundary instead of surfacing as a confusing 400 (or a
 * crash) deep inside the model call. They use a minimal fake session because every case fails
 * before any completion call is made (no network is reached). Merged here from the former
 * test/eval/completion-bridge.test.ts so this module has a single suite.
 */
type FakeSession = Parameters<typeof runEvalCompletion>[1]["session"];

const sessionWith = (modelRegistry: unknown): FakeSession =>
	({ settings: {}, modelRegistry }) as unknown as FakeSession;

const messageOf = async (args: unknown, modelRegistry: unknown): Promise<string> => {
	try {
		await runEvalCompletion(args, { session: sessionWith(modelRegistry) });
		return "__did_not_throw__";
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
};

describe("EVAL_COMPLETION_BRIDGE_NAME", () => {
	it("is the reserved synthetic name shared by both eval runtimes", () => {
		expect(EVAL_COMPLETION_BRIDGE_NAME).toBe("__completion__");
	});
});

describe("runEvalCompletion argument-validation messages", () => {
	it("rejects a missing prompt", async () => {
		expect(await messageOf({}, undefined)).toBe(
			"completion() received invalid arguments: prompt must be a string (was missing)",
		);
	});

	it("rejects an empty prompt", async () => {
		expect(await messageOf({ prompt: "" }, undefined)).toBe(
			"completion() received invalid arguments: prompt must be non-empty",
		);
	});

	it("rejects an unknown model tier", async () => {
		expect(await messageOf({ prompt: "hi", model: "turbo" }, undefined)).toBe(
			'completion() received invalid arguments: model must be "default", "slow" or "smol" (was "turbo")',
		);
	});

	it("rejects a non-object schema", async () => {
		expect(await messageOf({ prompt: "hi", schema: "notobj" }, undefined)).toBe(
			"completion() received invalid arguments: schema must be an object (was a string)",
		);
	});
});

describe("runEvalCompletion model-resolution messages", () => {
	it("errors when there is no model registry, naming the default tier and config key", async () => {
		expect(await messageOf({ prompt: "hi" }, undefined)).toBe(
			'completion() could not resolve a model for the "default" tier. Configure modelRoles.default or ensure a provider is available.',
		);
	});

	it("errors when the registry has no available models", async () => {
		const registry = { getAvailable: () => [], getApiKey: async () => undefined };
		expect(await messageOf({ prompt: "hi" }, registry)).toBe(
			'completion() could not resolve a model for the "default" tier. Configure modelRoles.default or ensure a provider is available.',
		);
	});

	it("names the requested tier in the resolution error", async () => {
		expect(await messageOf({ prompt: "hi", model: "slow" }, undefined)).toBe(
			'completion() could not resolve a model for the "slow" tier. Configure modelRoles.slow or ensure a provider is available.',
		);
	});
});
