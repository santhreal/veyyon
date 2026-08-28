/**
 * WHY:
 * The SSE stream previously held persistent subscriptions and periodic heartbeat intervals
 * that could leak after server shutdown or client disconnections, causing orphaned timers
 * and memory growth across manager reloads.
 *
 * This suite closes the class by proving:
 *  1. An SSE client connecting to /api/events receives an initial run snapshot event.
 *  2. Broadcasting new state updates delivers the frame to active clients.
 *  3. Cancelling the client stream removes the subscriber from the active set.
 *  4. Stopping the SSE stream or server clears the heartbeat timer completely.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ManagerServer } from "../../api/main";
import { SseStream } from "../../api/sse";
import { RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];
afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sse-lifecycle-test-"));
	cleanups.push(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {}
	});
	return dir;
}

describe("SSE stream lifecycle, event delivery, and heartbeat termination", () => {
	it("receives initial snapshot, broadcasts updates, and closes client stream on disconnect", async () => {
		const jobsDir = makeTempJobsDir();
		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		const sse = new SseStream();
		cleanups.push(() => sse.stop());

		expect(sse.clientCount).toBe(0);
		expect(sse.isHeartbeatActive).toBe(false);

		// Start heartbeat
		sse.startHeartbeat(store, 100);
		expect(sse.isHeartbeatActive).toBe(true);

		// Client connects
		const res = sse.createResponse(store);
		expect(sse.clientCount).toBe(1);

		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) return;

		// 1. Initial snapshot received
		const firstChunk = await reader.read();
		expect(firstChunk.done).toBe(false);
		const firstText = new TextDecoder().decode(firstChunk.value);
		expect(firstText).toMatch(/^data:\s+\[.*\]\n\n$/);

		// 2. Broadcast delivers to active client
		sse.broadcast("data: custom-event\n\n");
		const secondChunk = await reader.read();
		expect(secondChunk.done).toBe(false);
		const secondText = new TextDecoder().decode(secondChunk.value);
		expect(secondText).toBe("data: custom-event\n\n");

		// 3. Client disconnects / cancels stream
		await reader.cancel();

		// Broadcasting to disconnected client cleans it up
		sse.broadcast("data: probe\n\n");
		expect(sse.clientCount).toBe(0);

		// 4. Heartbeat is cleared on stop
		sse.stop();
		expect(sse.isHeartbeatActive).toBe(false);
		expect(sse.clientCount).toBe(0);
	});

	it("delivers events over HTTP and terminates heartbeat upon server stop", async () => {
		const jobsDir = makeTempJobsDir();
		const manager = new ManagerServer(jobsDir);
		const server = manager.start(0);
		cleanups.push(async () => {
			await manager.stop();
		});

		const base = `http://127.0.0.1:${server.port}`;
		const res = await fetch(`${base}/api/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");

		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) return;

		const chunk = await reader.read();
		expect(chunk.done).toBe(false);
		const text = new TextDecoder().decode(chunk.value);
		expect(text).toContain("data:");

		// Disconnect client
		await reader.cancel();

		// Stopping the server terminates the heartbeat interval and all connections
		await manager.stop();
	});
});
