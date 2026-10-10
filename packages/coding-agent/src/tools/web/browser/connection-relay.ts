/**
 * A tab worker thread's browser connection, opened and closed on the main thread and relayed to the
 * worker over a message port.
 *
 * Every connection to Chromium attaches to each new target, a tab or a page's worker among them, and
 * the browser holds that target until the connection lets it run. A worker thread stuck in
 * synchronous work (an `execSync`, a native wait) cannot answer, and `terminate` does not stop a thread
 * inside a native call, so while its socket stayed open every new target in the browser waited for that
 * work to end. The main thread holds the socket instead: closing it ends the thread's sessions at once.
 */
import type { ConnectionTransport } from "puppeteer-core";
import { ToolError } from "../../core/tool-errors";

/** What the worker's end receives after the last message: the connection has closed. */
const CLOSED = null;

export interface ConnectionRelay {
	/** The worker's end, transferred with the worker's `init`. */
	readonly port: MessagePort;
	/** Settles once the connection is open, and rejects when it closes before that. */
	readonly opened: Promise<void>;
	/** Close the connection, open or opening; the browser ends every session on it. */
	close(): void;
}

/** Open a connection to the browser at `endpoint` and relay it to the port it returns. */
export function openConnectionRelay(endpoint: string): ConnectionRelay {
	const socket = new WebSocket(endpoint);
	const { port1: relayEnd, port2: workerEnd } = new MessageChannel();
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve(), { once: true });
	socket.addEventListener("message", event => relayEnd.postMessage(event.data));
	socket.addEventListener(
		"close",
		event => {
			opened.reject(
				new ToolError(
					`The browser connection at ${endpoint} closed before it opened (code ${event.code}). Check that the browser is still running, then open the tab again.`,
				),
			);
			relayEnd.postMessage(CLOSED);
			relayEnd.close();
		},
		{ once: true },
	);
	relayEnd.addEventListener("message", event => socket.send(event.data));
	relayEnd.start();
	return { port: workerEnd, opened: opened.promise, close: () => socket.close() };
}

/** The worker's end of a relay, as the transport `puppeteer.connect` takes. */
export class PortTransport implements ConnectionTransport {
	onmessage?: (message: string) => void;
	onclose?: () => void;
	#port: MessagePort;
	#closed = false;

	constructor(port: MessagePort) {
		this.#port = port;
		port.addEventListener("message", event => {
			if (typeof event.data === "string") this.onmessage?.(event.data);
			else this.#end();
		});
		port.start();
	}

	send(message: string): void {
		if (!this.#closed) this.#port.postMessage(message);
	}

	/** The main thread closes the connection when it ends the worker; this end only stops listening. */
	close(): void {
		this.#end();
	}

	#end(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#port.close();
		this.onclose?.();
	}
}
