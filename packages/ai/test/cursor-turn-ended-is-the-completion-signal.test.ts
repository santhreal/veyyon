import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ConversationTokenDetailsSchema,
	InteractionUpdateSchema,
	TokenDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

// WHY THIS SUITE EXISTS
// ---------------------
// `turn_ended` is the only thing Cursor sends that means the turn is over. The
// HTTP/2 stream also ends when the connection merely stops, and the provider
// used to treat the two as the same event: `stopReason` was initialised to
// "stop" and nothing on the success path ever revisited it, so a turn cut off
// mid-reply was persisted looking exactly like a finished one. The compaction
// anchor skips only "aborted" and "error" turns, so it then trusted the partial
// token counts of a turn that never completed.
//
// The same suite drives the accounting fold end to end, because the two are one
// question: what the turn is worth is only meaningful once you know the turn
// happened. `used_tokens` is the whole conversation measured with this turn's
// reply already in it, so the prompt side is the gauge minus the completion.

function frame(payload: Uint8Array): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
}

function tokenDeltaFrame(tokens: number): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens }) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

function checkpointFrame(usedTokens: number, maxTokens: number): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "conversationCheckpointUpdate",
			value: create(ConversationStateStructureSchema, {
				tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens, maxTokens }),
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
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
	return frame(toBinary(AgentServerMessageSchema, message));
}

interface FakeCursorServer {
	baseUrl: string;
	close: () => Promise<void>;
}

/** A localhost h2c server that replays a fixed frame script and then ends. */
function startH2Server(script: Buffer[]): Promise<FakeCursorServer> {
	const server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		for (const chunk of script) stream.write(chunk);
		stream.end();
	});
	const { promise, resolve } = Promise.withResolvers<FakeCursorServer>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const closed = () => {
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			return done.promise;
		};
		resolve({ baseUrl: `http://127.0.0.1:${port}`, close: closed });
	});
	return promise;
}

const cursorModel = (baseUrl: string): Model<"cursor-agent"> =>
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		// Real rates: a Cursor row backed by a bundled reference inherits them.
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

interface TurnResult {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}

async function runTurn(baseUrl: string): Promise<TurnResult> {
	const events: AssistantMessageEvent[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of streamCursor(cursorModel(baseUrl), context, { apiKey: "test-token" })) {
		events.push(event);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("stream produced no terminal event");
	return { events, message };
}

let srv: FakeCursorServer | undefined;

beforeEach(() => {
	srv = undefined;
});

afterEach(async () => {
	await srv?.close();
});

describe("cursor turn completion", () => {
	it("reports a turn the server never ended as an incomplete stream, not a clean stop", async () => {
		srv = await startH2Server([tokenDeltaFrame(120)]);

		const { message } = await runTurn(srv.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("turn_ended");
	});

	it("reports a turn the server ended as a clean stop", async () => {
		srv = await startH2Server([tokenDeltaFrame(120), turnEndedFrame()]);

		const { message } = await runTurn(srv.baseUrl);

		expect(message.stopReason).toBe("stop");
	});

	it("bills the completion once and reports the conversation gauge as the total", async () => {
		// The gauge lands before the last deltas on purpose: whichever order the
		// server uses, the numbers must still describe one conversation.
		srv = await startH2Server([
			tokenDeltaFrame(100),
			checkpointFrame(50_000, 256_000),
			tokenDeltaFrame(400),
			turnEndedFrame(),
		]);

		const { message } = await runTurn(srv.baseUrl);

		expect(message.usage.output).toBe(500);
		expect(message.usage.input).toBe(49_500);
		expect(message.usage.totalTokens).toBe(50_000);
		// Cursor states the window per turn; it outranks the catalog's 200k guess.
		expect(message.providerContextWindow).toBe(256_000);
		expect(message.usage.cost.total).toBeCloseTo((49_500 * 3 + 500 * 15) / 1_000_000, 9);
	});

	it("still reports what an unfinished turn spent", async () => {
		srv = await startH2Server([tokenDeltaFrame(2_000), checkpointFrame(50_000, 256_000)]);

		const { message } = await runTurn(srv.baseUrl);

		expect(message.stopReason).toBe("error");
		expect(message.usage.output).toBe(2_000);
		expect(message.usage.cost.total).toBeGreaterThan(0);
	});
});
