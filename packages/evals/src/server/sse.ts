/**
 * Server-Sent Events stream manager for the evals server.
 *
 * Owns subscriber connections, periodic heartbeat / store snapshot broadcasts,
 * and clean stream termination upon disconnection or server shutdown.
 */
import type { RunStore } from "../manager/store";

const enum SseState {
	Open = 0,
	Closed = 1,
}

interface SseClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	state: SseState;
}

export class SseStream {
	readonly #clients = new Set<SseClient>();
	#lastSnapshot = "";
	#heartbeatTimer: Timer | undefined;

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
		}
	}

	broadcast(frame: string): void {
		const bytes = new TextEncoder().encode(frame);
		for (const client of this.#clients) {
			if (client.state === SseState.Closed) continue;
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
