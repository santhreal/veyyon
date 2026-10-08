/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * The Devin request asks Cascade for gzip (`connect-accept-encoding: gzip`), so a Connect frame in
 * the response may carry the compressed flag, and that holds for message frames and for the
 * end-stream trailer alike. Every other Devin suite writes uncompressed frames, so a reader that
 * stopped gunzipping, or gunzipped only one kind of frame, passed all of them and broke every turn
 * against the server. The class this closes is "a frame reads differently because it was
 * compressed": each script below is delivered plain, fully compressed, and with alternate frames
 * compressed, and every delivery must produce the same events and the same final message.
 *
 * WHAT IT DOES NOT CATCH: a compression codec other than gzip, which the request never accepts.
 */
import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@veyyon/ai/types";
import { CONNECT_COMPRESSED_FLAG, CONNECT_END_STREAM_FLAG, frameConnectMessage } from "@veyyon/ai/utils/connect-frames";
import { buildModel } from "@veyyon/catalog/build";
import { GetChatMessageResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { StopReason } from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

/** One frame before framing: its payload and whether it is the end-stream trailer. */
interface ScriptFrame {
	payload: Uint8Array;
	endStream: boolean;
}

function text(deltaText: string, stopReason = StopReason.UNSPECIFIED): ScriptFrame {
	const message = create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason, deltaText });
	return { payload: toBinary(GetChatMessageResponseSchema, message), endStream: false };
}

function trailer(body: unknown): ScriptFrame {
	return { payload: new TextEncoder().encode(JSON.stringify(body)), endStream: true };
}

/** Each script's frames, and the stop reason and text the plain delivery ends with. */
const SCRIPTS: Record<string, { frames: ScriptFrame[]; stopReason: AssistantMessage["stopReason"]; text: string }> = {
	"a finished answer": {
		frames: [text("hello "), text("world", StopReason.STOP_PATTERN), trailer({})],
		stopReason: "stop",
		text: "hello world",
	},
	"an answer that ends with no trailer": {
		frames: [text("only "), text("text", StopReason.STOP_PATTERN)],
		stopReason: "stop",
		text: "only text",
	},
	"a failure after a token": {
		frames: [text("partial"), trailer({ error: { code: "invalid_argument", message: "bad turn" } })],
		stopReason: "error",
		text: "partial",
	},
	"a failure before any token": {
		frames: [trailer({ error: { code: "invalid_argument", message: "bad request" } })],
		stopReason: "error",
		text: "",
	},
};

type Compression = (index: number) => boolean;
const COMPRESSIONS: Record<string, Compression> = {
	plain: () => false,
	compressed: () => true,
	alternate: index => index % 2 === 1,
};

function frame(script: ScriptFrame[], compress: Compression): Uint8Array[] {
	return script.map((entry, index) => {
		const compressed = compress(index);
		const flags = (entry.endStream ? CONNECT_END_STREAM_FLAG : 0) | (compressed ? CONNECT_COMPRESSED_FLAG : 0);
		return frameConnectMessage(compressed ? gzipSync(entry.payload) : entry.payload, flags);
	});
}

async function run(frames: Uint8Array[]): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	const fetchImpl = (async (input: string | URL | Request) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		let index = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					const next = frames[index++];
					if (next) controller.enqueue(next);
					else controller.close();
				},
			}),
		);
	}) as typeof fetch;
	const stream = streamDevin(
		devinModel,
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ apiKey: "token", fetch: fetchImpl },
	);
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}

/** What a consumer reads from a turn, without the timings that differ between two runs. */
function observed({ events, result }: { events: AssistantMessageEvent[]; result: AssistantMessage }) {
	return {
		events: events.map(event => (event.type === "text_delta" ? `text_delta:${event.delta}` : event.type)),
		content: result.content,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
	};
}

describe("a Devin stream reads alike whether or not its frames are compressed", () => {
	for (const [name, script] of Object.entries(SCRIPTS)) {
		it(`delivers ${name} the same under every compression`, async () => {
			const plain = observed(await run(frame(script.frames, COMPRESSIONS.plain)));
			const plainText = plain.content.map(block => (block.type === "text" ? block.text : "")).join("");
			expect({ stopReason: plain.stopReason, text: plainText }).toEqual({
				stopReason: script.stopReason,
				text: script.text,
			});
			for (const [label, compress] of Object.entries(COMPRESSIONS)) {
				expect({ label, ...observed(await run(frame(script.frames, compress))) }).toEqual({ label, ...plain });
			}
		});
	}
});
