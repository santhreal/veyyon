/**
 * Regression suite: a model-supplied tool-argument key of `__proto__` (or
 * `constructor`/`prototype`) must land as a normal own property on the call's
 * `arguments` object, never as a prototype mutation or a silently dropped write.
 *
 * The JSON-body dialects (hermes, harmony, qwen3, kimi) get their arguments from
 * `JSON.parse`, which already stores `__proto__` as a safe own data property. The
 * kv / streaming dialects here build arguments one model-controlled key at a time,
 * so historically an `obj["__proto__"] = value` assignment diverged: an object
 * value replaced the object's prototype (the argument vanished and its fields
 * leaked in as phantom inherited members) and a string value was dropped outright.
 * Both are silent argument corruption driven purely by model output. These tests
 * pin every affected dialect to the safe, JSON-consistent behavior and fail if any
 * parser regresses to a bare dynamic-key assignment.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Context, ToolCall, Usage } from "@veyyon/ai";
import { createInbandScanner, type Dialect, type InbandScanEvent } from "@veyyon/ai/dialect";
import { wrapInbandToolStream } from "../src/dialect/owned-stream";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, count: { type: "number" } },
			required: ["path"],
		},
	},
] as unknown as NonNullable<Context["tools"]>;

function firstCallArgs(dialect: Dialect, text: string, useTools = true): Record<string, unknown> {
	const scanner = createInbandScanner(dialect, useTools ? { tools: TOOLS, parseThinking: true } : undefined);
	const events: InbandScanEvent[] = [];
	events.push(...scanner.feed(text));
	events.push(...scanner.flush());
	const end = events.find((event): event is Extract<InbandScanEvent, { type: "toolEnd" }> => event.type === "toolEnd");
	if (!end) throw new Error(`no tool call parsed for dialect ${dialect}`);
	return end.arguments;
}

/**
 * Assert `args` carries `expected` under a literal `__proto__` OWN property with
 * the object's prototype untouched — exactly the shape `JSON.parse` produces for
 * the same key, and the opposite of a prototype-polluting bare assignment.
 */
function expectSafeProtoArg(args: Record<string, unknown>, expected: unknown): void {
	expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
	expect(Object.hasOwn(args, "__proto__")).toBe(true);
	expect(Object.keys(args)).toContain("__proto__");
	expect(Object.getOwnPropertyDescriptor(args, "__proto__")?.value).toEqual(expected);
}

describe("glm dialect: __proto__ argument key", () => {
	it("stores a string value as an own property (a bare assignment would drop it)", () => {
		const args = firstCallArgs(
			"glm",
			"<tool_call>read\n<arg_key>__proto__</arg_key>\n<arg_value>evil</arg_value>\n</tool_call>",
		);
		expectSafeProtoArg(args, "evil");
	});

	it("stores an object value without replacing the arguments prototype", () => {
		const args = firstCallArgs(
			"glm",
			'<tool_call>read\n<arg_key>__proto__</arg_key>\n<arg_value>{"polluted":true}</arg_value>\n</tool_call>',
		);
		expectSafeProtoArg(args, { polluted: true });
		// The pollution would have surfaced `polluted` as an inherited member.
		expect((args as { polluted?: unknown }).polluted).toBeUndefined();
	});
});

describe("gemma dialect: __proto__ argument key", () => {
	it("stores a string value under a literal __proto__ own property", () => {
		const args = firstCallArgs("gemma", '<|tool_call>call:read{__proto__:<|"|>evil<|"|>}<tool_call|>', false);
		expectSafeProtoArg(args, "evil");
	});
});

describe("gemini dialect: __proto__ argument key", () => {
	it("stores a string keyword argument as an own property", () => {
		const args = firstCallArgs("gemini", '```tool_code\ndefault_api.read(__proto__="evil")\n```', false);
		expectSafeProtoArg(args, "evil");
	});

	it("stores a dict-valued keyword argument without prototype mutation", () => {
		const args = firstCallArgs("gemini", '```tool_code\ndefault_api.read(__proto__={"polluted": true})\n```', false);
		expectSafeProtoArg(args, { polluted: true });
		expect((args as { polluted?: unknown }).polluted).toBeUndefined();
	});

	it("keeps a nested dict argument's __proto__ key as an own property of the nested object", () => {
		const args = firstCallArgs("gemini", '```tool_code\ndefault_api.read(obj={"__proto__": "evil"})\n```', false);
		const nested = args.obj as Record<string, unknown>;
		expectSafeProtoArg(nested, "evil");
	});
});

describe("pi-native dialect: __proto__ argument key", () => {
	it("stores an attribute-form __proto__ as an own property", () => {
		const args = firstCallArgs("pi-native", '<call:read __proto__="evil"/>');
		expectSafeProtoArg(args, "evil");
	});

	it("stores an element-form __proto__ member as an own property", () => {
		const args = firstCallArgs("pi-native", "<call:read>\n<__proto__>evil</__proto__>\n</call:read>");
		expectSafeProtoArg(args, "evil");
	});
});

describe("anthropic dialect: __proto__ parameter name", () => {
	it('stores a <parameter name="__proto__"> value as an own property', () => {
		const args = firstCallArgs(
			"anthropic",
			'<function_calls>\n<invoke name="read"><parameter name="__proto__">evil</parameter></invoke>\n</function_calls>',
		);
		expectSafeProtoArg(args, "evil");
	});
});

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 0,
	};
}

describe("owned-stream projector: __proto__ argument key across in-band deltas", () => {
	it("assembles a streamed __proto__ argument as an own property, not a prototype mutation", async () => {
		// Drive the projector the way a provider stream does: text deltas carrying a
		// GLM in-band tool call whose argument key is `__proto__`. The projector's
		// per-delta value growth (`#deltaTool`) is the streaming write path under test.
		const inner = new AssistantMessageEventStream();
		const out = makeAssistant();
		inner.push({ type: "start", partial: out });
		out.content.push({ type: "text", text: "" });
		const chunks = ["<tool_call>read\n<arg_key>__proto__</arg_key>\n<arg_value>ev", "il</arg_value>\n</tool_call>"];
		for (const chunk of chunks) inner.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: out });
		inner.push({ type: "done", reason: "toolUse", message: out });
		inner.end(out);

		const stream = wrapInbandToolStream(inner, TOOLS, "glm");
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const message = await stream.result();

		const toolCall = message.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expectSafeProtoArg(toolCall!.arguments, "evil");
	});
});
