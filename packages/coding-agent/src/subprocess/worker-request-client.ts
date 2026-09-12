import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { RefCountedWorkerHandle, WorkerLogMessage } from "./worker-client";
import { logWorkerMessage } from "./worker-log";

/**
 * The parent-side skeleton of a model worker client (speech-to-text, tiny-model
 * titles/completions, TTS): one correlated request map, a monotonically
 * increasing request id, the ref-while-busy rule that keeps a short-lived CLI
 * alive while a request is in flight, the progress fan-out, the model download
 * request and the teardown that settles every pending request.
 *
 * A subclass supplies its message routing (`handleMessage`), how a pending
 * request settles when the worker goes away (`settlePending`), and, when it
 * holds sessions outside the request map, `busy` and `workerLost`.
 */

/** Download/load lifecycle stage a worker reports for a model. */
export type WorkerProgressStatus = "initiate" | "download" | "progress" | "progress_total" | "done" | "ready" | "error";

/** Byte counts of one file inside a multi-file model download. */
export interface WorkerProgressFileState {
	loaded: number;
	total: number;
}

/** One progress report for `modelKey`, as forwarded from the worker. */
export interface WorkerProgressEvent<ModelKey> {
	modelKey: ModelKey;
	status: WorkerProgressStatus;
	name?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
	files?: Record<string, WorkerProgressFileState>;
	task?: string;
	model?: string;
}

/** The outbound union member every model worker uses to forward progress. */
export type WorkerProgressMessage<ModelKey> = { type: "progress"; id: string; event: WorkerProgressEvent<ModelKey> };

/** The outbound members every model worker shares; the base consumes these itself. */
export type WorkerCommonOutbound<ModelKey> =
	| { type: "pong"; id: string }
	| WorkerLogMessage
	| WorkerProgressMessage<ModelKey>;

/** The outbound members a client routes itself: everything in `Outbound` but {@link WorkerCommonOutbound}. */
export type WorkerRoutedOutbound<Outbound, ModelKey> = Exclude<Outbound, WorkerCommonOutbound<ModelKey>>;

export interface WorkerDownloadOptions<ModelKey> {
	signal?: AbortSignal;
	onProgress?: (event: WorkerProgressEvent<ModelKey>) => void;
}

export interface WorkerDownloadResult {
	ok: boolean;
	error?: string;
}

function isWorkerLogMessage(message: { type: string }): message is WorkerLogMessage {
	return message.type === "log";
}

function isWorkerProgressMessage<ModelKey>(message: { type: string }): message is WorkerProgressMessage<ModelKey> {
	return message.type === "progress";
}

function isWorkerPong(message: { type: string }): message is { type: "pong"; id: string } {
	return message.type === "pong";
}

/** How one correlated request is sent and how it settles when its signal fires. */
export interface WorkerRequestSpec<Value, Inbound, Pending> {
	signal?: AbortSignal;
	message: (id: string) => Inbound;
	pending: (resolve: (value: Value) => void, reject: (error: Error) => void) => Pending;
	onAbort: (resolve: (value: Value) => void, reject: (error: Error) => void) => void;
}

/** How a model download request is sent and what it resolves to on abort or failure. */
export interface WorkerDownloadSpec<Result, Inbound, Pending> {
	message: (id: string) => Inbound;
	pending: (resolve: (result: Result) => void) => Pending;
	aborted: Result;
	failed: (message: string) => Result;
}

export abstract class WorkerRequestClient<
	Inbound,
	Routed extends { type: string; id: string },
	ModelKey,
	Pending extends { modelKey: ModelKey },
