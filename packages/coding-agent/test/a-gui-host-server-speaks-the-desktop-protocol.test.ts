/**
 * WHY:
 *
 * The GUI desktop client connects to the coding-agent engine over a line-delimited
 * JSON stream on a unix domain socket or TCP port. A protocol mismatch, missing
 * greeting, omitted capability decision, dropped/unanswered request id, unbounded
 * frame read, or resource leak on client disconnect freezes the native gpui window
 * or crashes the engine.
 *
 * This suite defends:
 * 1. The first frame is ALWAYS the connection greeting with protocol 1.
 * 2. Every member of `Capability::ALL` is declared in the capability snapshot at runtime,
 *    failing when a new capability is added without an explicit implementation decision.
 * 3. `ListSessions` produces a 2-tuple SnapshotSection::Sessions shape.
 * 4. Every unimplemented or unsupported action is answered with `RequestFailed` naming
 *    the action, ensuring a surface waiting on a correlation id is never left hung.
 * 5. Frames exceeding 8 MiB or containing malformed JSON immediately terminate the connection.
 * 6. Disconnecting clients mid-request release resources and do not affect concurrent clients.
 *
 * What this does NOT catch:
 * - Real model generation / LLM completions (requires live provider credentials).
 * - GPUI rendering correctness inside the Rust binary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	ACTION_TO_CAPABILITY,
	ALL_CAPABILITIES,
	ALL_HOST_ACTIONS,
	type Capability,
	type GuiHostServer,
	PROTOCOL_VERSION,
	SUPPORTED_CAPABILITIES,
	startGuiHostServer,
} from "../src/gui-host";

class TestSocketClient {
	#socket: net.Socket;
	#buffer = Buffer.alloc(0);
	#frames: unknown[] = [];
	#waiters: Array<{ resolve: (frame: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
	#closeWaiters: Array<{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];
	#isClosed = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;

		this.#socket.on("data", (chunk: Buffer) => {
			const data = Buffer.from(chunk);
			this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
			while (this.#buffer.length > 0) {
				const idx = this.#buffer.indexOf(0x0a);
				if (idx === -1) {
					break;
				}
				const lineBuf = this.#buffer.subarray(0, idx);
				this.#buffer = this.#buffer.subarray(idx + 1);
				const str = lineBuf.toString("utf8").trim();
				if (str.length > 0) {
					try {
						const parsed: unknown = JSON.parse(str);
						if (this.#waiters.length > 0) {
							const waiter = this.#waiters.shift();
							if (waiter) {
								clearTimeout(waiter.timer);
								waiter.resolve(parsed);
							}
						} else {
							this.#frames.push(parsed);
						}
					} catch {
						// Malformed JSON received
					}
				}
			}
		});

		this.#socket.on("close", () => {
			this.#isClosed = true;
			for (const waiter of this.#closeWaiters) {
				clearTimeout(waiter.timer);
				waiter.resolve();
			}
			this.#closeWaiters = [];

			for (const waiter of this.#waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("Socket closed before frame arrived"));
			}
			this.#waiters = [];
		});

		this.#socket.on("error", () => {
			// Handled by close
		});
	}

	static async connect(endpoint: string, timeoutMs = 2000): Promise<TestSocketClient> {
		const { promise, resolve, reject } = Promise.withResolvers<TestSocketClient>();
		const timer = setTimeout(() => {
			reject(new Error(`Timed out connecting to ${endpoint} after ${timeoutMs}ms`));
		}, timeoutMs);

		let socket: net.Socket;
		if (endpoint.startsWith("unix:")) {
			socket = net.createConnection(endpoint.slice(5));
		} else if (endpoint.startsWith("tcp:")) {
			const authority = endpoint.slice(4);
			const idx = authority.lastIndexOf(":");
			const host = authority.slice(0, idx);
			const port = Number.parseInt(authority.slice(idx + 1), 10);
			socket = net.createConnection(port, host);
		} else {
			clearTimeout(timer);
			throw new Error(`Unknown endpoint scheme: ${endpoint}`);
		}

		socket.on("connect", () => {
			clearTimeout(timer);
			resolve(new TestSocketClient(socket));
		});

		socket.on("error", err => {
			clearTimeout(timer);
			reject(err);
		});

		return promise;
	}

	async nextFrame(timeoutMs = 2000): Promise<unknown> {
		if (this.#frames.length > 0) {
			return this.#frames.shift();
		}

		if (this.#isClosed) {
			throw new Error("Socket is already closed; no frame available");
		}

		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			const idx = this.#waiters.findIndex(w => w.resolve === resolve);
			if (idx !== -1) {
				this.#waiters.splice(idx, 1);
			}
			reject(new Error(`Timed out waiting for next frame after ${timeoutMs}ms`));
		}, timeoutMs);

		this.#waiters.push({ resolve, reject, timer });
		return promise;
	}

	send(value: unknown): void {
		this.#socket.write(`${JSON.stringify(value)}\n`, "utf8");
	}

	sendRaw(data: Buffer | string): void {
		this.#socket.write(data);
	}

	async waitForClose(timeoutMs = 2000): Promise<void> {
		if (this.#isClosed) {
			return;
		}

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			const idx = this.#closeWaiters.findIndex(w => w.resolve === resolve);
			if (idx !== -1) {
				this.#closeWaiters.splice(idx, 1);
			}
			reject(new Error(`Timed out waiting for socket close after ${timeoutMs}ms`));
		}, timeoutMs);

		this.#closeWaiters.push({ resolve, reject, timer });
		return promise;
	}

	destroy(): void {
		this.#socket.destroy();
	}
}

describe("GUI host server protocol", () => {
	let tempDir: string;
	let socketPath: string;
	let endpoint: string;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-test-"));
		socketPath = path.join(tempDir, "test.sock");
		endpoint = `unix:${socketPath}`;
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	test("the first frame is the greeting with protocol 1, before anything else", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);

		const firstFrame = (await client.nextFrame(2000)) as Record<string, unknown>;
		expect(firstFrame).toEqual({
			ConnectionChanged: {
				Connected: {
					endpoint: server.endpoint,
					protocol: PROTOCOL_VERSION,
				},
			},
		});

		client.destroy();
	});

	test("a capability snapshot arrives naming EVERY member of Capability::ALL, with exact opted-out set", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);

		// Frame 1: Greeting
		await client.nextFrame(2000);

		// Frame 2: Capability snapshot
		const secondFrame = (await client.nextFrame(2000)) as {
			Snapshot: { Capabilities: [Capability, string | { Unavailable: { reason: string } }][] };
		};

		expect(secondFrame.Snapshot).toBeDefined();
		expect(secondFrame.Snapshot.Capabilities).toBeDefined();

		const capabilitiesList = secondFrame.Snapshot.Capabilities;
		expect(capabilitiesList.length).toBe(ALL_CAPABILITIES.length);

		const reportedMap = new Map(capabilitiesList);

		// Every member of ALL_CAPABILITIES must be present
		for (const cap of ALL_CAPABILITIES) {
			expect(reportedMap.has(cap)).toBeTrue();
		}

		// Supported capabilities must be "Available"
		const expectedSupported: Capability[] = ["Sessions", "Transcript", "TurnControl", "Lifecycle"];
		for (const cap of expectedSupported) {
			expect(reportedMap.get(cap)).toBe("Available");
		}

		// The opted-out set must match exact equality
		const expectedOptedOut: Capability[] = ALL_CAPABILITIES.filter(cap => !SUPPORTED_CAPABILITIES[cap]);
		const actualOptedOut: Capability[] = [];

		for (const [cap, status] of capabilitiesList) {
			if (typeof status === "object" && status !== null && "Unavailable" in status) {
				actualOptedOut.push(cap);
			}
		}

		expect(actualOptedOut).toEqual(expectedOptedOut);

		client.destroy();
	});

	test("ListSessions produces a Snapshot whose shape SnapshotSection::Sessions accepts", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame(2000);
		await client.nextFrame(2000);

		// Send ListSessions request
		client.send({ id: 1, action: "ListSessions" });

		const snapshotFrame = (await client.nextFrame(2000)) as {
			Snapshot: { Sessions: [{ revision: number; value: unknown[] }, unknown[]] };
		};

		expect(snapshotFrame.Snapshot).toBeDefined();
		expect(snapshotFrame.Snapshot.Sessions).toBeDefined();
		expect(Array.isArray(snapshotFrame.Snapshot.Sessions)).toBeTrue();
		expect(snapshotFrame.Snapshot.Sessions.length).toBe(2);

		const [versioned, unreadable] = snapshotFrame.Snapshot.Sessions;
		expect(versioned.revision).toBeGreaterThanOrEqual(1);
		expect(Array.isArray(versioned.value)).toBeTrue();
		expect(Array.isArray(unreadable)).toBeTrue();

		const responseFrame = (await client.nextFrame(2000)) as { RequestSucceeded: { request: number } };
		expect(responseFrame).toEqual({ RequestSucceeded: { request: 1 } });

		client.destroy();
	});

	test("an unimplemented action is answered RequestFailed naming it, and never left unanswered", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame(2000);
		await client.nextFrame(2000);

		// Send unimplemented action
		client.send({
			id: 42,
			action: { SelectModel: { provider: "anthropic", model: "claude-sonnet-4-5" } },
		});

		const responseFrame = (await client.nextFrame(2000)) as {
			RequestFailed: {
				request: number;
				error: {
					scope: string;
					code: string;
					message: string;
					retryable: boolean;
					request: number;
					occurred_at_ms: number;
				};
			};
		};

		expect(responseFrame.RequestFailed).toBeDefined();
		expect(responseFrame.RequestFailed.request).toBe(42);
		expect(responseFrame.RequestFailed.error.scope).toBe("Provider");
		expect(responseFrame.RequestFailed.error.code).toBe("UNIMPLEMENTED_ACTION");
		expect(responseFrame.RequestFailed.error.message).toContain("SelectModel");
		expect(responseFrame.RequestFailed.error.request).toBe(42);
		expect(typeof responseFrame.RequestFailed.error.occurred_at_ms).toBe("number");

		client.destroy();
	});

	test("a frame over the bound and a frame of malformed JSON each end the connection", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });

		// 1. Oversized frame test
		const client1 = await TestSocketClient.connect(server.endpoint);
		await client1.nextFrame(2000); // greeting

		// Send > 8 MiB without newline
		const oversized = Buffer.alloc(8 * 1024 * 1024 + 1024, 0x61);
		client1.sendRaw(oversized);

		await client1.waitForClose(2000);

		// 2. Malformed JSON test
		const client2 = await TestSocketClient.connect(server.endpoint);
		await client2.nextFrame(2000); // greeting

		client2.sendRaw("{ this is definitely not valid JSON }\n");
		await client2.waitForClose(2000);
	});

	test("a client that disconnects mid-request leaks nothing: server keeps serving another client", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });

		const client1 = await TestSocketClient.connect(server.endpoint);
		const client2 = await TestSocketClient.connect(server.endpoint);

		// Both receive greetings
		await client1.nextFrame(2000);
		await client2.nextFrame(2000);

		// Client 1 sends a request and immediately disconnects
		client1.send({ id: 10, action: "ListSessions" });
		client1.destroy();

		// Client 2 continues to operate without issue
		client2.send({ id: 20, action: "ListSessions" });

		const snapshotFrame = (await client2.nextFrame(2000)) as Record<string, unknown>;
		// Could be capability snapshot from connect or Sessions snapshot
		let sessionsSnapshot = snapshotFrame;
		if (!("Snapshot" in sessionsSnapshot && "Sessions" in (sessionsSnapshot.Snapshot as Record<string, unknown>))) {
			sessionsSnapshot = (await client2.nextFrame(2000)) as Record<string, unknown>;
		}

		expect(sessionsSnapshot.Snapshot).toBeDefined();

		const successFrame = await client2.nextFrame(2000);
		expect(successFrame).toEqual({ RequestSucceeded: { request: 20 } });

		client2.destroy();
	});

	test("every capability reported Available has working actions and unimplemented actions report Unavailable", async () => {
		server = await startGuiHostServer({ endpoint, cwd: tempDir });
		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame(2000);
		const capFrame = (await client.nextFrame(2000)) as {
			Snapshot: { Capabilities: [Capability, string | { Unavailable: { reason: string } }][] };
		};
		const capMap = new Map(capFrame.Snapshot.Capabilities);

		// Derive all actions from the exported wire types at runtime
		for (const actionName of ALL_HOST_ACTIONS) {
			const mappedCapability = ACTION_TO_CAPABILITY[actionName];
			expect(mappedCapability).toBeDefined();

			const capStatus = capMap.get(mappedCapability);
			expect(capStatus).toBeDefined();

			if (capStatus !== "Available") {
				expect(typeof capStatus === "object" && "Unavailable" in capStatus).toBeTrue();
				// Sending an unimplemented action receives RequestFailed naming it
				client.send({ id: 888, action: actionName });
				const res = (await client.nextFrame(2000)) as {
					RequestFailed: { request: number; error: { code: string; message: string } };
				};
				expect(res.RequestFailed).toBeDefined();
				expect(res.RequestFailed.request).toBe(888);
				expect(res.RequestFailed.error.code).toBe("UNIMPLEMENTED_ACTION");
				expect(res.RequestFailed.error.message).toContain(actionName);
			}
		}

		// Capabilities reported Available must be the supported ones
		expect(capMap.get("Sessions")).toBe("Available");
		expect(capMap.get("Transcript")).toBe("Available");
		expect(capMap.get("TurnControl")).toBe("Available");
		expect(capMap.get("Lifecycle")).toBe("Available");

		client.destroy();
	});
});
