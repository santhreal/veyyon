import { emptyUsage } from "@veyyon/catalog/models";
import { untilAborted } from "@veyyon/utils/abortable";
import { registerCustomApi } from "../api-registry";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type {
	MockApi,
	MockCall,
	MockContent,
	MockHandler,
	MockModelOptions,
	MockResponse,
	MockResponseSource,
} from "./mock-helpers";
import { MOCK_API, ZERO_COST } from "./mock-helpers";

export type { MockContent, MockHandler, MockModelOptions, MockResponse, MockResponseSource };
export { MOCK_API };

export class MockModel implements Model<MockApi> {
	readonly id: string;
	readonly name: string;
	readonly api: MockApi = MOCK_API;
	readonly provider: string;
	readonly baseUrl = "mock://";
	readonly reasoning: boolean;
	readonly input: ("text" | "image")[] = ["text"];
	readonly cost: Model["cost"];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly compat = undefined;

	readonly calls: MockCall[] = [];

	iterator?: Iterator<MockHandler> | AsyncIterator<MockHandler>;
	exhausted: boolean;
	readonly extras: MockHandler[] = [];
	fallback?: MockHandler;
	toolCallCounter = 0;

	constructor(options: MockModelOptions = {}) {
		this.id = options.id ?? "mock-model";
		this.name = options.id ?? "mock-model";
		this.provider = options.provider ?? "mock";
		this.reasoning = options.reasoning ?? false;
		this.cost = options.cost ?? ZERO_COST;
		this.contextWindow = options.contextWindow ?? 200_000;
		this.maxTokens = options.maxTokens ?? 32_768;
		this.iterator = options.responses === undefined ? undefined : iteratorOf(options.responses);
		this.exhausted = options.responses === undefined;
		this.fallback = options.handler;
	}

	get model(): this {
		return this;
	}

	stream = (_model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream =>
		streamMock(this, context, options);

	push(response: MockHandler): void {
		this.extras.push(response);
	}

	reset(): void {
		this.extras.length = 0;
		this.calls.length = 0;
		this.toolCallCounter = 0;
	}
}
export function isMockModel(model: Model<Api>): model is MockModel {
	return model instanceof MockModel;
}

export function createMockModel(options: MockModelOptions = {}): MockModel {
	return new MockModel(options);
}

export function streamMock(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	if (!isMockModel(model)) {
		queueMicrotask(() => {
			stream.fail(
				new AIError.ValidationError(
					"streamMock called with a model not produced by createMockModel(). " + "Pass a MockModel instance.",
				),
			);
		});
		return stream;
	}

	model.calls.push({ context, options });
	void runMock(stream, model, context, options);
	return stream;
}

export function registerMockApi(sourceId = "pi-ai/mock"): void {
	registerCustomApi(MOCK_API, streamMock, sourceId);
}

// Internal

function iteratorOf(source: MockResponseSource): Iterator<MockHandler> | AsyncIterator<MockHandler> {
	if (Symbol.asyncIterator in source) {
		return (source as AsyncIterable<MockHandler>)[Symbol.asyncIterator]();
	}
	return (source as Iterable<MockHandler>)[Symbol.iterator]();
}

async function pullHandler(state: MockModel): Promise<MockHandler | undefined> {
	if (state.iterator && !state.exhausted) {
		const result = await Promise.resolve(state.iterator.next());
		if (!result.done) return result.value;
		state.exhausted = true;
	}
	if (state.extras.length > 0) return state.extras.shift();
	return state.fallback;
}

async function runMock(
	stream: AssistantMessageEventStream,
	model: MockModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
): Promise<void> {
	const startedAt = Date.now();
	const perfStart = performance.now();

	let handler: MockHandler | undefined;
	try {
		handler = await pullHandler(model);
	} catch (err) {
		stream.fail(err);
		return;
	}

	if (handler === undefined) {
		stream.fail(
			new AIError.ValidationError(
				`Mock model "${model.id}" received call ${model.calls.length} but no response or handler is configured.`,
			),
		);
		return;
	}

	let response: MockResponse;
	try {
		response = typeof handler === "function" ? await handler(context, options) : handler;
	} catch (err) {
		stream.fail(err);
		return;
	}

	if (response.responseHeaders && options?.onResponse) {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.responseHeaders)) {
			headers[key.toLowerCase()] = value;
		}
		try {
			await options.onResponse(
				{
					status: response.responseStatus ?? 200,
					headers,
					...(response.responseRequestId !== undefined ? { requestId: response.responseRequestId } : {}),
				},
				model,
			);
		} catch (err) {
			stream.fail(err);
			return;
		}
	}

	if (response.delayMs && response.delayMs > 0) {
		const delayMs = response.delayMs;
		try {
			await untilAborted(options?.signal, () => Bun.sleep(delayMs));
		} catch {
			emitTerminalError(stream, model, startedAt, perfStart, "aborted", "Mock aborted during delay.");
			return;
		}
	}

	if (response.throw !== undefined) {
		const message =
			typeof response.throw === "string"
				? response.throw
				: response.throw instanceof Error
					? response.throw.message
					: String(response.throw);
		emitTerminalError(stream, model, startedAt, perfStart, "error", message);
		return;
	}

	const blocks: Array<TextContent | ThinkingContent | ToolCall> = [];
	const partial: AssistantMessage = {
		role: "assistant",
		content: blocks,
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseId: response.responseId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: startedAt,
	};

	stream.push({ type: "start", partial });

	for (const input of response.content ?? []) {
		const block = normalizeContent(input, model);
		blocks.push(block);
		const contentIndex = blocks.length - 1;

		if (block.type === "text") {
			stream.push({ type: "text_start", contentIndex, partial });
			stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
			stream.push({ type: "text_end", contentIndex, content: block.text, partial });
		} else if (block.type === "thinking") {
			stream.push({ type: "thinking_start", contentIndex, partial });
			stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
		} else {
			const serialized = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
			stream.push({ type: "toolcall_start", contentIndex, partial });
			stream.push({ type: "toolcall_delta", contentIndex, delta: serialized, partial });
			stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
		}
	}

	const hasToolCall = blocks.some(b => b.type === "toolCall");
	const reason: StopReason = response.stopReason ?? (hasToolCall ? ("toolUse" as StopReason) : ("stop" as StopReason));

	partial.stopReason = reason;
	partial.stopDetails = response.stopDetails;
	partial.errorMessage = response.errorMessage;
	partial.usage = mergeUsage(response.usage);
	partial.duration = performance.now() - perfStart;

	if (reason === "aborted" || reason === "error") {
		stream.push({
			type: "error",
			reason,
			error: { ...partial, errorMessage: partial.errorMessage ?? "mock error" },
		});
		return;
	}
	stream.push({ type: "done", reason: reason as "stop" | "length" | "toolUse", message: partial });
}

