import { vi } from "bun:test";
import type { LspClient } from "@veyyon/coding-agent/lsp/types";
import * as piUtils from "@veyyon/utils";

export interface RpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message?: string };
}

export interface FakeLspServer {
	/** Parsed JSON-RPC messages the client wrote to the server, in arrival order. */
	readonly received: RpcMessage[];
	/** Server -> client: frame and enqueue a JSON-RPC message onto stdout. */
	send(message: RpcMessage): void;
	/** Resolve the process `exited` promise and close stdout. */
	exit(code?: number): void;
	/** Whether the client invoked `proc.kill()` (production's hard-kill fallback). */
	readonly killed: boolean;
	/** Resolve once a received message matches `predicate` (already-seen or future). */
	waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs?: number): Promise<RpcMessage>;
}

export type FakeLspHandler = (message: RpcMessage, server: FakeLspServer) => void | Promise<void>;

// In-memory LSP transport fake. Replaces the real subprocess (`ptree.spawn`)
// with an in-process JSON-RPC peer so the initialize / shutdown / exit and
// workspace-folder handshakes resolve deterministically -- no subprocess spawn,
// no real-clock latency. Installed by spying on the shared `ptree` namespace
// object (NOT `mock.module`, which would leak across files); the caller's
// `afterEach` `vi.restoreAllMocks()` removes it.
export function installFakeLsp(handler: FakeLspHandler): FakeLspServer {
	const encoder = new TextEncoder();
	const received: RpcMessage[] = [];
	const waiters: Array<{
		predicate: (message: RpcMessage) => boolean;
		resolve: (message: RpcMessage) => void;
		timer: Timer;
	}> = [];
	let exitCode: number | null = null;
	let killed = false;
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();

	const frame = (message: RpcMessage): Uint8Array => {
		const content = JSON.stringify(message);
		return encoder.encode(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	};

	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});

	const server: FakeLspServer = {
		received,
		send(message) {
			if (controller && exitCode === null) controller.enqueue(frame(message));
		},
		exit(code = 0) {
			if (exitCode !== null) return;
			exitCode = code;
			controller?.close();
			resolveExited(code);
		},
		get killed() {
			return killed;
		},
		waitFor(predicate, timeoutMs = 1_000) {
			const existing = received.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise<RpcMessage>((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex(entry => entry.timer === timer);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error("FakeLspServer.waitFor: timed out"));
				}, timeoutMs);
				waiters.push({ predicate, resolve, timer });
			});
		},
	};

	// Frame + dispatch the client -> server byte stream. The chain serialises
	// handler runs so message ordering mirrors the wire.
	let pendingBytes = Buffer.alloc(0);
	let chain: Promise<void> = Promise.resolve();
	const feed = (raw: string | Uint8Array): void => {
		const chunk = typeof raw === "string" ? Buffer.from(raw, "utf-8") : Buffer.from(raw);
		pendingBytes = pendingBytes.length === 0 ? chunk : Buffer.concat([pendingBytes, chunk]);
		chain = chain.then(async () => {
			while (true) {
				const headerEnd = pendingBytes.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;
				const match = /Content-Length: (\d+)/i.exec(pendingBytes.toString("utf-8", 0, headerEnd));
				if (!match) {
					pendingBytes = pendingBytes.subarray(headerEnd + 4);
					continue;
				}
				const start = headerEnd + 4;
				const end = start + Number(match[1]);
				if (pendingBytes.length < end) break;
				const message = JSON.parse(pendingBytes.toString("utf-8", start, end)) as RpcMessage;
				pendingBytes = pendingBytes.subarray(end);
				received.push(message);
				for (let i = waiters.length - 1; i >= 0; i--) {
					if (waiters[i].predicate(message)) {
						clearTimeout(waiters[i].timer);
						waiters[i].resolve(message);
						waiters.splice(i, 1);
					}
				}
				await handler(message, server);
			}
		});
	};

	const proc = {
		get exited() {
			return exited;
		},
		get exitCode() {
			return exitCode;
		},
		stdin: {
			write(chunk: string | Uint8Array) {
				feed(chunk);
				return typeof chunk === "string" ? Buffer.byteLength(chunk, "utf-8") : chunk.byteLength;
			},
			flush: async () => 0,
			end: async () => 0,
		},
		stdout,
		peekStderr: () => "",
		kill() {
			killed = true;
			server.exit(0);
		},
	} as unknown as LspClient["proc"];

	vi.spyOn(piUtils.ptree, "spawn").mockReturnValue(proc);
	return server;
}
