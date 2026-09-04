/**
 * Server-Sent Events stream manager for the evals server.
 *
 * Owns subscriber connections, periodic heartbeat / store snapshot broadcasts,
 * and clean stream termination upon disconnection or server shutdown.
 *
 * A subscriber that stops reading is dropped rather than buffered: `enqueue` on a stream
 * nobody reads never throws, so a browser tab suspended on a run list grew the manager's
 * memory by one snapshot every tick for as long as the manager lived. An idle subscriber gets
 * a comment frame, because the tick only wrote when the snapshot changed and a proxy or a
 * browser drops a connection that says nothing for a minute.
 */
import type { RunStore } from "../store/sqlite";

const enum SseState {
	Open = 0,
	Closed = 1,
}

interface SseClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	state: SseState;
}

/** Frames one subscriber may have unread before it is dropped as gone. */
export const SSE_CLIENT_BACKLOG_MAX_FRAMES = 256;

/** How long a subscriber may hear nothing before it is sent a comment frame. */
export const SSE_KEEPALIVE_MS = 15_000;

/** The comment frame an idle connection is held open with. SSE readers ignore a comment. */
export const SSE_KEEPALIVE_FRAME = ": keep-alive\n\n";

export interface SseStreamOptions {
	/** Clock the keep-alive is measured against. */
	readonly now?: () => number;
	/** Idle time before a comment frame is written. */
	readonly keepaliveMs?: number;
}

export class SseStream {
	readonly #clients = new Set<SseClient>();
	readonly #now: () => number;
	readonly #keepaliveMs: number;
	#lastSnapshot = "";
	#heartbeatTimer: Timer | undefined;
	#lastFrameAt: number;

	constructor(options: SseStreamOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#keepaliveMs = options.keepaliveMs ?? SSE_KEEPALIVE_MS;
		this.#lastFrameAt = this.#now();
	}

	get clientCount(): number {
		return this.#clients.size;
	}

	get isHeartbeatActive(): boolean {
		return this.#heartbeatTimer !== undefined;
	}

	startHeartbeat(store: RunStore, intervalMs = 2000): void {
		clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = setInterval(() => this.tick(store), intervalMs);
	}

	stopHeartbeat(): void {
		clearInterval(this.#heartbeatTimer);
		this.#heartbeatTimer = undefined;
	}

	tick(store: RunStore): void {
		store.syncActive();
		const snapshot = JSON.stringify(store.listRuns());
		if (snapshot !== this.#lastSnapshot) {
			this.#lastSnapshot = snapshot;
			this.broadcast(`data: ${snapshot}\n\n`);
			return;
		}
		if (this.#now() - this.#lastFrameAt >= this.#keepaliveMs) {
			this.broadcast(SSE_KEEPALIVE_FRAME);
		}
	}

	broadcast(frame: string): void {
		const bytes = new TextEncoder().encode(frame);
		this.#lastFrameAt = this.#now();
		for (const client of this.#clients) {
			if (client.state === SseState.Closed) continue;
			// desiredSize is `highWaterMark - queued`, so this counts the frames the reader
			// has not taken. A reader that never takes any is gone, whatever the socket says.
			const size = client.controller.desiredSize;
			if (size !== null && 1 - size >= SSE_CLIENT_BACKLOG_MAX_FRAMES) {
				client.state = SseState.Closed;
				this.#clients.delete(client);
				try {
					client.controller.error(
						new Error(`SSE subscriber left ${SSE_CLIENT_BACKLOG_MAX_FRAMES} frames unread; dropped.`),
					);
				} catch {}
				continue;
			}
			try {
				client.controller.enqueue(bytes);
			} catch {
				client.state = SseState.Closed;
				this.#clients.delete(client);
			}
		}
	}

	createResponse(store: RunStore): Response {
		let client: SseClient;
		const clients = this.#clients;
		const initial = `data: ${JSON.stringify(store.listRuns())}\n\n`;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				client = { controller, state: SseState.Open };
				clients.add(client);
				controller.enqueue(new TextEncoder().encode(initial));
			},
			cancel() {
				client.state = SseState.Closed;
				clients.delete(client);
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	}

	stop(): void {
		this.stopHeartbeat();
		for (const client of this.#clients) {
			client.state = SseState.Closed;
			try {
				client.controller.close();
			} catch {}
		}
		this.#clients.clear();
	}
}
