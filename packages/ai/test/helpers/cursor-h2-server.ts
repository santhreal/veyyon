/**
 * A loopback HTTP/2 server that answers Cursor's `Run` request in Connect framing, for suites that
 * drive the real `streamCursor` end to end.
 *
 * The server decodes the client's frames, so a suite can read the request a turn sent and answer
 * the replies the client writes back (a KV result, an exec result). Each accepted stream is handed
 * to an `answer` function once its `runRequest` has arrived; the answer responds, writes frames and
 * ends the stream. Client heartbeats are dropped before the answer sees anything.
 */
import * as http2 from "node:http2";
import { create, fromBinary, type MessageInitShape, toBinary } from "@bufbuild/protobuf";
import { type CursorOptions, streamCursor } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@veyyon/ai/types";
import { CONNECT_END_STREAM_FLAG, ConnectFrameReader, frameConnectMessage } from "@veyyon/ai/utils/connect-frames";
import { buildModel } from "@veyyon/catalog/build";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentServerMessageSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

/** One server message, written as the `AgentServerMessage` init shape. */
export function serverFrame(message: MessageInitShape<typeof AgentServerMessageSchema>): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)));
}

export function turnEndedFrame(): Buffer {
	return serverFrame({ message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } } });
}

export function textDeltaFrame(text: string): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "textDelta", value: { text } } } },
	});
}

/** The Connect end-of-stream frame: JSON trailers, carrying `error` when the stream failed. */
export function endStreamFrame(error?: { code: string; message: string }): Buffer {
	return frameConnectMessage(Buffer.from(JSON.stringify(error ? { error } : {})), CONNECT_END_STREAM_FLAG);
}

/**
 * Responds with Connect's success status; `trailers` are sent when the stream ends. The `date` header is fixed:
 * without one, `node:http2` arms a timer that expires its cached `Date` value, and a suite counting the timers a
 * turn leaves under a fake clock counts that server timer as the client's.
 */
export function respondConnect(stream: http2.ServerHttp2Stream, trailers?: http2.OutgoingHttpHeaders): void {
	stream.respond(
		{ ":status": 200, "content-type": "application/connect+proto", date: "Thu, 01 Jan 2026 00:00:00 GMT" },
		{ waitForTrailers: !!trailers },
	);
	if (trailers) stream.on("wantTrailers", () => stream.sendTrailers(trailers));
}

export interface CursorExchange {
	/** The `runRequest` the client opened the stream with. */
	request: AgentRunRequest;
	stream: http2.ServerHttp2Stream;
	/** The next message the client wrote after its run request, heartbeats excluded. */
	nextClientMessage(): Promise<AgentClientMessage>;
}

export interface CursorH2Server {
	baseUrl: string;
	/** Streams the server accepted, so a suite can prove whether the transport was reached. */
	readonly accepted: number;
	/** Settles once every session the server accepted has closed. */
	sessionsClosed(): Promise<void>;
	close(): Promise<void>;
}

class ClientMessages {
	readonly #queued: AgentClientMessage[] = [];
	readonly #waiting: PromiseWithResolvers<AgentClientMessage>[] = [];

	put(message: AgentClientMessage): void {
		const waiter = this.#waiting.shift();
		if (waiter) waiter.resolve(message);
		else this.#queued.push(message);
	}

	take(): Promise<AgentClientMessage> {
		const queued = this.#queued.shift();
		if (queued) return Promise.resolve(queued);
		const waiter = Promise.withResolvers<AgentClientMessage>();
		this.#waiting.push(waiter);
		return waiter.promise;
	}
}

export function startCursorH2Server(
	answer: (exchange: CursorExchange) => void | Promise<void>,
): Promise<CursorH2Server> {
	const server = http2.createServer();
	const sessions = new Set<http2.ServerHttp2Session>();
	const sessionCloses: Promise<void>[] = [];
	let accepted = 0;
	server.on("session", session => {
		const closed = Promise.withResolvers<void>();
		sessionCloses.push(closed.promise);
		sessions.add(session);
		session.on("error", () => {});
		session.on("close", () => {
			sessions.delete(session);
			closed.resolve();
		});
	});
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		accepted += 1;
		stream.on("error", () => {});
		const reader = new ConnectFrameReader();
		const messages = new ClientMessages();
		let answered = false;
		stream.on("data", (chunk: Buffer) => {
			reader.push(chunk);
			for (let read = reader.next(); read?.kind === "frame"; read = reader.next()) {
				const message = fromBinary(AgentClientMessageSchema, read.payload);
				if (message.message.case === "clientHeartbeat") continue;
				if (!answered && message.message.case === "runRequest") {
					answered = true;
					const exchange = { request: message.message.value, stream, nextClientMessage: () => messages.take() };
					Promise.resolve(answer(exchange)).catch(error => stream.destroy(error));
					continue;
				}
				messages.put(message);
			}
		});
	});
	const { promise, resolve } = Promise.withResolvers<CursorH2Server>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		resolve({
			baseUrl: `http://127.0.0.1:${port}`,
			get accepted() {
				return accepted;
			},
			sessionsClosed: async () => {
				await Promise.all(sessionCloses);
			},
			close: () => {
				for (const session of sessions) session.destroy();
				const done = Promise.withResolvers<void>();
				server.close(() => done.resolve());
				return done.promise;
			},
		});
	});
	return promise;
}

export function cursorTestModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

export interface CursorTurnResult {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}

const helloContext: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** Runs one `streamCursor` turn to its terminal event. */
export async function runCursorTurn(
	baseUrl: string,
	options: CursorOptions = { apiKey: "test-token" },
	context: Context = helloContext,
): Promise<CursorTurnResult> {
	const events: AssistantMessageEvent[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of streamCursor(cursorTestModel(baseUrl), context, options)) {
		events.push(event);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("the Cursor stream ended with no terminal event");
	return { events, message };
}
