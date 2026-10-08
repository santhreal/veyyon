/**
 * A provider call carries what the loop config's resolvers return for that call.
 *
 * WHY. A resolver on `AgentLoopConfig` (`getReasoning`, `getServiceTier`, `metadataResolver`, ...) is read once per
 * provider call, so a value that changes mid-run reaches the next call instead of the run finishing on the value
 * captured at its start. A resolver the loop stops reading leaves the static field beside it in force and nothing
 * fails: the request still goes out, with the stale reasoning effort, service tier, credential metadata, working
 * directory or model.
 *
 * CLASS. Every `get*` and `*Resolver` member of `AgentLoopConfig` is either swept here as a per-call request value or
 * recorded in `NOT_REQUEST_VALUES`. Both tables are typed against the config's keys, so a new resolver fails the type
 * check until it is classified. Each swept resolver returns a different value on each of two provider calls, a static
 * field is set beside it, and each call must carry that call's return: the first call the first, the second call the
 * second, or the static field where the resolver's documented fallback applies.
 *
 * GAP. The sweep observes the options handed to the stream function. What a provider does with them on the wire is
 * covered by the provider suites in `@veyyon/ai`.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "@veyyon/agent-core/types";
import type { Message, Model, SimpleStreamOptions } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { Effort } from "@veyyon/catalog/effort";
import { type } from "arktype";
import { createUserMessage } from "./helpers";

type ConfigResolver = Extract<keyof AgentLoopConfig, `get${string}` | `${string}Resolver`>;

interface ProviderCall {
	model: Model;
	options: SimpleStreamOptions | undefined;
}

interface ResolverCase {
	/** The resolver and the static field beside it. `callsSent` counts the provider calls already made. */
	fields(callsSent: () => number): Partial<AgentLoopConfig>;
	/** The value the case asserts on, read from one provider call. */
	observe(call: ProviderCall): unknown;
	/** What the first and the second provider call carry. */
	expected: readonly [unknown, unknown];
}

const FIRST_MODEL = createMockModel({ id: "model-first" });
const SECOND_MODEL = createMockModel({ id: "model-second" });

const REQUEST_VALUES = {
	getApiKey: {
		fields: callsSent => ({ apiKey: "static-key", getApiKey: () => (callsSent() === 0 ? "key-first" : undefined) }),
		observe: call => call.options?.apiKey,
		expected: ["key-first", "static-key"],
	},
	getReasoning: {
		fields: callsSent => ({
			reasoning: Effort.Low,
			getReasoning: () => (callsSent() === 0 ? Effort.High : undefined),
		}),
		observe: call => call.options?.reasoning,
		expected: [Effort.High, Effort.Low],
	},
	getDisableReasoning: {
		fields: callsSent => ({
			disableReasoning: false,
			getDisableReasoning: () => (callsSent() === 0 ? true : undefined),
		}),
		observe: call => call.options?.disableReasoning,
		expected: [true, false],
	},
	// Authoritative: an `undefined` return replaces the static tier rather than falling back to it.
	getServiceTier: {
		fields: callsSent => ({
			serviceTier: "priority",
			getServiceTier: () => (callsSent() === 0 ? "flex" : undefined),
		}),
		observe: call => call.options?.serviceTier,
		expected: ["flex", undefined],
	},
	getCwd: {
		fields: callsSent => ({
			cwd: "/repo/static",
			getCwd: () => (callsSent() === 0 ? "/repo/moved" : undefined),
		}),
		observe: call => call.options?.cwd,
		expected: ["/repo/moved", "/repo/static"],
	},
	getModel: {
		fields: callsSent => ({ getModel: () => (callsSent() === 0 ? FIRST_MODEL : SECOND_MODEL) }),
		observe: call => call.model.id,
		expected: ["model-first", "model-second"],
	},
	getToolChoice: {
		fields: callsSent => ({
			toolChoice: "auto",
			getToolChoice: () => (callsSent() === 0 ? { type: "tool", name: "noop" } : undefined),
		}),
		observe: call => call.options?.toolChoice,
		expected: [{ type: "tool", name: "noop" }, "auto"],
	},
	metadataResolver: {
		fields: callsSent => ({
			metadata: { source: "static" },
			metadataResolver: provider => ({ provider, call: callsSent() }),
		}),
		observe: call => call.options?.metadata,
		expected: [
			{ provider: "mock", call: 0 },
			{ provider: "mock", call: 1 },
		],
	},
} satisfies Partial<Record<ConfigResolver, ResolverCase>>;

/** Resolvers whose value is not part of a provider request, with what each one feeds instead. */
const NOT_REQUEST_VALUES = {
	getSteeringMessages: "messages injected into the context between turns",
	getFollowUpMessages: "messages that start another run once this one would stop",
	getAsideMessages: "messages injected into the context between turns",
	getToolContext: "the context handed to a tool's execute",
} satisfies Record<Exclude<ConfigResolver, keyof typeof REQUEST_VALUES>, string>;

const noopSchema = type({});
const noopTool: AgentTool<typeof noopSchema> = {
	name: "noop",
	label: "Noop",
	description: "Does nothing",
	parameters: noopSchema,
	async execute() {
		return { content: [{ type: "text", text: "ok" }] };
	},
};

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** Run a turn that calls a tool, so the loop makes exactly two provider calls, and return what each call carried. */
async function runTwoCalls(fields: ResolverCase["fields"]): Promise<ProviderCall[]> {
	const calls: ProviderCall[] = [];
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", name: "noop", arguments: {} }] }, { content: ["done"] }],
	});
	const streamFn: StreamFn = (model, context, options) => {
		calls.push({ model, options });
		return mock.stream(model, context, options);
	};
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		...fields(() => calls.length),
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [noopTool] };
	await agentLoop([createUserMessage("go")], context, config, undefined, streamFn).result();
	return calls;
}

describe("a provider call carries what the loop config's resolvers return for that call", () => {
	const cases: [string, ResolverCase][] = Object.entries(REQUEST_VALUES);
	for (const [name, resolverCase] of cases) {
		it(`${name} is read for each call and wins over its static field`, async () => {
			const calls = await runTwoCalls(resolverCase.fields);
			expect(calls.map(resolverCase.observe)).toEqual([...resolverCase.expected]);
		});
	}

	it("records every other resolver as feeding something other than a request", () => {
		expect(Object.keys(NOT_REQUEST_VALUES).sort()).toEqual([
			"getAsideMessages",
			"getFollowUpMessages",
			"getSteeringMessages",
			"getToolContext",
		]);
	});
});
