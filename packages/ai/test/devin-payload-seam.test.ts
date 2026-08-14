import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { Context, Message, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import {
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { StopReason } from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

const ORIGINAL_SYSTEM = "original-system-secret";
const ORIGINAL_USER = "original-user-secret";
const ORIGINAL_TOOL = "original-tool-secret";
const MUTATED_SYSTEM = "mutated-system-intermediate";
const MUTATED_USER = "mutated-user-intermediate";
const MUTATED_TOOL = "mutated-tool-intermediate";
const REPLACEMENT_SYSTEM = "safe-system-replacement";
const REPLACEMENT_USER = "safe-user-replacement";
const REPLACEMENT_TOOL = "safe-tool-replacement";
const RESOLVED_API_KEY = "resolved-devin-credential";
const RESOLVED_USER_JWT = "resolved-user-jwt";

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-payload-seam",
	name: "Devin Payload Seam",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_384,
	maxTokens: 1_024,
});

const context: Context = {
	systemPrompt: [ORIGINAL_SYSTEM],
	messages: [{ role: "user", content: ORIGINAL_USER, timestamp: 1 }],
	tools: [
		{
			name: "search",
			description: ORIGINAL_TOOL,
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		},
	],
};

function bodyBytes(body: RequestInit["body"] | undefined): Uint8Array {
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	throw new Error(`unexpected Devin request body: ${Object.prototype.toString.call(body)}`);
}

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const frame = new Uint8Array(5 + payload.length);
	const view = new DataView(frame.buffer);
	view.setUint32(1, payload.length, false);
	frame.set(payload, 5);
	return frame;
}

function successfulChatResponse(): Response {
	const response = create(GetChatMessageResponseSchema, { stopReason: StopReason.STOP_PATTERN });
	return new Response(frameConnectMessage(toBinary(GetChatMessageResponseSchema, response)));
}

/**
 * The shape `onPayload` receives: canonical proto3 JSON, not a protobuf
 * message. Only the fields these tests read are named.
 */
interface DevinPayloadJson {
	prompt?: string;
	chatModelUid?: string;
	chatMessagePrompts?: { prompt?: string }[];
	tools?: { description?: string }[];
	metadata?: { apiKey?: string; userJwt?: string; requestId?: unknown };
}

/**
 * WHY this seam hands over JSON rather than the protobuf message it used to.
 *
 * `onPayload` is the last hook before the wire, and veyyon installs the secret
 * redactor there. That redactor walks the payload rewriting every string and
 * REFUSES any value JSON cannot express. A protobuf message is not that shape:
 * `metadata.requestId` is a uint64 and therefore a bigint, and bytes fields are
 * Uint8Array. Handing the message over made every Devin request fail with
 * "the provider request contains a non-JSON value/object; confidentiality
 * transform failed." for any operator with secrets configured -- the provider
 * was unusable, not degraded.
 *
 * These tests therefore pin the JSON contract deliberately; the earlier
 * protobuf-shaped assertions described the defect. What they do NOT catch: a
 * sibling provider (Bedrock's ConverseStreamRequest, Cursor's AgentRunRequest)
 * committing the same mistake at its own seam.
 */
