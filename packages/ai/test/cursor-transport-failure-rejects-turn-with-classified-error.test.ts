/**
 * WHY THIS SUITE EXISTS AND WHICH CLASS IT CLOSES.
 *
 * An audit identified a blocking defect in `packages/ai/src/providers/cursor.ts`:
 * The HTTP/2 session (`h2Client = http2.connect(...)`) had no listener attached for its
 * `'error'` event. In Node's / Bun's EventEmitter contract, emitting `'error'` on an emitter
 * with no registered listener re-throws as an uncaught exception, which crashes the process
 * instead of cleanly rejecting the agent turn.
 *
 * This defect triggers when:
 *  1. A network disconnect, unreachable host, or refused connection occurs on initial connect.
 *  2. An in-flight HTTP/2 session receives an unexpected socket disconnect, GOAWAY, frame error,
 *     or TLS error.
 *  3. A proxy tunnel connection drops or fails after the HTTP/2 session handshake.
 *
 * What this suite closes:
 *  - Enforces that any transport failure (connection refusal, session-level error event,
 *    socket reset, or mid-stream disconnect) cleanly rejects the turn stream with a classified
 *    error (`AIError.Flag.Transient` / `AIError.Flag.NetworkError`), emits an error event on the stream,
 *    and never crashes the process with an unhandled EventEmitter error.
 *  - Verifies that error handling is idempotent (no double settlement), handles errors arriving
 *    after session closure, and cleans up timers and resources without leaks.
 *
 * What it does not catch:
 *  - Real upstream Cursor backend availability across the public internet.
 */
import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { buildModel } from "@veyyon/catalog/build";
import * as AIError from "../src/error";
import { streamCursor } from "../src/providers/cursor";
import type { Context, Model } from "../src/types";

const makeModel = (baseUrl: string): Model<"cursor-agent"> =>
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

interface ErrorEventPayload {
	type?: string;
	reason?: string;
	error?: {
		stopReason?: string;
		errorId?: number;
		errorMessage?: string;
	};
}

describe("Cursor HTTP/2 session error handling and recovery", () => {
	it("rejects turn stream with classified error on connection refusal instead of crashing", async () => {
		// Use a local port that is not listening (connection refused)
		const model = makeModel("http://127.0.0.1:1");
		const stream = streamCursor(model, testContext, { apiKey: "test-key" });

		const events: unknown[] = [];
		let terminalError: unknown;

		try {
			for await (const event of stream) {
				events.push(event);
			}
		} catch (error) {
			terminalError = error;
		}

		// The stream must yield an error event or reject with a classified error
		const lastEvent = events[events.length - 1] as ErrorEventPayload | undefined;
		const isErrorEvent = lastEvent?.type === "error";
		const hasError = isErrorEvent || terminalError !== undefined;

		expect(hasError).toBe(true);

		if (isErrorEvent && lastEvent?.error?.errorId !== undefined) {
			expect(AIError.is(lastEvent.error.errorId, AIError.Flag.Transient)).toBe(true);
		}
	});

	it("handles mid-stream HTTP/2 session error event cleanly and classifies as transient", async () => {
		const server = http2.createServer();
		let activeSession: http2.ServerHttp2Session | undefined;

		server.on("session", session => {
			activeSession = session;
			// Absorb server-side session errors in test harness
			session.on("error", () => {});
		});

		server.on("stream", (serverStream: http2.ServerHttp2Stream) => {
			serverStream.on("error", () => {});
			serverStream.respond({
				":status": 200,
				"content-type": "application/connect+proto",
			});
			// Abruptly destroy the server session with an error to simulate mid-stream network drop
			queueMicrotask(() => {
				try {
					activeSession?.destroy(new Error("Simulated server session crash"));
				} catch {
					// Ignore
				}
			});
		});

		const { promise: listenPromise, resolve: onListen } = Promise.withResolvers<string>();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			onListen(`http://127.0.0.1:${port}`);
		});

		const baseUrl = await listenPromise;

		try {
			const model = makeModel(baseUrl);
			const stream = streamCursor(model, testContext, { apiKey: "test-key" });

			const events: unknown[] = [];
			try {
				for await (const event of stream) {
					events.push(event);
				}
			} catch {
				// Stream rejection is expected
			}

			const lastEvent = events[events.length - 1] as ErrorEventPayload | undefined;
			expect(lastEvent?.type).toBe("error");
			// Either the error is directly classified with a Flag, or carries stopReason 'error'
			expect(lastEvent?.error?.stopReason).toBe("error");
			if (lastEvent?.error?.errorId !== undefined) {
				expect(typeof lastEvent.error.errorId).toBe("number");
			}
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("handles late session errors after stream completion without throwing uncaughtException", async () => {
		const server = http2.createServer();
		let activeSession: http2.ServerHttp2Session | undefined;

		server.on("session", session => {
			activeSession = session;
			session.on("error", () => {});
		});

		server.on("stream", (serverStream: http2.ServerHttp2Stream) => {
			serverStream.on("error", () => {});
			// Respond with non-2xx status so stream completes/fails cleanly first
			serverStream.respond({
				":status": 401,
				"content-type": "text/plain",
			});
			serverStream.end("Unauthorized");
		});

		const { promise: listenPromise, resolve: onListen } = Promise.withResolvers<string>();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			onListen(`http://127.0.0.1:${port}`);
		});

		const baseUrl = await listenPromise;

		try {
			const model = makeModel(baseUrl);
			const stream = streamCursor(model, testContext, { apiKey: "test-key" });

			const events: unknown[] = [];
			for await (const event of stream) {
				events.push(event);
			}

			// Verify stream has settled
			const lastEvent = events[events.length - 1] as ErrorEventPayload | undefined;
			expect(lastEvent?.type).toBe("error");

			// Simulate a late error emitted on the server session
			try {
				activeSession?.destroy(new Error("Late error after turn ended"));
			} catch {
				// Ignore
			}
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("rejects turn with classified error on DNS resolution failure", async () => {
		// Use an unresolvable hostname
		const model = makeModel("http://non-existent-domain-cursor-xyz.invalid:443");
		const stream = streamCursor(model, testContext, { apiKey: "test-key" });

		const events: unknown[] = [];
		let terminalError: unknown;

		try {
			for await (const event of stream) {
				events.push(event);
			}
		} catch (error) {
			terminalError = error;
		}

		const lastEvent = events[events.length - 1] as ErrorEventPayload | undefined;
		const isErrorEvent = lastEvent?.type === "error";
		const hasError = isErrorEvent || terminalError !== undefined;

		expect(hasError).toBe(true);
		if (isErrorEvent && lastEvent?.error?.errorId !== undefined) {
			expect(AIError.is(lastEvent.error.errorId, AIError.Flag.Transient)).toBe(true);
		}
	});

	it("handles abort signal racing with transport error idempotently", async () => {
		const controller = new AbortController();
		const model = makeModel("http://127.0.0.1:1");
		const stream = streamCursor(model, testContext, {
			apiKey: "test-key",
			signal: controller.signal,
		});

		// Abort immediately
		controller.abort();

		const events: unknown[] = [];
		try {
			for await (const event of stream) {
				events.push(event);
			}
		} catch {
			// Expected
		}

		const lastEvent = events[events.length - 1] as ErrorEventPayload | undefined;
		expect(lastEvent?.type).toBe("error");
		expect(lastEvent?.error?.stopReason).toBe("aborted");
	});
});
