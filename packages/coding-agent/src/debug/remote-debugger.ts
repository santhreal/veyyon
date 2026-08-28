import { startRemoteDebugger } from "bun:jsc";
import * as net from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const PROBE_DEADLINE_MS = 1000;
const PROBE_INTERVAL_MS = 50;

export interface RemoteDebuggerInfo {
	host: string;
	port: number;
}

let active: RemoteDebuggerInfo | null = null;
let starting: Promise<RemoteDebuggerInfo> | null = null;

export type RemoteDebuggerStarter = (host: string, port: number) => void;

export interface StartRemoteDebuggerOptions {
	port?: number;
	start?: RemoteDebuggerStarter;
}

export function getRemoteDebugger(): RemoteDebuggerInfo | null {
	return active;
}

async function reserveFreePort(host: string): Promise<number> {
	const server = net.createServer();
	const listening = Promise.withResolvers<number>();
	server.once("error", listening.reject);
	server.listen(0, host, () => {
		const addr = server.address();
		if (addr && typeof addr === "object") listening.resolve(addr.port);
		else listening.reject(new Error("Failed to reserve a debugger port"));
	});
	try {
		return await listening.promise;
	} finally {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
}

function tryConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.createConnection({ host, port });
	let settled = false;
	const finish = (ok: boolean) => {
		if (settled) return;
		settled = true;
		socket.destroy();
		resolve(ok);
	};
	socket.setTimeout(timeoutMs);
	socket.once("connect", () => finish(true));
	socket.once("timeout", () => finish(false));
	socket.once("error", () => finish(false));
	return promise;
}

async function waitForListening(host: string, port: number): Promise<boolean> {
	const deadline = Date.now() + PROBE_DEADLINE_MS;
	do {
		if (await tryConnect(host, port, PROBE_INTERVAL_MS)) return true;
		await Bun.sleep(PROBE_INTERVAL_MS);
	} while (Date.now() < deadline);
	return false;
}

export async function startRemoteDebuggerServer(options: StartRemoteDebuggerOptions = {}): Promise<RemoteDebuggerInfo> {
	if (active) return active;
	starting ??= launch(options);
	try {
		return await starting;
	} finally {
		starting = null;
	}
}

async function launch({ port, start = startRemoteDebugger }: StartRemoteDebuggerOptions): Promise<RemoteDebuggerInfo> {
	const host = DEFAULT_HOST;
	const chosen = port ?? (await reserveFreePort(host));

	if (await tryConnect(host, chosen, PROBE_INTERVAL_MS)) {
		throw new Error(`Port ${host}:${chosen} is already in use; cannot start remote debugger there.`);
	}

	let thrown: unknown;
	try {
		start(host, chosen);
	} catch (err) {
		thrown = err;
	}

	if (await waitForListening(host, chosen)) {
		active = { host, port: chosen };
		return active;
	}

	throw thrown instanceof Error ? thrown : new Error(`Remote debugger socket never came up on ${host}:${chosen}`);
}

export function __resetRemoteDebuggerForTests(): void {
	active = null;
	starting = null;
}
