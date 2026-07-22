import { errorMessage, logger } from "@veyyon/utils";
import {
	createWorkerSubprocess,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	refCountedUnavailableWorker,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	wrapRefCountedSubprocess,
} from "../subprocess/worker-client";
import { tinyWorkerEnv } from "../tiny/title-client";
import { TTS_WORKER_ARG } from "../worker-args";
import { isCorruptModelCacheError, isTtsLocalModelKey, type TtsLocalModelKey } from "./models";
import type { TtsProgressEvent, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

/** Decoded PCM returned by a local synthesis request. */
export interface TtsAudio {
	pcm: Float32Array;
	sampleRate: number;
}

/**
 * Where a stream session's chunks and terminal events are delivered. Sessions
 * register a thin adapter (not the {@link AudioChunkChannel} itself) so a
 * corrupt-cache failure can be intercepted and retried on a fresh worker
 * before anything reaches the consumer-facing channel.
 */
interface StreamAudioSink {
	push(chunk: TtsAudioChunk): void;
	close(): void;
	fail(error: Error): void;
}

type PendingRequest =
	| {
			kind: "synthesize";
			modelKey: TtsLocalModelKey;
			resolve: (audio: TtsAudio | null) => void;
			/** Worker-reported errors reject so the caller can retry corrupt-cache loads on a fresh worker. */
			reject: (error: Error) => void;
	  }
	| { kind: "download"; modelKey: TtsLocalModelKey; resolve: (ok: boolean) => void }
	| { kind: "stream"; modelKey: TtsLocalModelKey; channel: StreamAudioSink };

export interface TtsSynthesizeOptions {
	voice?: string;
	signal?: AbortSignal;
}

export interface TtsDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsStreamOptions {
	voice?: string;
	signal?: AbortSignal;
}

/** One synthesized segment of a streaming session, in emission order. */
export interface TtsAudioChunk {
	index: number;
	text: string;
	pcm: Float32Array;
	sampleRate: number;
}

/**
 * A live streaming-synthesis session. Feed complete speakable segments with
 * {@link push} (the worker synthesizes each push as-is) and close the input
 * with {@link end}; `chunks` yields each segment's audio as soon as it is
 * ready, then completes once the worker finishes draining the closed input.
 */
export interface TtsStreamHandle {
	push(text: string): void;
	end(): void;
	chunks: AsyncIterableIterator<TtsAudioChunk>;
}

/**
 * Single-producer/single-consumer async queue bridging the worker's IPC
 * `audio-chunk` messages to an async iterator. Chunks pushed while no consumer
 * is awaiting are buffered in order; {@link close} ends the iterator and
 * {@link fail} surfaces an error to the awaiting (or next) consumer.
 */
class AudioChunkChannel {
	#queue: TtsAudioChunk[] = [];
	#waiters: Array<{
		resolve: (result: IteratorResult<TtsAudioChunk>) => void;
		reject: (error: Error) => void;
	}> = [];
	#error: Error | null = null;
	#settled = false;
	#onSettle: (() => void) | undefined;

	constructor(onSettle?: () => void) {
		this.#onSettle = onSettle;
	}

	push(chunk: TtsAudioChunk): void {
		if (this.#settled) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve({ value: chunk, done: false });
		else this.#queue.push(chunk);
	}

	close(): void {
		this.#settle(null);
	}

	fail(error: Error): void {
		this.#settle(error);
	}

	#settle(error: Error | null): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#error = error;
		for (const waiter of this.#waiters) {
			if (error) waiter.reject(error);
			else waiter.resolve({ value: undefined, done: true });
		}
		this.#waiters = [];
		this.#onSettle?.();
	}

	async *iterator(): AsyncIterableIterator<TtsAudioChunk> {
		while (true) {
			const buffered = this.#queue.shift();
			if (buffered) {
				yield buffered;
				continue;
			}
			if (this.#error) throw this.#error;
			if (this.#settled) return;
			const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<TtsAudioChunk>>();
			this.#waiters.push({ resolve, reject });
			const result = await promise;
			if (result.done) return;
			yield result.value;
		}
	}
}

/**
 * Hidden subcommand on the main CLI that boots the TTS worker in the spawned
 * subprocess. Kept in sync with the dispatch in `cli.ts` (Main-owned).
 */

/**
 * Spawn the TTS worker as a subprocess. Exported for tests and the smoke probe;
 * production callers go through {@link spawnTtsWorker}.
 */
export function createTtsSubprocess(): SpawnedSubprocess<TtsWorkerOutbound> {
	return createWorkerSubprocess<TtsWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TTS_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tts subprocess",
	});
}