> {
	#worker: RefCountedWorkerHandle<Inbound, Routed | WorkerCommonOutbound<ModelKey>> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, Pending>();
	#progressListeners = new Set<(event: WorkerProgressEvent<ModelKey>) => void>();
	#nextRequestId = 0;
	#refed = false;
	readonly #label: string;
	readonly #spawnWorker: () => RefCountedWorkerHandle<Inbound, Routed | WorkerCommonOutbound<ModelKey>>;

	constructor(
		label: string,
		spawnWorker: () => RefCountedWorkerHandle<Inbound, Routed | WorkerCommonOutbound<ModelKey>>,
	) {
		this.#label = label;
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: WorkerProgressEvent<ModelKey>) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	/** Route one worker message the base did not consume; `log`, `progress` and `pong` never arrive here. */
	abstract handleMessage(message: Routed): void;

	/**
	 * Settle a request the worker will never answer: `error` is the worker
	 * failure, or `undefined` when the client is being terminated.
	 */
	abstract settlePending(pending: Pending, error: Error | undefined): void;

	/** Whether work outside the request map (a live stream) still needs the worker referenced. */
	busy(): boolean {
		return false;
	}

	/** Called once every pending request is settled; a subclass fails its own sessions here. */
	workerLost(_error: Error | undefined): void {
		// Nothing outside the request map by default.
	}

	/**
	 * Send one correlated request and await its answer. The pending entry is
	 * registered before the send so an answer can never race it; an aborted
	 * signal settles the request through `onAbort` and drops the entry.
	 */
	async request<Value>(spec: WorkerRequestSpec<Value, Inbound, Pending>): Promise<Value> {
		const worker = this.ensureWorker();
		const id = this.nextRequestId();
		const { promise, resolve, reject } = Promise.withResolvers<Value>();
		const pending = spec.pending(resolve, reject);
		this.addPending(id, pending);
		const abort = (): void => {
			if (this.#pending.get(id) !== pending) return;
			this.deletePending(id);
			spec.onAbort(resolve, reject);
		};
		spec.signal?.addEventListener("abort", abort, { once: true });
		try {
			worker.send(spec.message(id));
			return await promise;
		} finally {
			spec.signal?.removeEventListener("abort", abort);
			this.deletePending(id);
		}
	}

	/**
	 * Ask the worker to download `modelKey`, forwarding progress to
	 * `options.onProgress` for the duration. A spawn or send failure resolves
	 * through `spec.failed` after a debug log rather than rejecting.
	 */
	async download<Result>(
		modelKey: ModelKey,
		options: WorkerDownloadOptions<ModelKey>,
		spec: WorkerDownloadSpec<Result, Inbound, Pending>,
	): Promise<Result> {
		if (options.signal?.aborted) return spec.aborted;
		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			return await this.request<Result>({
				signal: options.signal,
				message: spec.message,
				pending: spec.pending,
				onAbort: resolve => resolve(spec.aborted),
			});
		} catch (error) {
			const message = errorMessage(error);
			logger.debug(`${this.#label}: local model download failed`, { modelKey, error: message });
			return spec.failed(message);
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		this.#settleAll(undefined);
		this.#refed = false;
		this.workerLost(undefined);
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	ensureWorker(): RefCountedWorkerHandle<Inbound, Routed | WorkerCommonOutbound<ModelKey>> {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#onMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#onWorkerError(error));
		return worker;
	}

	nextRequestId(): string {
		return String(++this.#nextRequestId);
	}

	getPending(id: string): Pending | undefined {
		return this.#pending.get(id);
	}

	hasPending(id: string): boolean {
		return this.#pending.has(id);
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	addPending(id: string, request: Pending): void {
		this.#pending.set(id, request);
		this.syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	deletePending(id: string): void {
		if (this.#pending.delete(id)) this.syncWorkerRef();
	}

	/**
	 * Workers are spawned `unref`'d so an idle warm model never blocks process
	 * exit; a short-lived CLI command awaiting IPC would otherwise let the event
	 * loop drain before the worker answers, so the worker is referenced exactly
	 * while a request or session is in flight.
	 */
	syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0 || this.busy();
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	emitProgress(event: WorkerProgressEvent<ModelKey>): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	/** Emit the `error` progress for a request the worker failed or abandoned. */
	failProgress(modelKey: ModelKey): void {
		this.emitProgress({ modelKey, status: "error" });
	}

	#onMessage(message: Routed | WorkerCommonOutbound<ModelKey>): void {
		if (isWorkerLogMessage(message)) {
			logWorkerMessage(message);
			return;
		}
		if (isWorkerProgressMessage<ModelKey>(message)) {
			this.emitProgress(message.event);
			return;
		}
		if (isWorkerPong(message)) return;
		this.handleMessage(message);
	}

	#settleAll(error: Error | undefined): void {
		for (const pending of this.#pending.values()) {
			this.failProgress(pending.modelKey);
			this.settlePending(pending, error);
		}
		this.#pending.clear();
	}

	#onWorkerError(error: Error): void {
		logger.warn(`${this.#label}: worker error`, { error: error.message });
		this.#settleAll(error);
		this.workerLost(error);
		void this.terminate();
	}
}
