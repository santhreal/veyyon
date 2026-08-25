/**
 * WHY: The streaming chunk loop in openai-completions.ts checks three reasoning
 * field names (`reasoning_content`, `reasoning`, `reasoning_text`) on every
 * delta. The array was hoisted from a per-chunk allocation to a module-scope
 * constant (`REASONING_DELTA_FIELDS`). This suite closes the class by
 * asserting all three field names still produce thinking blocks when streamed,
 * and that the first non-empty field wins when multiple are present.
 *
 * A regression that drops a field from the constant, or reorders it so a
 * lower-priority field shadows a higher one, will fail on the content
 * assertions below.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";

function createSseResponse(events: unknown[]): Response {
	const payload = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createMockFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		return createSseResponse(events);
	}
	return Object.assign(mockFetch, { preconnect: fetch.preconnect });
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Think.", timestamp: Date.now() }],
	};
}

function customReasoningModel(id = "test-reasoning"): Model<"openai-completions"> {
	const base = getBundledModel("openai", "gpt-4o-mini");
	return buildModel({
		...base,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://test.example.com/v1",
		id,
		reasoning: true,
		compat: base.compatConfig,
	} as ModelSpec<"openai-completions">);
}

function deltaChunk(model: Model<"openai-completions">, delta: Record<string, unknown>): unknown {
	return {
		id: "x",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta }],
	};
}

const finishChunk = (model: Model<"openai-completions">) => ({
	id: "x",
	object: "chat.completion.chunk",
	created: 0,
	model: model.id,
	choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
});

describe("openai-completions streaming reasoning field detection", () => {
	it("captures reasoning_content deltas as thinking blocks", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { reasoning_content: "thinking A" }),
			finishChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thinking A", thinkingSignature: "reasoning_content" },
		]);
	});

	it("captures reasoning deltas as thinking blocks", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { reasoning: "thinking B" }),
			finishChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thinking B", thinkingSignature: "reasoning" },
		]);
	});

	it("captures reasoning_text deltas as thinking blocks", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { reasoning_text: "thinking C" }),
			finishChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thinking C", thinkingSignature: "reasoning_text" },
		]);
	});

	it("uses the first non-empty reasoning field when multiple are present", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { reasoning_content: "winner", reasoning: "loser", reasoning_text: "also loser" }),
			finishChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "winner", thinkingSignature: "reasoning_content" },
		]);
	});

	it("concatenates reasoning deltas across chunks", async () => {
		const model = customReasoningModel();
		const fetchMock = createMockFetch([
			deltaChunk(model, { reasoning_content: "part1 " }),
			deltaChunk(model, { reasoning_content: "part2" }),
			finishChunk(model),
			"[DONE]",
		]);

		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "high",
		}).result();

		expect(result.content).toEqual([
			{ type: "thinking", thinking: "part1 part2", thinkingSignature: "reasoning_content" },
		]);
	});
});