function spawnTtsWorker(): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapRefCountedSubprocess<TtsWorkerInbound, TtsWorkerOutbound>(createTtsSubprocess(), "tts"),
		error => refCountedUnavailableWorker<TtsWorkerInbound, TtsWorkerOutbound>(error),
		"TTS worker spawn failed; local TTS disabled",
	);
}

export class TtsClient {
	#worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#progressListeners = new Set<(event: TtsProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>;

	constructor(spawnWorker: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> = spawnTtsWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TtsProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async synthesize(modelKey: string, text: string, options: TtsSynthesizeOptions = {}): Promise<TtsAudio | null> {
		if (!isTtsLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		for (let attempt = 0; ; attempt++) {
			try {
				return await this.#synthesizeOnce(modelKey, text, options);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				// Same recovery as synthesizeStream: the failed worker process has
				// the corrupt weight bytes memoized, so retry once on a fresh one.
				if (attempt === 0 && isCorruptModelCacheError(err) && options.signal?.aborted !== true) {
					logger.warn("tts: synthesis hit corrupt cached weights; restarting the TTS worker and retrying", {
						modelKey,
						error: err.message,
					});
					await this.terminate();
					continue;
				}
				logger.debug("tts: local synthesis failed", { modelKey, error: err.message });
				return null;
			}
		}
	}

	async #synthesizeOnce(
		modelKey: TtsLocalModelKey,
		text: string,
		options: TtsSynthesizeOptions,
	): Promise<TtsAudio | null> {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<TtsAudio | null>();
		this.#addPending(id, { kind: "synthesize", modelKey, resolve, reject });
		const abort = (): void => {
			const pending = this.#pending.get(id);
			if (pending?.kind !== "synthesize") return;
			this.#deletePending(id);
			pending.resolve(null);
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			const request: TtsWorkerInbound = options.voice
				? { type: "synthesize", id, modelKey, text, voice: options.voice }
				: { type: "synthesize", id, modelKey, text };
			worker.send(request);
			return await promise;
		} finally {
			options.signal?.removeEventListener("abort", abort);
			this.#deletePending(id);
		}
	}

	/**
	 * Open a streaming-synthesis session. Complete speakable segments are fed
	 * through the returned handle's `push`/`end`; audio is emitted one segment
	 * at a time via `chunks`, so playback can begin before the full text is
	 * known. Returns an inert handle (immediately-ended `chunks`) for unknown
	 * models or an already-aborted signal, and fails the iterator if the worker
	 * cannot spawn.
	 */
	synthesizeStream(modelKey: string, options: TtsStreamOptions = {}): TtsStreamHandle {
		if (!isTtsLocalModelKey(modelKey) || options.signal?.aborted) {
			const channel = new AudioChunkChannel();
			channel.close();
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		const signal = options.signal;
		let closed = false;
		let ended = false;
		let chunksEmitted = 0;
		let corruptCacheRetriesLeft = 1;
		const segments: string[] = [];
		let activeWorker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> | null = null;
		let activeId: string | null = null;

		const abort = (): void => {
			if (closed) return;
			closed = true;
			ended = true;
			if (activeId !== null && this.#pending.has(activeId)) {
				this.#deletePending(activeId);
				activeWorker?.send({ type: "stream-cancel", id: activeId });
			}
			channel.close();
		};
		const channel = new AudioChunkChannel(() => signal?.removeEventListener("abort", abort));

		// The session's audio routes through this sink so a corrupt-cache model
		// load can be retried transparently. The failed worker process has the
		// corrupt weight bytes memoized in its module state, so even after the
		// worker purges and re-downloads the file, every in-process load keeps
		// failing (observed live) — only a fresh subprocess recovers. Retry once,
		// and only before any audio was delivered: replaying after a partial
		// stream would speak duplicate segments.
		const sink: StreamAudioSink = {
			push: chunk => {
				chunksEmitted += 1;
				channel.push(chunk);
			},
			close: () => channel.close(),
			fail: error => {
				if (corruptCacheRetriesLeft > 0 && chunksEmitted === 0 && !closed && isCorruptModelCacheError(error)) {
					corruptCacheRetriesLeft -= 1;
					logger.warn(
						"tts: model load hit corrupt cached weights; restarting the TTS worker and replaying the stream",
						{
							modelKey,
							error: error.message,
						},
					);
					// #handleMessage terminates the client right after failing us;
					// terminating here first makes that call a no-op (the sync prefix
					// nulls #worker), so the respawn below starts from a clean slate.
					void this.terminate().then(() => {
						if (closed) return;
						const startError = startAttempt();
						if (startError) channel.fail(startError);
					});
					return;
				}
				channel.fail(error);
			},
		};

		const startAttempt = (): Error | null => {
			let worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>;
			try {
				worker = this.#ensureWorker();
			} catch (error) {
				return error instanceof Error ? error : new Error(String(error));
			}
			const id = String(++this.#nextRequestId);
			activeWorker = worker;
			activeId = id;
			this.#addPending(id, { kind: "stream", modelKey, channel: sink });
			const start: TtsWorkerInbound = options.voice
				? { type: "stream-start", id, modelKey, voice: options.voice }
				: { type: "stream-start", id, modelKey };
			worker.send(start);
			for (const text of segments) worker.send({ type: "stream-push", id, text });
			if (ended) worker.send({ type: "stream-end", id });
			return null;
		};

		const firstStartError = startAttempt();
		if (firstStartError) {
			logger.debug("tts: stream synthesis failed to start", { modelKey, error: firstStartError.message });
			channel.fail(firstStartError);
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}
		signal?.addEventListener("abort", abort, { once: true });

		return {
			push: (text: string) => {
				if (closed || ended) return;
				segments.push(text);
				if (activeId !== null) activeWorker?.send({ type: "stream-push", id: activeId, text });
			},
			end: () => {
				if (closed || ended) return;
				ended = true;
				if (activeId !== null) activeWorker?.send({ type: "stream-end", id: activeId });
			},
			chunks: channel.iterator(),
		};
	}

	async downloadModel(modelKey: string, options: TtsDownloadOptions = {}): Promise<boolean> {
		if (!isTtsLocalModelKey(modelKey)) return false;
		if (options.signal?.aborted) return false;

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve(false);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tts: local model download failed", {
				modelKey,
				error: errorMessage(error),
			});
			return false;
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
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.close();
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * The TTS subprocess is spawned `unref`'d so an idle worker never blocks
	 * process exit. A short-lived CLI command (`veyyon say`) awaiting a request would
	 * otherwise let the event loop drain and exit before the audio arrives, so we
	 * `ref` the worker exactly while at least one request is pending.
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TtsWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;

		// Streaming chunks are non-terminal: keep the session registered until
		// `stream-done` (or an error) so later chunks still route to its channel.
		if (message.type === "audio-chunk") {
			if (pending.kind === "stream") {
				pending.channel.push({
					index: message.index,
					text: message.text,
					pcm: message.pcm,
					sampleRate: message.sampleRate,
				});
			}
			return;
		}

		this.#deletePending(message.id);
		if (message.type === "stream-done") {
			if (pending.kind === "stream") pending.channel.close();
			return;
		}
		if (message.type === "audio") {
			if (pending.kind === "synthesize") pending.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve(true);
			return;
		}
		logger.debug("tts: worker returned error", { error: message.error });
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "synthesize") pending.reject(new Error(message.error));
		else if (pending.kind === "download") pending.resolve(false);
		else pending.channel.fail(new Error(message.error));
		void this.terminate();
	}

	#emitProgress(event: TtsProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tts: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.fail(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const ttsClient = new TtsClient();

export async function shutdownTtsClient(): Promise<void> {
	await ttsClient.terminate();
}

export async function smokeTestTtsWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(
		wrapRefCountedSubprocess<TtsWorkerInbound, TtsWorkerOutbound>(createTtsSubprocess(), "tts"),
		"tts worker",
		timeoutMs,
	);
}
