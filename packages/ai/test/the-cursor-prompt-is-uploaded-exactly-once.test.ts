/**
 * The operator's instructions are uploaded to Cursor EXACTLY ONCE per request.
 *
 * WHY THIS SUITE EXISTS. This provider once put the same assembled prompt on three channels in
 * one request: the `rootPromptMessagesJson` head blobs, the `requestContext.rules` payload, and
 * the active user turn. Two of the three are discarded by the server, so the operator paid to
 * upload a 40KB instruction payload two extra times on every single turn, and — worse for a
 * harness — three copies of the instructions existed at once, any of which could drift from the
 * others after an edit and none of which was named as the authority.
 *
 * THE CONTRACT, both halves, enforced in `buildGrpcRequest` against the serialized bytes:
 *   DELIVERED — the instructions appear on the active user turn, the one field this server hands
 *   to the model verbatim.
 *   ONCE — they appear on no other channel. Count of copies across the run request plus every
 *   prompt-head blob it mints is exactly 1, or the build throws.
 *
 * WHAT IS PINNED. Every case here builds a REAL request through the provider's own builder and
 * counts copies in the bytes it produced, or drives the real `requestContextArgs` handler and
 * reads the frame it wrote. A case that asserted about a helper would not have caught the defect,
 * because each channel was individually correct.
 *
 * WHAT IT DOES NOT CATCH. It cannot see a copy Cursor's SERVER makes, and it says nothing about
 * other providers: `no-provider-uploads-the-prompt-twice.test.ts` sweeps those.
 */
import { describe, expect, it } from "bun:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { buildCursorSystemPromptJsons, buildGrpcRequest, handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, Context, ImageContent, Message, Model, TextContent } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	RequestContextArgsSchema,
	type RequestContextSuccess,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

/** Bytes that exist nowhere else, so every occurrence in a payload is one this request put there. */
const INSTRUCTION_MARKER = "OPERATOR-INSTRUCTION-BYTES-9f31";
const OPERATOR_PROMPT = `# Global Agent Configuration\n\nMarker: ${INSTRUCTION_MARKER}.\n${"Never delete a backlog row. ".repeat(200)}`;
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function cursorModel(): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "http://127.0.0.1:1",
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	}) as Model<"cursor-agent">;
}

function contextWith(messages: Message[], systemPrompt: string[] = [OPERATOR_PROMPT]): Context {
	return { systemPrompt, messages } as Context;
}

function userTurn(content: string | (TextContent | ImageContent)[]): Message {
	return { role: "user", content, timestamp: 0 } as Message;
}

function assistantTurn(content: string): Message {
	return { role: "assistant", content, timestamp: 1 } as unknown as Message;
}

interface BuiltRequest {
	bytes: Uint8Array;
	blobs: Map<string, Uint8Array>;
	/** Every occurrence of the marker in the request frame plus the head blobs it minted. */
	copies: number;
	/** The decoded text of the active user turn, or "" when the request resumes instead. */
	turnText: string;
}

async function buildOnce(
	context: Context,
	state?: { conversationId: string; blobStore: Map<string, Uint8Array> },
): Promise<BuiltRequest> {
	const blobStore = state?.blobStore ?? new Map<string, Uint8Array>();
	const built = await buildGrpcRequest(cursorModel(), context, undefined, {
		conversationId: state?.conversationId ?? "conv-1",
		blobStore,
	});
	// Counted over what the request ACTUALLY produced — the frame plus every blob it stored —
	// never over a recomputation of the head, which is how a re-added head copy stayed invisible.
	const decoder = new TextDecoder();
	let copies = occurrences(decoder.decode(built.requestBytes), INSTRUCTION_MARKER);
	for (const blob of blobStore.values()) copies += occurrences(decoder.decode(blob), INSTRUCTION_MARKER);
	return { bytes: built.requestBytes, blobs: blobStore, copies, turnText: decodeTurnText(built.requestBytes) };
}

