/**
 * Transports that answer, and then stop mid-sentence.
 *
 * The two siblings cover the other ways a request can fail:
 * `silent-transport.ts` is an endpoint that never answers, which is a question
 * about deadlines, and `refusing-transport.ts` is an endpoint that says no,
 * which is a question about wording. This one is the case in between and the
 * hardest to see: the endpoint accepted the request, answered `200`, and then
 * closed the body without ever emitting the marker its dialect ends a turn
 * with. A proxy that drops a connection, a gateway that times out upstream and
 * closes, and a compatible server that simply does not send `[DONE]` all arrive
 * here identically.
 *
 * The bytes are dialect-agnostic on purpose. A hand-written per-dialect body is
 * a fixture the author invented, and a sweep built on fourteen of those proves
 * what the author believes each wire format looks like. Zero bytes and an SSE
 * comment frame are true of every dialect under test — neither carries a turn,
 * both are followed by EOF — so what the sweep observes is the decoder's own
 * end-of-stream decision rather than the author's idea of a frame.
 */
import * as http2 from "node:http2";
import type { CountingFetch } from "./silent-transport";

/**
 * A fetch that answers `200`, writes `body`, and closes.
 *
 * The body is written as one chunk and the stream is then closed, so the
 * provider's reader sees a clean EOF rather than a socket error: the whole
 * point is that nothing went wrong at the transport layer, which is what makes
 * this failure easy to mistake for a finished turn.
 */
export function fetchThatEndsEarly(body: string, contentType = "text/event-stream"): CountingFetch {
	const impl: CountingFetch = async () => {
		impl.calls += 1;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (body.length > 0) controller.enqueue(new TextEncoder().encode(body));
				controller.close();
			},
		});
		return new Response(stream, { status: 200, headers: { "content-type": contentType } });
	};
	impl.calls = 0;
	return impl;
}

export interface TruncatingHttp2Server {
	baseUrl: string;
	/** Streams the server accepted, so a probe can prove the transport was reached. */
	accepted: number;
	close(): Promise<void>;
}

/**
 * A loopback HTTP/2 server that answers `200` and ends the stream, for the
 * transports that never touch `fetch` (Cursor's Connect channel). Ending an
 * h2 stream after a successful response header is the same anomaly as closing
 * a body: the framing layer is happy and the dialect never said the turn was
 * over.
 */
export function startTruncatingHttp2Server(body: string): Promise<TruncatingHttp2Server> {
	const server = http2.createServer();
	const sessions = new Set<http2.ServerHttp2Session>();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	const handle: TruncatingHttp2Server = {
		baseUrl: "",
		accepted: 0,
		close: async () => {
			for (const session of sessions) session.destroy();
			sessions.clear();
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
	};
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		handle.accepted += 1;
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.end(body);
	});
	const { promise, resolve } = Promise.withResolvers<TruncatingHttp2Server>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		handle.baseUrl = `http://127.0.0.1:${port}`;
		resolve(handle);
	});
	return promise;
}
