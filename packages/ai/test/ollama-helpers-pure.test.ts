import { describe, expect, it } from "bun:test";
import { createEmptyOutput, iterateNdjson, OLLAMA_RESPONSE_RETRY_POLICY } from "../src/providers/ollama";
import type { Model } from "../src/types";

function makeModel(): Model<"ollama-chat"> {
	return { id: "llama3", provider: "ollama", api: "ollama-chat" } as unknown as Model<"ollama-chat">;
}

describe("OLLAMA_RESPONSE_RETRY_POLICY", () => {
	it("has api set to ollama-chat", () => {
		expect(OLLAMA_RESPONSE_RETRY_POLICY.api).toBe("ollama-chat");
	});
	it("refusesReplay returns true for llama.cpp parse error", () => {
		expect(OLLAMA_RESPONSE_RETRY_POLICY.refusesReplay?.("failed to parse tool call arguments as json")).toBe(true);
	});
	it("refusesReplay returns false for unrelated error", () => {
		expect(OLLAMA_RESPONSE_RETRY_POLICY.refusesReplay?.("some other error")).toBe(false);
	});
	it("refusesReplay returns true for json.exception.parse_error.101", () => {
		expect(OLLAMA_RESPONSE_RETRY_POLICY.refusesReplay?.("[json.exception.parse_error.101] bad")).toBe(true);
	});
});

describe("createEmptyOutput", () => {
	it("creates an assistant message with empty content", () => {
		const output = createEmptyOutput(makeModel());
		expect(output.role).toBe("assistant");
		expect(output.content).toEqual([]);
		expect(output.api).toBe("ollama-chat");
		expect(output.provider).toBe("ollama");
		expect(output.model).toBe("llama3");
		expect(output.stopReason).toBe("stop");
	});
	it("has empty usage", () => {
		const output = createEmptyOutput(makeModel());
		expect(output.usage.input).toBe(0);
		expect(output.usage.output).toBe(0);
	});
	it("has a timestamp", () => {
		const output = createEmptyOutput(makeModel());
		expect(typeof output.timestamp).toBe("number");
	});
});

describe("iterateNdjson", () => {
	it("yields JSON objects from newline-delimited stream", async () => {
		const data = '{"a":1}\n{"b":2}\n';
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(data));
				controller.close();
			},
		});
		const results: unknown[] = [];
		for await (const chunk of iterateNdjson(stream)) results.push(chunk);
		expect(results).toEqual([{ a: 1 }, { b: 2 }]);
	});
	it("handles empty stream", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const results: unknown[] = [];
		for await (const chunk of iterateNdjson(stream)) results.push(chunk);
		expect(results).toEqual([]);
	});
	it("handles stream with only whitespace", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("\n\n\n"));
				controller.close();
			},
		});
		const results: unknown[] = [];
		for await (const chunk of iterateNdjson(stream)) results.push(chunk);
		expect(results).toEqual([]);
	});
	it("handles chunked delivery across line boundaries", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"a":1}\n{"b":'));
				controller.enqueue(new TextEncoder().encode("2}\n"));
				controller.close();
			},
		});
		const results: unknown[] = [];
		for await (const chunk of iterateNdjson(stream)) results.push(chunk);
		expect(results).toEqual([{ a: 1 }, { b: 2 }]);
	});
	it("handles trailing line without newline", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"a":1}\n{"b":2}'));
				controller.close();
			},
		});
		const results: unknown[] = [];
		for await (const chunk of iterateNdjson(stream)) results.push(chunk);
		expect(results).toEqual([{ a: 1 }, { b: 2 }]);
	});
	it("handles multiple chunks in one enqueue", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"a":1}\n{"b":2}\n{"c":3}\n'));
				controller.close();
			},
		});
		const results: unknown[] = [];
		for await (const chunk of iterateNdjson(stream)) results.push(chunk);
		expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});
});
