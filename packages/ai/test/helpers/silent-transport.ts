/**
 * Transports that accept a request and then say nothing.
 *
 * A provider fails two different ways when an endpoint goes quiet, and the two
 * are guarded by different machinery:
 *
 *  - **No headers.** The socket is accepted and the response never begins. Only
 *    a pre-response deadline (`armPreResponseTimeout`, or a provider's own
 *    scoped signal) can end this; the iterator watchdog has nothing to watch
 *    because no stream object exists yet.
 *  - **Headers, then nothing.** The response begins, so every pre-response
 *    fence is cleared by design, and the body stays open forever. Only an
 *    iterator-level first-event/idle watchdog can end this.
 *
 * Both are dialect-agnostic on purpose: neither writes a single provider frame,
 * so one harness covers SSE, JSON, protobuf and Connect transports without
 * knowing anything about their wire formats.
 *
 * Every transport here honors `AbortSignal`, because a real one does. A stub
 * that ignored the signal would report a provider as hanging when the provider
 * had in fact aborted correctly.
 */
import * as http2 from "node:http2";
import type { FetchImpl } from "../../src/types";

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	// `fetch` surfaces a bare abort as a DOMException named AbortError. The name
	// is what every provider classifier reads, so an Error carrying it is
	// indistinguishable to the code under test and needs no cast.
	const aborted = new Error("This operation was aborted");
	aborted.name = "AbortError";
	return aborted;
}

/** Resolve/reject when `signal` aborts, mirroring how `fetch` surfaces an abort. */
function rejectOnAbort(signal: AbortSignal | null | undefined, reject: (error: Error) => void): void {
	if (!signal) return;
	if (signal.aborted) {
		reject(abortReason(signal));
		return;
	}
	signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
}

/** A {@link FetchImpl} that records how many requests reached it. */
export interface CountingFetch extends FetchImpl {
	calls: number;
}

/** A fetch that accepts the request and never produces a response. */
export function fetchThatNeverAnswers(): CountingFetch {
	const impl: CountingFetch = async (_input, init) => {
		impl.calls += 1;
		const { promise, reject } = Promise.withResolvers<Response>();
		rejectOnAbort(init?.signal, reject);
		return promise;
	};
	impl.calls = 0;
	return impl;
}

/**
 * A fetch that answers `200` with an open body it never writes to. Headers are
 * real, so a pre-response fence is cleared and only an iterator-level watchdog
 * remains.
 */
export function fetchThatStallsMidStream(contentType = "text/event-stream"): CountingFetch {
	const impl: CountingFetch = async (_input, init) => {
		impl.calls += 1;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				rejectOnAbort(init?.signal, error => {
					controller.error(error);
				});
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": contentType } });
	};
	impl.calls = 0;
	return impl;
}

export interface SilentHttp2Server {
	baseUrl: string;
	/** Streams the server accepted, so a probe can prove the transport was reached. */
	accepted: number;
	close(): Promise<void>;
}

/**
 * A loopback HTTP/2 server for the transports that never touch `fetch`
 * (Cursor's Connect channel). `respond: false` accepts the stream and answers
 * nothing; `respond: true` sends headers and then writes no frames.
 */
export function startSilentHttp2Server(options: { respond: boolean }): Promise<SilentHttp2Server> {
	const server = http2.createServer();
	// A stalled stream holds its session open, and `close()` waits for every
	// session to end, so the sessions are tracked and destroyed by hand. There is
	// no `closeAllConnections` on an Http2Server.
	const sessions = new Set<http2.ServerHttp2Session>();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	const handle: SilentHttp2Server = {
		baseUrl: "",
		accepted: 0,
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			for (const session of sessions) session.destroy();
			return closed.promise;
		},
	};
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		handle.accepted += 1;
		if (options.respond) stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.on("error", () => {});
	});
	const { promise, resolve, reject } = Promise.withResolvers<SilentHttp2Server>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (address === null || typeof address === "string") {
			reject(new Error(`the silent HTTP/2 server bound no TCP port (address: ${String(address)})`));
			return;
		}
		handle.baseUrl = `http://127.0.0.1:${address.port}`;
		resolve(handle);
	});
	return promise;
}
