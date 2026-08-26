/**
 * WHY THIS SUITE EXISTS.
 *
 * The SSE stream dropped a subscriber only when `enqueue` threw. It never throws on a stream
 * nobody reads: a `ReadableStream` with the default queuing strategy accepts every chunk and
 * holds it. A browser tab suspended on the run list, a `curl` left open and stopped, or any
 * reader that goes away without the stream's `cancel` firing therefore grew the manager's
 * memory by one run-list snapshot per tick for as long as the manager lived, and the subscriber
 * stayed in `clientCount` forever.
 *
 * The tick also wrote only when the snapshot changed, so a manager with nothing running sent
 * nothing at all. A proxy, and a browser, close a connection that says nothing for a minute,
 * which read as the manager having died.
 *
 * The class this closes: a subscriber whose backlog is unbounded, and a connection held open by
 * traffic that may never come. A frame count is now the bound, and an idle connection gets a
 * comment frame from the same clock the tick runs on.
 *
 * What it does not catch: whether Bun's HTTP layer surfaces the errored stream to the socket,
 * which is Bun's contract rather than this class's, and a subscriber that reads slowly but
 * steadily, which is indistinguishable from a healthy one by design.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "../../src/manager/store";
import { SSE_CLIENT_BACKLOG_MAX_FRAMES, SSE_KEEPALIVE_FRAME, SSE_KEEPALIVE_MS, SseStream } from "../../src/server/sse";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

function storeInTempDir(): RunStore {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sse-backlog-test-"));
	const store = new RunStore(dir);
	cleanups.push(() => {
		store.close();
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	return store;
}

/** A clock the test moves by hand, so no case waits on a real keep-alive interval. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
	let value = 1_000_000;
	return {
		now: () => value,
		advance: (ms: number) => {
			value += ms;
		},
	};
}

function streamWith(options: { now?: () => number; keepaliveMs?: number } = {}): SseStream {
	const sse = new SseStream(options);
	cleanups.push(() => sse.stop());
	return sse;
}

describe("a subscriber that stops reading", () => {
	it("is dropped at the frame bound instead of buffering without limit", () => {
		const store = storeInTempDir();
		const sse = streamWith();
		const response = sse.createResponse(store);
		expect(sse.clientCount).toBe(1);

		// One frame is already queued: the initial snapshot every subscriber opens with.
		for (let sent = 1; sent < SSE_CLIENT_BACKLOG_MAX_FRAMES; sent += 1) {
			sse.broadcast(`data: ${sent}\n\n`);
			expect(sse.clientCount).toBe(1);
		}

		sse.broadcast("data: one too many\n\n");
		expect(sse.clientCount).toBe(0);

		// A dropped subscriber's body ends in an error rather than staying half-open.
		expect(response.body).not.toBeNull();
	});

	it("ends the dropped subscriber's stream with the reason it was dropped", async () => {
		const store = storeInTempDir();
		const sse = streamWith();
		const response = sse.createResponse(store);
		for (let sent = 0; sent <= SSE_CLIENT_BACKLOG_MAX_FRAMES; sent += 1) {
			sse.broadcast(`data: ${sent}\n\n`);
		}
		expect(sse.clientCount).toBe(0);

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) return;
		let failure: unknown = null;
		try {
			// The frames already queued are delivered first; the error is the stream's end.
			for (let read = 0; read < SSE_CLIENT_BACKLOG_MAX_FRAMES + 2; read += 1) {
				const chunk = await reader.read();
				if (chunk.done) break;
			}
		} catch (cause) {
			failure = cause;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(String(SSE_CLIENT_BACKLOG_MAX_FRAMES));
	});

	it("keeps a subscriber that reads what it is sent", async () => {
		const store = storeInTempDir();
		const sse = streamWith();
		const response = sse.createResponse(store);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) return;

		await reader.read(); // the initial snapshot
		for (let round = 0; round < SSE_CLIENT_BACKLOG_MAX_FRAMES * 2; round += 1) {
			sse.broadcast(`data: ${round}\n\n`);
			const chunk = await reader.read();
			expect(chunk.done).toBe(false);
		}
		expect(sse.clientCount).toBe(1);
	});
});

describe("an idle subscriber", () => {
	it("is sent a comment frame once the keep-alive interval has passed", async () => {
		const clock = fakeClock();
		const store = storeInTempDir();
		const sse = streamWith({ now: clock.now, keepaliveMs: SSE_KEEPALIVE_MS });
		const response = sse.createResponse(store);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) return;
		await reader.read(); // the initial snapshot

		// The first tick writes the snapshot, which is a change from the empty string.
		sse.tick(store);
		expect(new TextDecoder().decode((await reader.read()).value)).toStartWith("data: ");

		// Nothing changed and no time passed: no frame at all.
		sse.tick(store);
		clock.advance(SSE_KEEPALIVE_MS - 1);
		sse.tick(store);

		clock.advance(1);
		sse.tick(store);
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(SSE_KEEPALIVE_FRAME);
	});

	it("counts a data frame as traffic, so a busy stream is never padded", async () => {
		const clock = fakeClock();
		const store = storeInTempDir();
		const sse = streamWith({ now: clock.now, keepaliveMs: SSE_KEEPALIVE_MS });
		const response = sse.createResponse(store);
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) return;
		await reader.read();

		clock.advance(SSE_KEEPALIVE_MS * 3);
		sse.broadcast("data: real work\n\n");
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: real work\n\n");

		// The broadcast is the traffic the keep-alive exists to avoid duplicating.
		sse.tick(store);
		const snapshot = new TextDecoder().decode((await reader.read()).value);
		expect(snapshot).toStartWith("data: ");
		sse.tick(store);
		clock.advance(SSE_KEEPALIVE_MS - 1);
		sse.tick(store);

		let pending: string | null = null;
		const race = await Promise.race([
			reader.read().then(chunk => {
				pending = new TextDecoder().decode(chunk.value);
				return "read" as const;
			}),
			Promise.resolve("idle" as const),
		]);
		expect(race).toBe("idle");
		expect(pending).toBeNull();
	});

	it("states a keep-alive interval short enough for a proxy to hold the connection", () => {
		expect(SSE_KEEPALIVE_MS).toBeLessThanOrEqual(30_000);
		expect(SSE_KEEPALIVE_FRAME.startsWith(":")).toBe(true);
		expect(SSE_KEEPALIVE_FRAME.endsWith("\n\n")).toBe(true);
	});
});
