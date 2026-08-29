import { errorMessage, logger } from "@veyyon/utils";
import {
	logWorkerMessage,
	type RefCountedWorkerHandle,
	SMOKE_TEST_TIMEOUT_MS,
	smokeTestWorker,
	wrapRefCountedSubprocess,
} from "../subprocess/worker-client";
import {
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
} from "./models";
import type {
	PendingRequest,
	TinyTitleDownloadOptions,
	TinyTitleDownloadResult,
	TinyTitleGenerateOptions,
} from "./title-client-helpers";

import {
	createTinyTitleSubprocess,
	normalizeTinyTitleGenerateOptions,
	spawnTinyTitleWorker,
} from "./title-client-helpers";
import type { TinyTitleProgressEvent, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

export { tinyWorkerEnv, tinyWorkerEnvOverlay } from "./title-client-helpers";
export { createTinyTitleSubprocess };

export class TinyTitleClient {
	#worker: RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#failedModels = new Set<TinyLocalModelKey>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>;

	constructor(
		spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> = spawnTinyTitleWorker,
	) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "generate", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "generate") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TinyTitleWorkerInbound = options.systemPrompt
					? { type: "generate", id, modelKey, message, systemPrompt: options.systemPrompt }
					: { type: "generate", id, modelKey, message };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-title: local generation failed", {
				modelKey,
				error: errorMessage(error),
			});
			return null;
		}
	}

	async complete(
		modelKey: string,
		prompt: string,
		options: { maxTokens?: number; signal?: AbortSignal } = {},
	): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "complete", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "complete") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "complete", id, modelKey, prompt, maxTokens: options.maxTokens });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: errorMessage(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<TinyTitleDownloadResult> {
		if (!isTinyLocalModelKey(modelKey)) return { ok: false };
		if (options.signal?.aborted) return { ok: false };

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TinyTitleDownloadResult>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve({ ok: false });
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
			const message = errorMessage(error);
			logger.debug("tiny-title: local model download failed", {
				modelKey,
				error: message,
			});
			return { ok: false, error: message };
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
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false });
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {}
	}

	#ensureWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TinyTitleWorkerOutbound): void {
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
		this.#deletePending(message.id);
		if (message.type === "title") {
			if (pending.kind === "generate") pending.resolve(message.title);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve({ ok: true });
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-title: worker returned error", { error: message.error });
		this.#markFailedModel(pending);
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "download") pending.resolve({ ok: false, error: message.error });
		else pending.resolve(null);
		void this.terminate();
	}

	#markFailedModel(pending: PendingRequest): void {
		if (pending.kind === "generate" || pending.kind === "complete") this.#failedModels.add(pending.modelKey);
	}

	#emitProgress(event: TinyTitleProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tiny-title: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false, error: error.message });
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const tinyTitleClient = new TinyTitleClient();

export const tinyModelClient = tinyTitleClient;

export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(
		wrapRefCountedSubprocess<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(
			createTinyTitleSubprocess(),
			"tiny-title",
		),
		"tiny title worker",
		timeoutMs,
	);
}