describe("streamDevin onPayload transport seam", () => {
	it("serializes and gzips only the awaited replacement while preserving resolved auth", async () => {
		const authResponse = toBinary(
			GetUserJwtResponseSchema,
			create(GetUserJwtResponseSchema, { userJwt: RESOLVED_USER_JWT }),
		);
		let capturedFrame: Uint8Array | undefined;
		let capturedAuthRequest: Uint8Array | undefined;
		const physicalPaths: string[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			physicalPaths.push(url);
			if (url.includes("GetUserJwt")) {
				capturedAuthRequest = Uint8Array.from(bodyBytes(init?.body));
				return new Response(authResponse);
			}
			capturedFrame = Uint8Array.from(bodyBytes(init?.body));
			return successfulChatResponse();
		}) as typeof fetch;
		let hookCalls = 0;
		let hookModel: Model | undefined;

		const result = await streamDevin(devinModel, context, {
			apiKey: RESOLVED_API_KEY,
			conversationId: "payload-seam-conversation",
			fetch: fetchImpl,
			onPayload: async (payload, model) => {
				hookCalls++;
				hookModel = model;
				const request = payload as DevinPayloadJson;
				expect(request.prompt).toBe(ORIGINAL_SYSTEM);
				expect(request.chatMessagePrompts?.[0]?.prompt).toBe(ORIGINAL_USER);
				expect(request.tools?.[0]?.description).toBe(ORIGINAL_TOOL);
				// Mutating the handed object must not reach the wire: only the
				// awaited return value does.
				request.prompt = MUTATED_SYSTEM;
				const mutatedPrompt = request.chatMessagePrompts?.[0];
				if (mutatedPrompt) mutatedPrompt.prompt = MUTATED_USER;
				const mutatedTool = request.tools?.[0];
				if (mutatedTool) mutatedTool.description = MUTATED_TOOL;
				const metadata = request.metadata;
				if (metadata) {
					metadata.apiKey = "mutated-api-key";
					metadata.userJwt = "mutated-user-jwt";
				}
				await Promise.resolve();
				return {
					...request,
					prompt: REPLACEMENT_SYSTEM,
					chatMessagePrompts: (request.chatMessagePrompts ?? []).map(prompt => ({
						...prompt,
						prompt: REPLACEMENT_USER,
					})),
					tools: (request.tools ?? []).map(tool => ({ ...tool, description: REPLACEMENT_TOOL })),
				};
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(hookCalls).toBe(1);
		expect(hookModel).toBe(devinModel);
		expect(physicalPaths).toHaveLength(2);
		if (!capturedFrame) throw new Error("Devin chat request was not dispatched");
		const frame = Buffer.from(capturedFrame);
		expect(frame[0]).toBe(1);
		const compressedLength = frame.readUInt32BE(1);
		expect(compressedLength).toBe(frame.length - 5);
		const protobufBytes = gunzipSync(frame.subarray(5));
		for (const absent of [
			ORIGINAL_SYSTEM,
			ORIGINAL_USER,
			ORIGINAL_TOOL,
			MUTATED_SYSTEM,
			MUTATED_USER,
			MUTATED_TOOL,
			"mutated-api-key",
			"mutated-user-jwt",
		]) {
			expect(protobufBytes.includes(Buffer.from(absent))).toBe(false);
		}
		for (const present of [REPLACEMENT_SYSTEM, REPLACEMENT_USER, REPLACEMENT_TOOL]) {
			expect(protobufBytes.includes(Buffer.from(present))).toBe(true);
		}
		const request = fromBinary(GetChatMessageRequestSchema, protobufBytes);
		expect(request.prompt).toBe(REPLACEMENT_SYSTEM);
		expect(request.chatMessagePrompts[0]?.prompt).toBe(REPLACEMENT_USER);
		expect(request.tools[0]?.description).toBe(REPLACEMENT_TOOL);
		if (!capturedAuthRequest) throw new Error("Devin auth request was not dispatched");
		const authRequest = fromBinary(GetUserJwtRequestSchema, capturedAuthRequest);
		expect(request.metadata?.apiKey === authRequest.metadata?.apiKey).toBe(true);
		expect(request.metadata?.userJwt === RESOLVED_USER_JWT).toBe(true);
	});

	it("does not dispatch the chat request when the awaited hook rejects", async () => {
		const authResponse = toBinary(
			GetUserJwtResponseSchema,
			create(GetUserJwtResponseSchema, { userJwt: RESOLVED_USER_JWT }),
		);
		let chatDispatches = 0;
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) return new Response(authResponse);
			chatDispatches++;
			return successfulChatResponse();
		}) as typeof fetch;

		const result = await streamDevin(devinModel, context, {
			apiKey: RESOLVED_API_KEY,
			fetch: fetchImpl,
			onPayload: async () => {
				await Promise.resolve();
				throw new Error("Devin payload hook rejected");
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin payload hook rejected");
		expect(chatDispatches).toBe(0);
	});

	/**
	 * The invariant, checked at the choke point rather than per field: EVERY
	 * node handed to `onPayload` must be expressible in JSON. This is what the
	 * secret redactor requires, so a new protobuf field that is a bigint, a
	 * Uint8Array, a Date or a class instance turns this red the day it is added
	 * -- which is the failure mode that shipped.
	 */
	it("hands the payload hook a payload JSON can express, every node of it", async () => {
		const authResponse = toBinary(
			GetUserJwtResponseSchema,
			create(GetUserJwtResponseSchema, { userJwt: RESOLVED_USER_JWT }),
		);
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) return new Response(authResponse);
			return successfulChatResponse();
		}) as typeof fetch;

		const imageMessage: Message = {
			role: "user",
			timestamp: 1,
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
		};
		const imageContext: Context = { ...context, messages: [...context.messages, imageMessage] };

		let captured: unknown;
		const offenders: string[] = [];
		const seen = new WeakSet<object>();
		const walk = (value: unknown, path: string): void => {
			if (value === null) return;
			const kind = typeof value;
			if (kind === "string" || kind === "number" || kind === "boolean") return;
			if (kind !== "object") {
				offenders.push(`${path || "<root>"}: ${kind}`);
				return;
			}
			const node = value as object;
			if (seen.has(node)) return;
			seen.add(node);
			if (Array.isArray(node)) {
				node.forEach((entry, index) => {
					walk(entry, `${path}[${index}]`);
				});
				return;
			}
			const prototype = Object.getPrototypeOf(node);
			if (prototype !== Object.prototype && prototype !== null) {
				const name = prototype?.constructor?.name ?? "<null prototype>";
				offenders.push(`${path || "<root>"}: ${name}`);
				return;
			}
			for (const [key, entry] of Object.entries(node)) walk(entry, path ? `${path}.${key}` : key);
		};

		const result = await streamDevin(devinModel, imageContext, {
			apiKey: RESOLVED_API_KEY,
			fetch: fetchImpl,
			onPayload: payload => {
				captured = payload;
				return undefined;
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		walk(captured, "");
		// Exact equality, never a count: one tolerated node is how the next one
		// slips in behind it.
		expect(offenders).toEqual([]);
		// The redactor serializes what it walked; a value JSON drops silently is
		// the same defect wearing a different hat.
		expect(JSON.parse(JSON.stringify(captured))).toEqual(captured as object);
	});
});