function decodeTurnText(requestBytes: Uint8Array): string {
	const message = fromBinary(AgentClientMessageSchema, requestBytes);
	if (message.message.case !== "runRequest") throw new Error(`unexpected: ${message.message.case}`);
	const action = message.message.value.action?.action;
	if (action?.case !== "userMessageAction") return "";
	return action.value.userMessage?.text ?? "";
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		count += 1;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return count;
}

/** Drive the real `requestContextArgs` handler and return the rules it answered with. */
async function answeredRules(): Promise<{ rules: readonly { fullPath: string; content: string }[] }> {
	const frames: Buffer[] = [];
	const h2 = { write: (buf: Buffer) => frames.push(Buffer.from(buf)) } as never;
	const output = { role: "assistant", content: [], stopReason: "stop" } as unknown as AssistantMessage;
	const ask = create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				execId: "ctx-1",
				message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
			}),
		},
	});

	await handleServerMessage(
		ask,
		output,
		new AssistantMessageEventStream(),
		{} as never,
		new Map(),
		h2,
		undefined,
		undefined,
		[],
	);

	expect(frames).toHaveLength(1);
	const message = fromBinary(AgentClientMessageSchema, new Uint8Array(frames[0].subarray(5)));
	if (message.message.case !== "execClientMessage") throw new Error(`unexpected: ${message.message.case}`);
	const exec = message.message.value;
	if (exec.message.case !== "requestContextResult") throw new Error(`unexpected: ${exec.message.case}`);
	const result = exec.message.value.result;
	if (result.case !== "success") throw new Error(`requestContext failed: ${result.case}`);
	return { rules: (result.value as RequestContextSuccess).requestContext?.rules ?? [] };
}

