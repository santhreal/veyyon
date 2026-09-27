/**
 * WHY: a tab worker thread reaches the browser through a connection the main thread holds and relays
 * to it, so that ending a worker stuck in synchronous work closes the connection at once and the
 * browser stops holding new targets for it. The relay is the worker's only way to the browser: a
 * message lost or reordered breaks every command after it, and a close that never reaches the worker
 * leaves each of its commands waiting out the protocol timeout.
 *
 * The contract, against a local WebSocket server: messages cross in order both ways, a 20 MB message
 * crosses whole, a close by the server reaches the worker's transport, closing the relay closes the
 * socket, and a relay to an endpoint that refuses it rejects `opened` with a message naming it.
 *
 * What it does not catch: what Chromium sends, which every browser suite drives through this relay.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type ConnectionRelay,
	openConnectionRelay,
	PortTransport,
} from "@veyyon/coding-agent/tools/web/browser/connection-relay";

const BIG = 20 * 1024 * 1024;

interface Peer {
	readonly messages: string[];
	readonly closed: Promise<void>;
}

const peers: Peer[] = [];
const closedBy: Array<PromiseWithResolvers<void>> = [];

// A WebSocket server with no dependency: node:http has no WebSocket upgrade of its own.
const server = Bun.serve<{ peer: number }>({
	port: 0,
	fetch(request, srv) {
		const peer = peers.length;
		const closed = Promise.withResolvers<void>();
		closedBy.push(closed);
		peers.push({ messages: [], closed: closed.promise });
		if (srv.upgrade(request, { data: { peer } })) return undefined;
		return new Response("upgrade failed", { status: 400 });
	},
	websocket: {
		message(ws, message) {
			const text = typeof message === "string" ? message : message.toString();
			peers[ws.data.peer]!.messages.push(text);
			if (text === "big") ws.send("x".repeat(BIG));
			else if (text === "bye") ws.close();
			else ws.send(`echo:${text}`);
		},
		close(ws) {
			closedBy[ws.data.peer]!.resolve();
		},
	},
});

afterAll(() => {
	server.stop(true);
});

/** Settle with `promise`, or fail naming `what` once `ms` has passed. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const timeout = sleep(ms).then(() => {
		throw new Error(`${what} did not happen within ${ms} ms`);
	});
	return await Promise.race([promise, timeout]);
}

async function connect(): Promise<{
	relay: ConnectionRelay;
	transport: PortTransport;
	received: string[];
	closed: Promise<void>;
	peer: Peer;
}> {
	const relay = openConnectionRelay(`ws://127.0.0.1:${server.port}/`);
	await within(relay.opened, 5_000, "the relay opening");
	const transport = new PortTransport(relay.port);
	const received: string[] = [];
	const closed = Promise.withResolvers<void>();
	transport.onmessage = message => received.push(message);
	transport.onclose = () => closed.resolve();
	return { relay, transport, received, closed: closed.promise, peer: peers[peers.length - 1]! };
}

async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
		await sleep(10);
	}
}

describe("a relayed browser connection", () => {
	it("carries messages in order both ways", async () => {
		const { relay, transport, received, peer } = await connect();
		for (const message of ["one", "two", "three"]) transport.send(message);
		await until(() => received.length === 3, 5_000, "three echoes");
		expect(peer.messages).toEqual(["one", "two", "three"]);
		expect(received).toEqual(["echo:one", "echo:two", "echo:three"]);
		relay.close();
	});

	it("carries a 20 MB message whole", async () => {
		const { relay, transport, received } = await connect();
		transport.send("big");
		await until(() => received.length === 1, 10_000, "the large message");
		expect(received[0]!.length).toBe(BIG);
		relay.close();
	});

	it("tells the worker's transport when the server closes the connection", async () => {
		const { transport, closed } = await connect();
		transport.send("bye");
		await within(closed, 5_000, "the close reaching the transport");
	});

	it("closes the socket when the relay is closed", async () => {
		const { relay, closed, peer } = await connect();
		relay.close();
		await within(peer.closed, 5_000, "the server seeing the close");
		await within(closed, 5_000, "the close reaching the transport");
	});

	it("rejects opening when nothing accepts the connection", async () => {
		const unused = Bun.serve({ port: 0, fetch: () => new Response("no upgrade", { status: 400 }) });
		const endpoint = `ws://127.0.0.1:${unused.port}/`;
		const relay = openConnectionRelay(endpoint);
		const failure = await within(
			relay.opened.then(
				() => "opened",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			5_000,
			"the refused relay settling",
		);
		unused.stop(true);
		expect(failure).toContain(`The browser connection at ${endpoint} closed before it opened`);
	});
});
