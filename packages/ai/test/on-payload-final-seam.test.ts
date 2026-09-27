import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { sha256Hex } from "@veyyon/ai/providers/aws-sigv4";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import { streamOllama } from "@veyyon/ai/providers/ollama";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import * as piUtils from "@veyyon/utils";
import { withEnv } from "./helpers";

const ORIGINAL_SECRET = "raw-payload-secret";
const MUTATED_SECRET = "mutated-intermediate-secret";

/** The proto3 JSON form of `AgentRunRequest` the hook now receives. */
interface CursorRunRequestJson {
	conversationId?: string;
	[key: string]: unknown;
}

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

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	const payload = toBinary(AgentServerMessageSchema, message);
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
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
			// `turn_ended` is the only thing that tells the provider the turn is
			// over; without it the round is an incomplete stream, which is a
			// different subject from the payload seam this suite is about.
			stream.write(turnEndedFrame());
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

	/**
	 * The hook trades in canonical proto3 JSON, not a protobuf message: see the WHY
	 * on the shape test below. So the replacement it returns is JSON too, and the
	 * provider rebuilds the message from it.
	 */
	it("serializes only the async Cursor replacement into the gRPC request", async () => {
		const server = await startH2CaptureServer();
		try {
			let hookCalls = 0;
			const result = await streamCursor(cursorModel(server.baseUrl), contextWithSecret(), {
				apiKey: "resolved-cursor-credential",
				onPayload: async payload => {
					hookCalls++;
					const raw = payload as CursorRunRequestJson;
					expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
					raw.conversationId = MUTATED_SECRET;
					await Promise.resolve();
					return { conversationId: "safe-cursor-replacement" };
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

	/**
	 * WHY: `onPayload` is where a host puts its secret redactor, and a redactor has
	 * to WALK the payload and rewrite strings. `@veyyon/coding-agent`'s refuses any
	 * value JSON cannot express, so a provider handing it a live protobuf message
	 * did not degrade — every request died with "the provider request contains a
	 * non-JSON value/object; confidentiality transform failed", making that provider
	 * unusable for anyone with secrets configured. Devin shipped exactly that bug.
	 *
	 * `JSON.stringify` is NOT this check and is why the case above missed it: it
	 * turns a `Uint8Array` into `{"0":…}` and a plain object into itself, so it
	 * passes on payloads a walking redactor rejects. This asserts the shape instead.
	 *
	 * What it does not catch: a provider not driven here (gitlab-duo-workflow), and
	 * a field that only appears once real conversation history is present.
	 *
	 * Nor does it fail by default on a provider added later that serializes to a
	 * non-JSON wire format. Typing the hook's parameter `JsonValue` instead of
	 * `unknown` looks like the guard that would, and is not: the JSON-safe payloads
	 * the other providers pass are interfaces, which have no implicit index
	 * signature, so the change yields 16 errors on correct code and the casts that
	 * silence them are the same cast a protobuf provider would write. Cursor and
	 * Devin (devin-payload-seam.test.ts) are today's whole at-risk set, each driven
	 * through its real transport.
	 */
	it("hands Cursor's hook a payload a walking redactor can express", async () => {
		const server = await startH2CaptureServer();
		try {
			const offenders: string[] = [];
			const seen = new Set<unknown>();
			const walk = (node: unknown, path: string): void => {
				if (node === null) return;
				const kind = typeof node;
				if (kind === "bigint" || kind === "function" || kind === "symbol") {
					offenders.push(`${path}: ${kind}`);
					return;
				}
				if (kind !== "object" || seen.has(node)) return;
				seen.add(node);
				if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) {
					offenders.push(`${path}: ${Object.prototype.toString.call(node)}`);
					return;
				}
				if (Array.isArray(node)) {
					node.forEach((entry, index) => {
						walk(entry, `${path}[${index}]`);
					});
					return;
				}
				const proto = Object.getPrototypeOf(node);
				if (proto !== Object.prototype && proto !== null) {
					offenders.push(`${path}: ${proto?.constructor?.name ?? "non-plain"}`);
				}
				for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
					walk(value, `${path}.${key}`);
				}
			};

			await streamCursor(cursorModel(server.baseUrl), contextWithSecret(), {
				apiKey: "resolved-cursor-credential",
				onPayload: payload => {
					walk(payload, "runRequest");
				},
			}).result();

			expect(offenders).toEqual([]);
		} finally {
			await server.close();
		}
	});

	/**
	 * The other half of trading in JSON: the provider rebuilds the message from what
	 * the hook returns, and a redactor that finds nothing to redact hands back the
	 * payload it was given, so that path is the common one and must lose nothing.
	 * This is what would catch a `toJson`/`fromJson` asymmetry — a dropped default, a
	 * bytes field that does not survive base64, a 64-bit value mangled by a string.
	 *
	 * Deliberately NOT a comparison of wire bytes across two runs: the request
	 * carries per-call state, so two runs with no hook at all already differ, and
	 * such a test fails for a reason that has nothing to do with the seam.
	 */
	it("rebuilds Cursor's request from the JSON it handed out, losing nothing", async () => {
		const server = await startH2CaptureServer();
		try {
			let captured: JsonValue | undefined;
			await streamCursor(cursorModel(server.baseUrl), contextWithSecret(), {
				apiKey: "resolved-cursor-credential",
				onPayload: payload => {
					captured = payload as JsonValue;
				},
			}).result();

			expect(captured).toBeDefined();
			const before = captured as JsonValue;
			const rebuilt = toJson(AgentRunRequestSchema, fromJson(AgentRunRequestSchema, before));

			// Both sides come out of the same serializer, so key order is stable and a
			// dropped or mangled field shows up as a difference in the text.
			expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(before));
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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const GRAMMAR_TOO_LARGE = JSON.stringify({
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
	},
});

function wireText(body: RequestInit["body"] | undefined): string {
	return new TextDecoder().decode(bodyBytes(body));
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** A 500 the transport retries at once, then a 400 that ends the turn. */
function retryThenReject(attempt: number): Response {
	return new Response(attempt === 1 ? "retry" : "bad request", {
		status: attempt === 1 ? 500 : 400,
		headers: { "retry-after": "0" },
	});
}

/**
 * WHY: Anthropic, Ollama and Codex SSE serialize a request body once and reuse those bytes for the
 * wire, the 400 dump and every physical retry. The class this closes is a reused serialization that
 * went stale: bytes taken before the hook ran, an earlier attempt's bytes resent after a rebuild ran
 * the hook again, or the pre-hook object's bytes when the hook mutated its argument and returned
 * nothing. Each case pins the bytes of every physical attempt, with the hook returning a replacement
 * on one attempt and mutating in place on another.
 *
 * Not caught here: a transport that re-serializes correctly but redundantly (a cost, not a wrong
 * byte), and the Codex websocket frame, which `openai-codex-stream.test.ts` pins in "applies onPayload
 * to the final chained websocket frame".
 */
describe("a serialize-once transport sends the bytes its hook left, on every attempt", () => {
	const originalAgentDir = piUtils.getAgentDir();
	const originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
	const originalProfileEnv = process.env.VEYYON_PROFILE;

	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	});

	afterEach(() => {
		piUtils.setAgentDir(originalAgentDir);
		restoreEnv("VEYYON_CODING_AGENT_DIR", originalAgentDirEnv);
		restoreEnv("VEYYON_PROFILE", originalProfileEnv);
		piUtils.__resetDirsFromEnvForTests();
		vi.restoreAllMocks();
	});

	it("Anthropic sends a fallback's rebuilt bytes and resends them on a transient retry", async () => {
		const bodies: string[] = [];
		let hookCalls = 0;
		const result = await streamAnthropic(
			buildModel({
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://payload-seam.invalid",
				reasoning: false,
				input: ["text"],
				cost: ZERO_COST,
				contextWindow: 200_000,
				maxTokens: 1_024,
			}),
			contextWithSecret(),
			{
				apiKey: "resolved-anthropic-credential",
				fetch: asFetch(async (_input, init) => {
					bodies.push(wireText(init?.body));
					if (bodies.length === 1) {
						return new Response(GRAMMAR_TOO_LARGE, {
							status: 400,
							headers: { "content-type": "application/json" },
						});
					}
					return retryThenReject(bodies.length - 1);
				}),
				providerRetryWait: async () => {},
				onPayload: async payload => {
					hookCalls++;
					const raw = payload as Record<string, unknown>;
					expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
					await Promise.resolve();
					if (hookCalls === 1) {
						// Drops `stream` and adds a strict tool, so the grammar rejection rebuilds the request.
						const { stream: _stream, ...rest } = raw;
						return {
							...rest,
							messages: [{ role: "user", content: "safe-anthropic-1" }],
							tools: [
								{
									name: "edit",
									description: "Edit",
									strict: true,
									input_schema: { type: "object", properties: {} },
								},
							],
						};
					}
					raw.messages = [{ role: "user", content: `safe-anthropic-${hookCalls}` }];
					return undefined;
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(hookCalls).toBe(2);
		expect(bodies).toHaveLength(3);
		const first = JSON.parse(bodies[0]!) as Record<string, unknown>;
		expect(first.stream).toBe(true);
		expect(first.messages).toEqual([{ role: "user", content: "safe-anthropic-1" }]);
		expect((JSON.parse(bodies[1]!) as Record<string, unknown>).messages).toEqual([
			{ role: "user", content: "safe-anthropic-2" },
		]);
		expect(bodies[2]).toBe(bodies[1]);
		expect(bodies.join("\n")).not.toContain(ORIGINAL_SECRET);
	});

	it("Ollama sends and resends the bytes of the object its hook mutated", async () => {
		const bodies: string[] = [];
		let hookCalls = 0;
		const result = await streamOllama(
			buildModel({
				id: "payload-seam-ollama",
				name: "Payload seam Ollama",
				api: "ollama-chat",
				provider: "ollama",
				baseUrl: "https://payload-seam.invalid/v1",
				reasoning: false,
				input: ["text"],
				cost: ZERO_COST,
				contextWindow: 4_096,
				maxTokens: 1_024,
			}),
			contextWithSecret(),
			{
				apiKey: "resolved-ollama-credential",
				fetch: asFetch(async (_input, init) => {
					bodies.push(wireText(init?.body));
					return retryThenReject(bodies.length);
				}),
				onPayload: async payload => {
					hookCalls++;
					const raw = payload as Record<string, unknown>;
					expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
					await Promise.resolve();
					raw.messages = [{ role: "user", content: "safe-ollama" }];
					return undefined;
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(hookCalls).toBe(1);
		expect(bodies).toHaveLength(2);
		expect((JSON.parse(bodies[0]!) as Record<string, unknown>).messages).toEqual([
			{ role: "user", content: "safe-ollama" },
		]);
		expect(bodies[1]).toBe(bodies[0]);
	});

	it("Codex SSE sends each attempt's hook result, replaced or mutated in place", async () => {
		using tempDir = piUtils.TempDir.createSync("@pi-payload-final-seam-codex-");
		piUtils.setAgentDir(tempDir.path());
		const claims = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toBase64();
		const bodies: string[] = [];
		let hookCalls = 0;
		const safeInput = (text: string) => [{ role: "user", content: [{ type: "input_text", text }] }];
		const result = await streamOpenAICodexResponses(
			{
				...buildModel({
					id: "gpt-5.3-codex-spark",
					name: "GPT-5.3 Codex Spark",
					api: "openai-codex-responses",
					provider: "openai-codex",
					baseUrl: "https://payload-seam.invalid/backend-api",
					reasoning: true,
					input: ["text"],
					cost: ZERO_COST,
					contextWindow: 128_000,
					maxTokens: 1_024,
				}),
				preferWebsockets: false,
			},
			contextWithSecret(),
			{
				apiKey: `aaa.${claims}.bbb`,
				fetch: asFetch(async (_input, init) => {
					bodies.push(wireText(init?.body));
					return retryThenReject(bodies.length);
				}),
				onPayload: async payload => {
					hookCalls++;
					const raw = payload as Record<string, unknown>;
					expect(JSON.stringify(raw)).toContain(ORIGINAL_SECRET);
					await Promise.resolve();
					if (hookCalls === 1) return { ...raw, input: safeInput("safe-codex-1") };
					raw.input = safeInput(`safe-codex-${hookCalls}`);
					return undefined;
				},
			},
		).result();

		expect(result.stopReason).toBe("error");
		expect(hookCalls).toBe(2);
		expect(bodies).toHaveLength(2);
		expect((JSON.parse(bodies[0]!) as Record<string, unknown>).input).toEqual(safeInput("safe-codex-1"));
		expect((JSON.parse(bodies[1]!) as Record<string, unknown>).input).toEqual(safeInput("safe-codex-2"));
		expect(bodies.join("\n")).not.toContain(ORIGINAL_SECRET);
	});
});