function normalizeContent(input: MockContent, state: MockModel): TextContent | ThinkingContent | ToolCall {
	if (typeof input === "string") {
		return { type: "text", text: input };
	}
	if (input.type === "toolCall") {
		return {
			type: "toolCall",
			id: input.id ?? generateToolCallId(state),
			name: input.name,
			arguments: typeof input.arguments === "string" ? input.arguments : { ...input.arguments },
		} as ToolCall;
	}
	return input;
}

function mergeUsage(partial?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> }): Usage {
	const base = emptyUsage();
	if (!partial) return base;
	const merged = { ...base, ...partial } as Usage;
	const costProvided = partial.cost !== undefined;
	if (costProvided) {
		merged.cost = { ...base.cost, ...partial.cost } as Usage["cost"];
	}
	// Recompute totalTokens when not explicitly provided (canonical formula matches types.ts).
	if (partial.totalTokens === undefined) {
		const orchestration = merged.orchestration;
		merged.totalTokens =
			merged.input +
			merged.output +
			merged.cacheRead +
			merged.cacheWrite +
			(orchestration?.input ?? 0) +
			(orchestration?.output ?? 0) +
			(orchestration?.cacheRead ?? 0);
	}
	// Recompute cost.total when cost components were supplied without an explicit total.
	if (costProvided && partial.cost?.total === undefined) {
		merged.cost.total = merged.cost.input + merged.cost.output + merged.cost.cacheRead + merged.cost.cacheWrite;
	}
	return merged;
}

function emitTerminalError(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	startedAt: number,
	perfStart: number,
	reason: "aborted" | "error",
	message: string,
): void {
	const failure: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: reason as StopReason,
		errorMessage: message,
		timestamp: startedAt,
		duration: performance.now() - perfStart,
	};
	stream.push({ type: "start", partial: failure });
	stream.push({ type: "error", reason, error: failure });
}

function generateToolCallId(state: MockModel): string {
	state.toolCallCounter += 1;
	return `mock-tc-${state.toolCallCounter}`;
}