describe("the Cursor prompt is uploaded exactly once", () => {
	it("puts exactly one copy of the instructions in a plain turn's request", async () => {
		const built = await buildOnce(contextWith([userTurn("what are my standing orders?")]));
		expect(built.copies).toBe(1);
	});

	it("puts that copy on the active user turn, ahead of the operator's own words", async () => {
		// Delivery, not merely absence of duplicates: a request with zero copies would satisfy a
		// count-only assertion and would run the model on Cursor's canned prompt.
		const built = await buildOnce(contextWith([userTurn("what are my standing orders?")]));
		expect(built.turnText).toContain(INSTRUCTION_MARKER);
		expect(built.turnText.indexOf("what are my standing orders?")).toBeGreaterThan(
			built.turnText.indexOf("</operator-instructions>"),
		);
	});

	it("answers the request-context ask with no rules at all", async () => {
		// The channel that used to carry the second copy. It is answered — the server asks and a
		// silent client stalls the turn — but it carries no instruction bytes.
		const { rules } = await answeredRules();
		expect(rules).toEqual([]);
	});

	it("mints a prompt-head blob that carries none of the instructions", async () => {
		// The channel that used to carry the third copy. The head must still exist, and must be
		// the placeholder rather than the operator's file.
		const jsons = buildCursorSystemPromptJsons();
		expect(jsons).toHaveLength(1);
		expect(jsons[0]).not.toContain(INSTRUCTION_MARKER);
		expect(JSON.parse(jsons[0])).toEqual({ role: "system", content: "You are a helpful assistant." });
	});

	it("keeps it at one copy when the turn carries an image", async () => {
		const built = await buildOnce(
			contextWith([
				userTurn([
					{ type: "text", text: "what are my standing orders?" },
					{ type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" },
				]),
			]),
		);
		expect(built.copies).toBe(1);
		expect(built.turnText).toContain(INSTRUCTION_MARKER);
	});

	it("keeps it at one copy on the second turn of the same conversation", async () => {
		// The accumulating failure mode: history is uploaded too, so a preamble written into the
		// stored message would be re-sent once more per turn, forever.
		const state = { conversationId: "conv-multi", blobStore: new Map<string, Uint8Array>() };
		await buildOnce(contextWith([userTurn("first")]), state);
		const second = await buildOnce(contextWith([userTurn("first"), assistantTurn("ok"), userTurn("second")]), state);
		expect(second.copies).toBe(1);
	});

	it("leaves the stored history free of the preamble", async () => {
		// The preamble belongs to the request, not to the conversation. A copy that lands in a
		// history blob is both a duplicate upload and a second authority for the instructions.
		const state = { conversationId: "conv-history", blobStore: new Map<string, Uint8Array>() };
		await buildOnce(contextWith([userTurn("first")]), state);
		await buildOnce(contextWith([userTurn("first"), assistantTurn("ok"), userTurn("second")]), state);

		const decoder = new TextDecoder();
		const inBlobs = [...state.blobStore.values()].reduce(
			(sum, blob) => sum + occurrences(decoder.decode(blob), INSTRUCTION_MARKER),
			0,
		);
		expect(inBlobs).toBe(0);
	});

	it("spends prompt-sized bytes on the prompt, not a multiple of them", async () => {
		// Byte accounting, because a count of a marker cannot see a near-copy. Two channels
		// carrying the payload put it over 2x; one channel leaves it just above 1x.
		const built = await buildOnce(contextWith([userTurn("hi")]));
		const promptBytes = Buffer.byteLength(OPERATOR_PROMPT, "utf8");
		expect(built.bytes.length).toBeGreaterThan(promptBytes);
		expect(built.bytes.length).toBeLessThan(promptBytes * 1.5);
	});

	it("uploads nothing extra when a turn resumes instead of sending a message", async () => {
		// A resume action has no user turn to carry instructions, and must not silently grow a
		// copy on another channel to compensate.
		const built = await buildOnce(contextWith([assistantTurn("still working")]));
		expect(built.turnText).toBe("");
		expect(built.copies).toBe(0);
	});

	it("refuses to send a request that carries a second copy", async () => {
		// The invariant itself, exercised through the payload hook a host uses to rewrite the
		// request: duplicating the user turn's text is exactly the shape of every regression this
		// suite exists for, and the build must throw rather than upload it.
		const context = contextWith([userTurn("what are my standing orders?")]);
		await expect(
			buildGrpcRequest(
				cursorModel(),
				context,
				{ onPayload: duplicateUserText },
				{
					conversationId: "conv-dup",
					blobStore: new Map<string, Uint8Array>(),
				},
			),
		).rejects.toThrow(/carries the caller's instructions 2 times/);
	});

	it("refuses to send a request that carries none", async () => {
		// The other half. Dropping the preamble is a silent success on the wire, and was.
		const context = contextWith([userTurn("what are my standing orders?")]);
		await expect(
			buildGrpcRequest(
				cursorModel(),
				context,
				{ onPayload: stripUserText },
				{
					conversationId: "conv-none",
					blobStore: new Map<string, Uint8Array>(),
				},
			),
		).rejects.toThrow(/carries none of the caller's instructions/);
	});

	it("sends nothing extra, and throws nothing, when the caller has no instructions", async () => {
		const built = await buildOnce(contextWith([userTurn("hello")], []));
		expect(built.copies).toBe(0);
		expect(built.turnText).toBe("hello");
	});
});

/** Rewrite the payload so the user turn's text appears twice, the way a duplicating bug would. */
function duplicateUserText(payload: unknown): unknown {
	return rewriteUserText(payload, text => `${text}\n${text}`);
}

/** Rewrite the payload so the user turn carries only the operator's question. */
function stripUserText(payload: unknown): unknown {
	return rewriteUserText(payload, text => text.slice(text.indexOf("</operator-instructions>") + 25));
}

function rewriteUserText(payload: unknown, rewrite: (text: string) => string): unknown {
	const root = payload as {
		action?: { userMessageAction?: { userMessage?: { text?: string; richText?: string } } };
	};
	const message = root.action?.userMessageAction?.userMessage;
	if (message?.text) message.text = rewrite(message.text);
	return payload;
}
