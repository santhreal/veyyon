import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import type { Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

// WHY THIS SUITE EXISTS
// ---------------------
// The run's AbortSignal is SHARED across every LLM round: agent-loop passes the
// same signal object to model.stream() on every round of a run (when
// harmony/owned-dialect are off). cursor.streamCursor attaches an "abort"
// listener to that signal so it can close the in-flight HTTP/2 stream. The bug
// this suite locks out (BACKLOG HUNT2-resleak-cursor-abort-listener) is that the
// listener used to be attached with NO { once:true } and NO matching
// removeEventListener, so every round added a fresh never-removed listener whose
// closure pinned that round's h2 stream/client. Over a long autonomous run
// (hundreds of rounds on one signal) listeners accumulated unboundedly, retaining
// every completed round's HTTP/2 resources until the whole run signal was GC'd,
// and EVERY accumulated listener fired (closing already-closed streams) on the
// final abort.
//
// The fix: attach with { once:true }, detach in the finally on every exit path,
// and — when the signal is already aborted before attach — run the handler once
// synchronously WITHOUT adding a listener. This test drives the REAL streamCursor
// against a localhost h2c server (no transport mock) so the true attach/detach
// path runs, and asserts that N sequential rounds on ONE reused signal never let
// the "abort" listener count exceed one and always return to the baseline.

/** A localhost cleartext-HTTP/2 (h2c) server that accepts the Run request and
 *  immediately ends the response stream, so each streamCursor round settles fast
 *  through its normal completion path (and therefore through the finally that
 *  must detach the abort listener). */
function startH2Server(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = http2.createServer();
	server.on("stream", stream => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		// No body: the client sees a clean end and the round settles.
		stream.end();
	});
	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				baseUrl: `http://127.0.0.1:${port}`,
				close: () => new Promise<void>(done => server.close(() => done())),
			});
		});
	});
}

/** Wrap a signal's add/removeEventListener to count net "abort" listeners and
 *  track the high-water mark. Real EventTarget gives no listener-count API, so we
 *  instrument the two calls the fix is responsible for balancing. */
function trackAbortListeners(signal: AbortSignal): { net: () => number; max: () => number } {
	let net = 0;
	let max = 0;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	signal.addEventListener = ((type: string, ...rest: unknown[]) => {
		if (type === "abort") {
			net++;
			if (net > max) max = net;
		}
		return (add as unknown as (...a: unknown[]) => unknown)(type, ...rest);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
		if (type === "abort") net = Math.max(0, net - 1);
		return (remove as unknown as (...a: unknown[]) => unknown)(type, ...rest);
	}) as typeof signal.removeEventListener;
	return { net: () => net, max: () => max };
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
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** Drain a stream to completion, swallowing a terminal error event/throw: this
 *  suite asserts the LISTENER lifecycle, which must hold on the error path too. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	try {
		for await (const _ of stream) {
			// discard events
		}
	} catch {
		// The empty-body response may surface as a terminal error; the finally
		// (and thus the listener detach) still runs, which is what we assert.
	}
	// Flush the microtask that runs the IIFE's finally (removeEventListener) so it
	// has definitely happened before we read the counters.
	await new Promise<void>(resolve => setTimeout(resolve, 5));
}

let srv: { baseUrl: string; close: () => Promise<void> };

beforeEach(async () => {
	srv = await startH2Server();
});

afterEach(async () => {
	await srv.close();
});

describe("cursor streamCursor abort-listener lifecycle on a shared signal", () => {
	it("never accumulates abort listeners across many sequential rounds on ONE reused signal", async () => {
		const controller = new AbortController();
		const counters = trackAbortListeners(controller.signal);
		const model = cursorModel(srv.baseUrl);

		const ROUNDS = 8;
		for (let round = 0; round < ROUNDS; round++) {
			const stream = streamCursor(model, context, { apiKey: "test-token", signal: controller.signal });
			await drain(stream);
			// After each settled round the listener is detached: the shared signal is
			// back to zero "abort" listeners (the leak would leave one per round).
			expect(counters.net()).toBe(0);
		}

		// The high-water mark proves both halves: it is EXACTLY 1, not 0 (the
		// listener really was attached each round, so this is not a vacuous test
		// that never reached the attach path) and not ROUNDS (with the leak every
		// round would strand its listener). Attached once, detached once, per round.
		expect(counters.max()).toBe(1);
		expect(counters.net()).toBe(0);
	});

	it("attaches NO listener when the signal is already aborted before the round starts", async () => {
		const controller = new AbortController();
		controller.abort();
		const counters = trackAbortListeners(controller.signal);
		const model = cursorModel(srv.baseUrl);

		const stream = streamCursor(model, context, { apiKey: "test-token", signal: controller.signal });
		await drain(stream);

		// Already-aborted path runs the handler synchronously without an
		// addEventListener, so nothing is ever attached and nothing leaks.
		expect(counters.max()).toBe(0);
		expect(counters.net()).toBe(0);
	});
});
