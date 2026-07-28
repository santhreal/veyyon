import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary } from "@bufbuild/protobuf";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { sha256Hex } from "@veyyon/ai/providers/aws-sigv4";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentRunRequestSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { withEnv } from "./helpers";

const ORIGINAL_SECRET = "raw-payload-secret";
const MUTATED_SECRET = "mutated-intermediate-secret";

function contextWithSecret(): Context {
	return { messages: [{ role: "user", content: ORIGINAL_SECRET, timestamp: 0 }] };
}

function asFetch(implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchImpl {
	return Object.assign(implementation, { preconnect: fetch.preconnect });
}

function bodyBytes(body: RequestInit["body"] | undefined): Uint8Array {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	throw new Error(`unexpected request body: ${Object.prototype.toString.call(body)}`);
}

function openAIModel(): Model<"openai-completions"> {
	return buildModel({
		id: "payload-seam-openai",
		name: "Payload seam OpenAI",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://payload-seam.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 1_024,
	});
}

function bedrockModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.payload-seam-v1",
		name: "Payload seam Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 1_024,
	});
}

function cursorModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-payload-seam",
		name: "Payload seam Cursor",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 1_024,
	});
}

interface H2CaptureServer {
	baseUrl: string;
	frames: Buffer[];
	streamCount: () => number;
	close: () => Promise<void>;
}

