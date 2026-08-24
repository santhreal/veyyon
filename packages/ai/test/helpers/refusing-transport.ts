/**
 * Transports that answer, and refuse.
 *
 * The sibling helper (`silent-transport.ts`) covers an endpoint that says
 * nothing, which is a question about deadlines. This one covers an endpoint
 * that says no, which is a question about wording: a refusal is the one
 * provider failure an operator is expected to fix themselves, so the message
 * has to name the thing to fix. `401` means a credential, `429` means a wait,
 * `404` means the route or the model, `400` means the request. A provider that
 * renders all four as "request failed" has technically reported the failure and
 * told nobody anything.
 *
 * Every refusal here is dialect-agnostic: an HTTP status plus a body, with no
 * provider frames, so one harness covers SSE, JSON, protobuf and Connect.
 */
import * as http2 from "node:http2";
import type { CountingFetch } from "./silent-transport";

/** A fetch that answers one status, with one body, for every request. */
export function fetchThatRefuses(status: number, body: string, headers: Record<string, string> = {}): CountingFetch {
	const impl: CountingFetch = async () => {
		impl.calls += 1;
		return new Response(body, {
			status,
			// A refusal body is JSON on every dialect under test except the ones
			// that send none at all, and the content type is what a provider
			// reads before it decides whether to parse.
			headers: { "content-type": "application/json", ...headers },
		});
	};
	impl.calls = 0;
	return impl;
}

export interface RefusingHttp2Server {
	baseUrl: string;
	/** Streams the server accepted, so a probe can prove the transport was reached. */
	accepted: number;
	close(): Promise<void>;
}

/**
 * A loopback HTTP/2 server that refuses, for the transports that never touch
 * `fetch` (Cursor's Connect channel). Connect carries its status in the HTTP
 * status for a unary failure before the stream begins, which is the case a
 * refusal exercises.
 */
export function startRefusingHttp2Server(status: number, body: string): Promise<RefusingHttp2Server> {
	const server = http2.createServer();
	const sessions = new Set<http2.ServerHttp2Session>();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	const handle: RefusingHttp2Server = {
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
		stream.respond({ ":status": status, "content-type": "application/json" });
		stream.end(body);
	});
	const { promise, resolve } = Promise.withResolvers<RefusingHttp2Server>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		handle.baseUrl = `http://127.0.0.1:${port}`;
		resolve(handle);
	});
	return promise;
}
