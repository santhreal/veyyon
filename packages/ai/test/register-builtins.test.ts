import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	createLazyStream,
	type LazyProviderModule,
	providerModuleOverrideSnapshot,
	setProviderModuleOverrideForTest,
	streamBedrock,
} from "@veyyon/ai/providers/register-builtins";
import type { Api, AssistantMessage, Context, Model } from "@veyyon/ai/types";
import type { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";

let inheritedOverrides: ReadonlyMap<Api, LazyProviderModule<Api>> = new Map();

beforeEach(() => {
	inheritedOverrides = providerModuleOverrideSnapshot();
});

afterEach(() => {
	setProviderModuleOverrideForTest("bedrock-converse-stream", inheritedOverrides.get("bedrock-converse-stream"));
});

function createModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ? `error: ${errorMessage}` : "ok" }],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

describe("register-builtins lazy streams", () => {
	it("resolves the outer stream result from source.result() when no terminal event is iterated", async () => {
		const finalMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setProviderModuleOverrideForTest("bedrock-converse-stream", {
			stream: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream result");
		}
		expect(result).toEqual(finalMessage);
	});

	it("turns iterator failures into terminal error results", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				throw new Error("bedrock exploded");
			},
		} as unknown as AssistantMessageEventStream;

		setProviderModuleOverrideForTest("bedrock-converse-stream", {
			stream: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded error result");
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock exploded");
	});

	it("turns idle lazy provider streams into retryable terminal errors", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setProviderModuleOverrideForTest("bedrock-converse-stream", {
			stream: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 10 });
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("preserves caller aborts while forwarding lazy provider streams", async () => {
		const abortController = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				const { promise, reject } = Promise.withResolvers<never>();
				if (providerSignal?.aborted) {
					reject(new Error("Request was aborted"));
				}
				providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
					once: true,
				});
				await promise;
			},
		} as unknown as AssistantMessageEventStream;

		setProviderModuleOverrideForTest("bedrock-converse-stream", {
			stream: (_model, _context, options) => {
				providerSignal = options.signal;
				return source;
			},
		});

		const stream = streamBedrock(createModel(), baseContext, {
			signal: abortController.signal,
			streamIdleTimeoutMs: 500,
		});
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");

		abortController.abort();
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded caller abort result");
		}
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("concurrent first calls invoke dynamic import factory once", async () => {
		let loadCalls = 0;
		const expectedMessage = createAssistantMessage("stop", undefined);
		const streamFn = createLazyStream("bedrock-converse-stream", async () => {
			loadCalls++;
			await Promise.resolve();
			return {
				stream: () =>
					({
						async *[Symbol.asyncIterator]() {
							yield { type: "start", partial: expectedMessage } as const;
							yield { type: "done", reason: "stop", message: expectedMessage } as const;
						},
						result: async () => expectedMessage,
					}) as unknown as AssistantMessageEventStream,
			};
		});

		const [s1, s2] = [streamFn(createModel(), baseContext, {}), streamFn(createModel(), baseContext, {})];
		const results = await Promise.race([
			Promise.all([s1.result(), s2.result()]),
			Bun.sleep(100).then(() => "timeout" as const),
		]);

		expect(results).not.toBe("timeout");
		if (results === "timeout") throw new Error("Timed out waiting for concurrent streams");
		expect(loadCalls).toBe(1);
		expect(results[0]).toEqual(expectedMessage);
		expect(results[1]).toEqual(expectedMessage);
	});

	it("cold override prevents dynamic import until removed, then first real load occurs", async () => {
		let loadCalls = 0;
		const realMessage = createAssistantMessage("stop", undefined);
		const coldOverrideMessage = { ...createAssistantMessage("stop", undefined), model: "cold-override-model" };

		const streamFn = createLazyStream("bedrock-converse-stream", async () => {
			loadCalls++;
			return {
				stream: () =>
					({
						async *[Symbol.asyncIterator]() {
							yield { type: "start", partial: realMessage } as const;
							yield { type: "done", reason: "stop", message: realMessage } as const;
						},
						result: async () => realMessage,
					}) as unknown as AssistantMessageEventStream,
			};
		});

		// 1. Install override before ANY stream calls (cold state)
		setProviderModuleOverrideForTest("bedrock-converse-stream", {
			stream: () =>
				({
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: coldOverrideMessage } as const;
						yield { type: "done", reason: "stop", message: coldOverrideMessage } as const;
					},
					result: async () => coldOverrideMessage,
				}) as unknown as AssistantMessageEventStream,
		});

		// 2. Stream call under cold override uses override, import factory NOT called
		const s1 = streamFn(createModel(), baseContext, {});
		const r1 = await Promise.race([s1.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r1).not.toBe("timeout");
		expect(loadCalls).toBe(0);
		expect(r1).toEqual(coldOverrideMessage);

		// 3. Remove override -> next stream call triggers the first real import
		setProviderModuleOverrideForTest("bedrock-converse-stream", inheritedOverrides.get("bedrock-converse-stream"));

		const s2 = streamFn(createModel(), baseContext, {});
		const r2 = await Promise.race([s2.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r2).not.toBe("timeout");
		expect(loadCalls).toBe(1);
		expect(r2).toEqual(realMessage);

		// 4. Subsequent stream call reuses cached real import
		const s3 = streamFn(createModel(), baseContext, {});
		const r3 = await Promise.race([s3.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r3).not.toBe("timeout");
		expect(loadCalls).toBe(1);
		expect(r3).toEqual(realMessage);
	});

	it("overrides apply even after a module has been cached and removing resumes original cached module", async () => {
		let loadCalls = 0;
		const cachedMessage = createAssistantMessage("stop", undefined);
		const overrideMessage = { ...createAssistantMessage("stop", undefined), model: "override-model" };

		const streamFn = createLazyStream("bedrock-converse-stream", async () => {
			loadCalls++;
			return {
				stream: () =>
					({
						async *[Symbol.asyncIterator]() {
							yield { type: "start", partial: cachedMessage } as const;
							yield { type: "done", reason: "stop", message: cachedMessage } as const;
						},
						result: async () => cachedMessage,
					}) as unknown as AssistantMessageEventStream,
			};
		});

		// 1. Initial call caches the module
		const s1 = streamFn(createModel(), baseContext, {});
		const r1 = await Promise.race([s1.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r1).not.toBe("timeout");
		expect(loadCalls).toBe(1);
		expect(r1).toEqual(cachedMessage);

		// 2. Install test override after module is cached
		setProviderModuleOverrideForTest("bedrock-converse-stream", {
			stream: () =>
				({
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: overrideMessage } as const;
						yield { type: "done", reason: "stop", message: overrideMessage } as const;
					},
					result: async () => overrideMessage,
				}) as unknown as AssistantMessageEventStream,
		});

		const s2 = streamFn(createModel(), baseContext, {});
		const r2 = await Promise.race([s2.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r2).not.toBe("timeout");
		expect(loadCalls).toBe(1); // Not called again
		expect(r2).toEqual(overrideMessage);

		// 3. Remove override -> resumes original cached module
		setProviderModuleOverrideForTest("bedrock-converse-stream", inheritedOverrides.get("bedrock-converse-stream"));

		const s3 = streamFn(createModel(), baseContext, {});
		const r3 = await Promise.race([s3.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r3).not.toBe("timeout");
		expect(loadCalls).toBe(1); // Still 1, reused cached module
		expect(r3).toEqual(cachedMessage);
	});

	it("failed dynamic imports remain cached on subsequent stream calls", async () => {
		let loadCalls = 0;
		const streamFn = createLazyStream("bedrock-converse-stream", async () => {
			loadCalls++;
			throw new Error("Failed to load provider SDK");
		});

		const s1 = streamFn(createModel(), baseContext, {});
		const r1 = await Promise.race([s1.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r1).not.toBe("timeout");
		if (r1 === "timeout") throw new Error("Timed out waiting for s1 error result");
		expect(loadCalls).toBe(1);
		expect(r1.stopReason).toBe("error");
		expect(r1.errorMessage).toBe("Failed to load provider SDK");
		expect(r1.api).toBe("bedrock-converse-stream");
		expect(r1.model).toBe("mock-bedrock");

		const s2 = streamFn(createModel(), baseContext, {});
		const r2 = await Promise.race([s2.result(), Bun.sleep(100).then(() => "timeout" as const)]);
		expect(r2).not.toBe("timeout");
		if (r2 === "timeout") throw new Error("Timed out waiting for s2 error result");
		expect(loadCalls).toBe(1); // Factory is NOT retried
		expect(r2.stopReason).toBe("error");
		expect(r2.errorMessage).toBe("Failed to load provider SDK");
		expect(r2.api).toBe("bedrock-converse-stream");
		expect(r2.model).toBe("mock-bedrock");
	});
});