async function startH2CaptureServer(): Promise<H2CaptureServer> {
	const frames: Buffer[] = [];
	let streamCount = 0;
	const server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		streamCount++;
		let buffered = Buffer.alloc(0);
		let responded = false;
		stream.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (responded || buffered.length < 5) return;
			const length = buffered.readUInt32BE(1);
			if (buffered.length < 5 + length) return;
			responded = true;
			frames.push(buffered.subarray(0, 5 + length));
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end();
		});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("HTTP/2 test server has no TCP address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		frames,
		streamCount: () => streamCount,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

function decodeCursorRunRequest(frame: Buffer): AgentRunRequest {
	const length = frame.readUInt32BE(1);
	const clientMessage = fromBinary(AgentClientMessageSchema, frame.subarray(5, 5 + length));
	if (clientMessage.message.case !== "runRequest") throw new Error("expected Cursor runRequest frame");
	return clientMessage.message.value;
}

describe("onPayload is the final physical transport seam", () => {
	it("replaces every OpenAI completion retry body after an async yield", async () => {
		const bodies: string[] = [];
		let hookCalls = 0;
		const customFetch = asFetch(async (_input, init) => {
			bodies.push(new TextDecoder().decode(bodyBytes(init?.body)));
			return new Response(hookCalls === 1 ? "retry" : "bad request", {
				status: hookCalls === 1 ? 500 : 400,
				headers: { "retry-after": "0" },
			});
		});

		const result = await streamOpenAICompletions(openAIModel(), contextWithSecret(), {
			apiKey: "resolved-openai-credential",
			fetch: customFetch,
			onPayload: async payload => {
				hookCalls++;
				const raw = payload as Record<string, unknown>;
				expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
				raw.messages = [{ role: "user", content: MUTATED_SECRET }];
				await Promise.resolve();
				return {
					...raw,
					messages: [{ role: "user", content: `safe-openai-${hookCalls}` }],
					payloadAttempt: hookCalls,
				};
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(hookCalls).toBe(2);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain("safe-openai-1");
		expect(bodies[1]).toContain("safe-openai-2");
		expect(bodies.join("\n")).not.toContain(ORIGINAL_SECRET);
		expect(bodies.join("\n")).not.toContain(MUTATED_SECRET);
	});

	it("signs each Bedrock retry over only its async replacement bytes", async () => {
		await withEnv({ AWS_BEDROCK_SKIP_AUTH: "1", AWS_REGION: "us-east-1" }, async () => {
			const captures: Array<{ body: Uint8Array; payloadHash: string | null }> = [];
			let hookCalls = 0;
			const customFetch = asFetch(async (_input, init) => {
				const body = bodyBytes(init?.body);
				captures.push({
					body: Uint8Array.from(body),
					payloadHash: new Headers(init?.headers).get("x-amz-content-sha256"),
				});
				return new Response(hookCalls === 1 ? "retry" : "bad request", {
					status: hookCalls === 1 ? 500 : 400,
					headers: { "retry-after": "0" },
				});
			});

			const result = await streamBedrock(bedrockModel(), contextWithSecret(), {
				fetch: customFetch,
				maxTokens: 64,
				onPayload: async payload => {
					hookCalls++;
					const raw = payload as Record<string, unknown>;
					expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
					raw.messages = [{ role: "user", content: [{ text: MUTATED_SECRET }] }];
					await Promise.resolve();
					return {
						...raw,
						messages: [{ role: "user", content: [{ text: `safe-bedrock-${hookCalls}` }] }],
						payloadAttempt: hookCalls,
					};
				},
			}).result();

			expect(result.stopReason).toBe("error");
			expect(hookCalls).toBe(2);
			expect(captures).toHaveLength(2);
			for (const [index, capture] of captures.entries()) {
				const wireText = new TextDecoder().decode(capture.body);
				expect(wireText).toContain(`safe-bedrock-${index + 1}`);
				expect(wireText).not.toContain(ORIGINAL_SECRET);
				expect(wireText).not.toContain(MUTATED_SECRET);
				expect(capture.payloadHash).toBe(await sha256Hex(capture.body));
			}
		});
	});

	/**
	 * Regression: Bedrock's HTTP retry helper owns multiple physical attempts.
	 * Every attempt must rebuild the hook-replaced body and announce its response
	 * before the next payload is prepared, including retryable 5xx responses.
	 */
	it("orders Bedrock payload, fetch, and response hooks once per physical attempt", async () => {
		const order: string[] = [];
		const bodies: Array<Record<string, unknown>> = [];
		let payloadAttempt = 0;
		let fetchAttempt = 0;
		const result = await streamBedrock(bedrockModel(), contextWithSecret(), {
			bearerToken: "resolved-bedrock-credential",
			fetch: asFetch(async (_input, init) => {
				fetchAttempt++;
				order.push(`fetch:${fetchAttempt}`);
				bodies.push(JSON.parse(new TextDecoder().decode(bodyBytes(init?.body))) as Record<string, unknown>);
				return new Response(fetchAttempt === 1 ? "retry" : "bad request", {
					status: fetchAttempt === 1 ? 500 : 400,
					headers: {
						"retry-after": "0",
						"x-amzn-requestid": `bedrock-request-${fetchAttempt}`,
					},
				});
			}),
			maxTokens: 64,
			onPayload: async payload => {
				payloadAttempt++;
				order.push(`payload:${payloadAttempt}`);
				await Promise.resolve();
				return { ...(payload as Record<string, unknown>), payloadAttempt };
			},
			onResponse: response => {
				order.push(`response:${response.status}:${response.requestId}`);
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(order).toEqual([
			"payload:1",
			"fetch:1",
			"response:500:bedrock-request-1",
			"payload:2",
			"fetch:2",
			"response:400:bedrock-request-2",
		]);
		expect(bodies.map(body => body.payloadAttempt)).toEqual([1, 2]);
	});

	/**
	 * Regression: a rejecting Bedrock response hook must not be mistaken for a
	 * transient fetch error. Even when the received status is retryable, the hook
	 * failure wins immediately and cannot create duplicate physical attempts.
	 */
	it("does not retry a Bedrock response-hook failure", async () => {
		const order: string[] = [];
		const result = await streamBedrock(bedrockModel(), contextWithSecret(), {
			bearerToken: "resolved-bedrock-credential",
			fetch: asFetch(async () => {
				order.push("fetch");
				return new Response("retryable upstream failure", {
					status: 503,
					headers: { "retry-after": "0", "x-amzn-requestid": "bedrock-hook-failure" },
				});
			}),
			maxTokens: 64,
			onPayload: () => {
				order.push("payload");
			},
			onResponse: async response => {
				order.push(`response:${response.status}:${response.requestId}`);
				await Promise.resolve();
				throw new Error("bedrock response hook rejected");
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock response hook rejected");
		expect(order).toEqual(["payload", "fetch", "response:503:bedrock-hook-failure"]);
	});

	it("serializes only the async Cursor replacement into the gRPC request", async () => {
		const server = await startH2CaptureServer();
		try {
			let hookCalls = 0;
			const result = await streamCursor(cursorModel(server.baseUrl), contextWithSecret(), {
				apiKey: "resolved-cursor-credential",
				onPayload: async payload => {
					hookCalls++;
					const raw = payload as AgentRunRequest;
					expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
					raw.conversationId = MUTATED_SECRET;
					await Promise.resolve();
					return create(AgentRunRequestSchema, { conversationId: "safe-cursor-replacement" });
				},
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(hookCalls).toBe(1);
			expect(server.frames).toHaveLength(1);
			const frame = server.frames[0];
			expect(frame.includes(Buffer.from(ORIGINAL_SECRET))).toBe(false);
			expect(frame.includes(Buffer.from(MUTATED_SECRET))).toBe(false);
			expect(decodeCursorRunRequest(frame).conversationId).toBe("safe-cursor-replacement");
		} finally {
			await server.close();
		}
	});

	it("does not dispatch any provider when its async hook rejects", async () => {
		let openAIDispatches = 0;
		const openAIResult = await streamOpenAICompletions(openAIModel(), contextWithSecret(), {
			apiKey: "resolved-openai-credential",
			fetch: asFetch(async () => {
				openAIDispatches++;
				return new Response(null, { status: 200 });
			}),
			onPayload: async () => {
				await Promise.resolve();
				throw new Error("openai hook rejected");
			},
		}).result();
		expect(openAIResult.stopReason).toBe("error");
		expect(openAIDispatches).toBe(0);

		let bedrockDispatches = 0;
		const bedrockResult = await streamBedrock(bedrockModel(), contextWithSecret(), {
			bearerToken: "resolved-bedrock-credential",
			fetch: asFetch(async () => {
				bedrockDispatches++;
				return new Response(null, { status: 200 });
			}),
			onPayload: async () => {
				await Promise.resolve();
				throw new Error("bedrock hook rejected");
			},
		}).result();
		expect(bedrockResult.stopReason).toBe("error");
		expect(bedrockDispatches).toBe(0);

		const cursorServer = await startH2CaptureServer();
		try {
			const cursorResult = await streamCursor(cursorModel(cursorServer.baseUrl), contextWithSecret(), {
				apiKey: "resolved-cursor-credential",
				onPayload: async () => {
					await Promise.resolve();
					throw new Error("cursor hook rejected");
				},
			}).result();
			expect(cursorResult.stopReason).toBe("error");
			expect(cursorServer.streamCount()).toBe(0);
		} finally {
			await cursorServer.close();
		}
	});
});
