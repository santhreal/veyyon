import * as fs from "node:fs/promises";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@veyyon/utils";
import { isSettingsInitialized, Settings } from "../config/settings";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import type { DaemonBrokerClient, DaemonBrokerClientOptions, PendingRequest } from "./client-helpers";
import {
	BROKER_CONNECT_TIMEOUT_MS,
	CONNECT_RETRY_MS,
	openSocket,
	readOrCreateToken,
	requestTimeoutMs,
} from "./client-helpers";
import { canonicalProjectDir, daemonBrokerEndpoint, daemonRuntimeDir } from "./paths";
import {
	DAEMON_BROKER_WORKER_ARG,
	DAEMON_CLEANUP_WAIT_ENV,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
	type DaemonRpcResult,
	type DaemonWireResponse,
	parseDaemonRpcResult,
	parseDaemonWireResponse,
} from "./protocol";

export type { DaemonBrokerClient };

class SocketDaemonClient implements DaemonBrokerClient {
	readonly projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #idleGraceMs: number | undefined;
	readonly #cleanupWaitMs: number | undefined;
	readonly #adoptSpawnedPid: ((pid: number) => void) | undefined;
	readonly #pending = new Map<string, PendingRequest>();
	#socket: net.Socket | undefined;
	#connectPromise: Promise<void> | undefined;
	#buffer = "";
	#closed = false;

	constructor(projectDir: string, runtimeDir: string, token: string, options: DaemonBrokerClientOptions) {
		this.projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		this.#token = token;
		this.#idleGraceMs = options.idleGraceMs;
		this.#adoptSpawnedPid = options.adoptSpawnedPid;
		this.#cleanupWaitMs = options.cleanupWaitMs;
	}

	async request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		if (signal?.aborted) throw new Error("Daemon broker request aborted");
		await this.#connect();
		const socket = this.#socket;
		if (!socket || socket.destroyed) throw new Error("Daemon broker socket is unavailable");

		const id = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<DaemonRpcResult>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			pending.removeAbort?.();
			reject(new Error(`Daemon ${operation.op} request timed out`));
		}, requestTimeoutMs(operation));
		const pending: PendingRequest = { operation, resolve, reject, timer };
		if (signal) {
			const abort = (): void => {
				if (!this.#pending.delete(id)) return;
				clearTimeout(timer);
				reject(new Error("Daemon broker request aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		socket.write(`${JSON.stringify({ id, token: this.#token, operation })}\n`);
		return promise;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = undefined;
		this.#rejectPending(new Error("Daemon broker client closed"));
	}

	async #connect(): Promise<void> {
		if (this.#socket && !this.#socket.destroyed) return;
		if (this.#connectPromise) return this.#connectPromise;
		this.#connectPromise = this.#connectOnce();
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #connectOnce(): Promise<void> {
		try {
			this.#bindSocket(await openSocket(this.#endpoint, 250));
			return;
		} catch {}
		this.#spawnBroker();
		const deadline = Date.now() + BROKER_CONNECT_TIMEOUT_MS;
		let lastError: Error | undefined;
		while (Date.now() < deadline) {
			try {
				this.#bindSocket(await openSocket(this.#endpoint, 250));
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				await Bun.sleep(CONNECT_RETRY_MS);
			}
		}
		throw new Error(`Failed to start daemon broker: ${lastError?.message ?? "socket unavailable"}`);
	}

	#spawnBroker(): void {
		const spawn = resolveWorkerSpawnCmd(DAEMON_BROKER_WORKER_ARG);
		const overlay: Record<string, string> = {
			[DAEMON_PROJECT_DIR_ENV]: this.projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: this.#runtimeDir,
		};
		if (this.#idleGraceMs !== undefined) overlay[DAEMON_IDLE_GRACE_ENV] = String(this.#idleGraceMs);
		if (this.#cleanupWaitMs !== undefined) overlay[DAEMON_CLEANUP_WAIT_ENV] = String(this.#cleanupWaitMs);
		const child = Bun.spawn(spawn.cmd, {
			cwd: spawn.cwd,
			env: workerEnvFromParent(overlay),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
		});
		this.#adoptSpawnedPid?.(child.pid);
		child.unref();
	}

	#bindSocket(socket: net.Socket): void {
		this.#socket = socket;
		this.#buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(chunk));
		socket.on("error", () => {});
		socket.on("close", () => {
			if (this.#socket === socket) this.#socket = undefined;
			this.#rejectPending(new Error("Daemon broker connection closed"));
		});
	}

	#onData(chunk: string | Buffer): void {
		this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let response: DaemonWireResponse;
			try {
				const decoded: unknown = JSON.parse(line);
				response = parseDaemonWireResponse(decoded);
			} catch (error) {
				this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
				continue;
			}
			const pending = this.#pending.get(response.id);
			if (!pending) continue;
			this.#pending.delete(response.id);
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			if (!response.ok) {
				pending.reject(new Error(response.error));
				continue;
			}
			try {
				pending.resolve(parseDaemonRpcResult(pending.operation, response.result));
			} catch (error) {
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

const sharedClients = new Map<string, Promise<DaemonBrokerClient>>();
let cancelExitCleanup: (() => void) | undefined;

export async function createDaemonBrokerClient(
	projectDir: string,
	options: DaemonBrokerClientOptions = {},
): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = options.runtimeDir ?? daemonRuntimeDir(canonical);
	const token = await readOrCreateToken(runtimeDir);
	return new SocketDaemonClient(canonical, runtimeDir, token, options);
}

export async function daemonClientForProject(
	projectDir: string,
	options: DaemonBrokerClientOptions = {},
): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	let pending = sharedClients.get(canonical);
	if (!pending) {
		const cleanupWaitMs =
			options.cleanupWaitMs ?? (isSettingsInitialized() ? Settings.instance.get("launch.cleanupWaitMs") : undefined);
		pending = createDaemonBrokerClient(canonical, { ...options, cleanupWaitMs });
		sharedClients.set(canonical, pending);
		const attempt = pending;
		void attempt.catch(() => {
			if (sharedClients.get(canonical) === attempt) sharedClients.delete(canonical);
		});
		if (!cancelExitCleanup) {
			cancelExitCleanup = postmortem.register("daemon-broker-clients", () => closeDaemonClients());
		}
	}
	return pending;
}

export async function closeDaemonClients(): Promise<void> {
	const pending = Array.from(sharedClients.values());
	sharedClients.clear();
	for (const result of await Promise.allSettled(pending)) {
		if (result.status === "fulfilled") result.value.close();
	}
	cancelExitCleanup?.();
	cancelExitCleanup = undefined;
}

export async function smokeTestDaemonBroker(): Promise<void> {
	const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-daemon-smoke-project-"));
	const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-daemon-smoke-run-"));
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		const ping = await client.request({ op: "ping" });
		if (ping.op !== "ping" || ping.projectDir !== client.projectDir) throw new Error("daemon broker ping mismatch");
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
		await fs.rm(projectDir, { recursive: true, force: true });
		await fs.rm(runtimeDir, { recursive: true, force: true });
	}
}
