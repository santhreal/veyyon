/**
 * WHY: the speech-to-text, tiny-model and TTS clients each carried a private
 * copy of the same request/teardown skeleton, and one copy could drift: a
 * pending request left unsettled when the worker died hung its caller, and a
 * worker that stayed referenced after its last request kept a one-shot CLI
 * alive. `WorkerRequestClient` is now the single owner of that skeleton, and
 * this suite drives every subclass through the same lifecycle so a subclass
 * that opts out of the base (or a base edit that breaks one hook) turns red.
 *
 * Class closed: every `WorkerRequestClient` subclass in `src/` is enumerated
 * from the tree and each must (1) reference the worker only while a request
 * is in flight, (2) settle every pending request with its own value when the
 * worker errors or the client terminates, emitting an `error` progress event
 * per request, (3) settle an aborted request and ignore its late answer, and
 * (4) let the base consume `log`, `progress` and `pong` without routing them.
 *
 * Not caught: the per-client message routing beyond the shared skeleton
 * (streams, corrupt-cache retry), which `tiny-title-client-worker-recycling`
 * and `tts-client-corrupt-cache-retry` cover.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SttClient } from "@veyyon/coding-agent/speech/stt/asr-client";
import type { SttWorkerInbound, SttWorkerOutbound } from "@veyyon/coding-agent/speech/stt/asr-protocol";
import { TtsClient } from "@veyyon/coding-agent/speech/tts/tts-client";
import type { TtsWorkerInbound, TtsWorkerOutbound } from "@veyyon/coding-agent/speech/tts/tts-protocol";
import type { RefCountedWorkerHandle } from "@veyyon/coding-agent/subprocess/worker-client";
import type { WorkerProgressEvent, WorkerProgressStatus } from "@veyyon/coding-agent/subprocess/worker-request-client";
import { TinyTitleClient } from "@veyyon/coding-agent/tiny/title-client";
import type { TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "@veyyon/coding-agent/tiny/title-protocol";
import * as logger from "@veyyon/utils/logger";

const SRC_ROOT = path.resolve(import.meta.dirname, "../../src");

class FakeWorker<Inbound extends { type: string; id?: string }, Outbound>
	implements RefCountedWorkerHandle<Inbound, Outbound>
{
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	sent: Inbound[] = [];
	#messageHandlers = new Set<(message: Outbound) => void>();
	#errorHandlers = new Set<(error: Error) => void>();

	send(message: Inbound): void {
		this.sent.push(message);
	}

	onMessage(handler: (message: Outbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	/** Id of the last correlated message the client sent. */
	lastId(): string {
		const last = this.sent.at(-1);
		if (!last?.id) throw new Error("the client sent no correlated message");
		return last.id;
	}

	emit(message: Outbound): void {
		for (const handler of this.#messageHandlers) handler(message);
	}

	emitError(error: Error): void {
		for (const handler of this.#errorHandlers) handler(error);
	}
}

type Outcome = { status: "resolved"; value: unknown } | { status: "rejected"; name: string; message: string };

async function outcome(promise: Promise<unknown>): Promise<Outcome> {
	try {
		return { status: "resolved", value: await promise };
	} catch (error) {
		const rejection = error instanceof Error ? error : new Error(String(error));
		return { status: "rejected", name: rejection.name, message: rejection.message };
	}
}

/** One open client on one fake worker, with the client's own request kinds behind a uniform surface. */
interface Harness {
	worker: {
		terminated: boolean;
		refCalls: number;
		unrefCalls: number;
		lastId(): string;
		emitError(error: Error): void;
	};
	terminate(): Promise<void>;
	progress: WorkerProgressEvent<string>[];
	request(signal?: AbortSignal): Promise<unknown>;
	download(): Promise<unknown>;
	answer(id: string): void;
	answerDownload(id: string): void;
	emitLog(msg: string, meta: Record<string, unknown>): void;
	emitProgress(id: string, status: WorkerProgressStatus): void;
	emitPong(id: string): void;
}

/** One subclass and the value each of its request kinds settles to on every exit path. */
interface ClientCase {
	file: string;
	modelKey: string;
	open(): Harness;
	answered: unknown;
	onTerminate: Outcome;
	onWorkerError(error: Error): Outcome;
	onAbort: Outcome;
	downloaded: unknown;
	downloadOnTerminate: unknown;
	downloadOnWorkerError(error: Error): unknown;
}

const aborted: Outcome = { status: "rejected", name: "AbortError", message: "The operation was aborted." };
const pcm = new Float32Array([0.25, -0.25]);

const stt: ClientCase = {
	file: "speech/stt/asr-client.ts",
	modelKey: "turbo",
	open: () => {
		const worker = new FakeWorker<SttWorkerInbound, SttWorkerOutbound>();
		const client = new SttClient(() => worker);
		const progress: WorkerProgressEvent<string>[] = [];
		client.onProgress(event => progress.push(event));
		return {
			worker,
			terminate: () => client.terminate(),
			progress,
			request: signal => client.transcribe("turbo", new Float32Array(16), { signal }),
			download: () => client.downloadModel("turbo"),
			answer: id => worker.emit({ type: "transcription", id, text: "hello" }),
			answerDownload: id => worker.emit({ type: "downloaded", id }),
			emitLog: (msg, meta) => worker.emit({ type: "log", level: "debug", msg, meta }),
			emitProgress: (id, status) => worker.emit({ type: "progress", id, event: { modelKey: "turbo", status } }),
			emitPong: id => worker.emit({ type: "pong", id }),
		};
	},
	answered: "hello",
	onTerminate: { status: "rejected", name: "Error", message: "stt worker terminated" },
	onWorkerError: error => ({ status: "rejected", name: error.name, message: error.message }),
	onAbort: aborted,
	downloaded: { ok: true },
	downloadOnTerminate: { ok: false },
	downloadOnWorkerError: error => ({ ok: false, error: error.message }),
};

const title: ClientCase = {
	file: "tiny/title-client.ts",
	modelKey: "qwen3-1.7b",
	open: () => {
		const worker = new FakeWorker<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>();
		const client = new TinyTitleClient(() => worker);
		const progress: WorkerProgressEvent<string>[] = [];
		client.onProgress(event => progress.push(event));
		return {
			worker,
			terminate: () => client.terminate(),
			progress,
			request: signal => client.complete("qwen3-1.7b", "prompt", { signal }),
			download: () => client.downloadModel("qwen3-1.7b"),
			answer: id => worker.emit({ type: "completion", id, text: "done" }),
			answerDownload: id => worker.emit({ type: "downloaded", id }),
			emitLog: (msg, meta) => worker.emit({ type: "log", level: "debug", msg, meta }),
			emitProgress: (id, status) => worker.emit({ type: "progress", id, event: { modelKey: "qwen3-1.7b", status } }),
			emitPong: id => worker.emit({ type: "pong", id }),
		};
	},
	answered: "done",
	onTerminate: { status: "resolved", value: null },
	onWorkerError: () => ({ status: "resolved", value: null }),
	onAbort: { status: "resolved", value: null },
	downloaded: { ok: true },
	downloadOnTerminate: { ok: false },
	downloadOnWorkerError: error => ({ ok: false, error: error.message }),
};

const tts: ClientCase = {
	file: "speech/tts/tts-client.ts",
	modelKey: "kokoro",
	open: () => {
		const worker = new FakeWorker<TtsWorkerInbound, TtsWorkerOutbound>();
		const client = new TtsClient(() => worker);
		const progress: WorkerProgressEvent<string>[] = [];
		client.onProgress(event => progress.push(event));
		return {
			worker,
			terminate: () => client.terminate(),
			progress,
			request: signal => client.synthesize("kokoro", "hello", { signal }),
			download: () => client.downloadModel("kokoro"),
			answer: id => worker.emit({ type: "audio", id, pcm, sampleRate: 24_000 }),
			answerDownload: id => worker.emit({ type: "downloaded", id }),
			emitLog: (msg, meta) => worker.emit({ type: "log", level: "debug", msg, meta }),
			emitProgress: (id, status) => worker.emit({ type: "progress", id, event: { modelKey: "kokoro", status } }),
			emitPong: id => worker.emit({ type: "pong", id }),
		};
	},
	answered: { pcm, sampleRate: 24_000 },
	onTerminate: { status: "resolved", value: null },
	onWorkerError: () => ({ status: "resolved", value: null }),
	onAbort: { status: "resolved", value: null },
	downloaded: true,
	downloadOnTerminate: false,
	downloadOnWorkerError: () => false,
};

const cases: readonly ClientCase[] = [stt, title, tts];

async function subclassFiles(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		const file = path.join(entry.parentPath, entry.name);
		if ((await fs.readFile(file, "utf8")).includes("extends WorkerRequestClient<")) {
			found.push(path.relative(SRC_ROOT, file).split(path.sep).join("/"));
		}
	}
	return found.sort();
}

describe("every model worker client shares one request lifecycle", () => {
	it("drives every WorkerRequestClient subclass in the tree", async () => {
		expect(await subclassFiles(SRC_ROOT)).toEqual(cases.map(c => c.file).sort());
	});

	for (const c of cases) {
		describe(c.file, () => {
			it("references the worker only while a request is in flight", async () => {
				const h = c.open();
				try {
					const request = h.request();
					expect(h.worker.refCalls).toBe(1);
					expect(h.worker.unrefCalls).toBe(0);
					h.answer(h.worker.lastId());
					expect(await request).toEqual(c.answered);
					expect(h.worker.unrefCalls).toBe(1);
					const download = h.download();
					expect(h.worker.refCalls).toBe(2);
					h.answerDownload(h.worker.lastId());
					expect(await download).toEqual(c.downloaded);
					expect(h.worker.unrefCalls).toBe(2);
				} finally {
					await h.terminate();
				}
			});

			it("settles every pending request, reports error progress and terminates when the worker errors", async () => {
				const h = c.open();
				const warn = spyOn(logger, "warn").mockImplementation(() => {});
				try {
					const request = h.request();
					const download = h.download();
					const error = new Error("subprocess exited with signal SIGKILL");
					h.worker.emitError(error);
					expect(await outcome(request)).toEqual(c.onWorkerError(error));
					expect(await download).toEqual(c.downloadOnWorkerError(error));
					expect(h.progress).toEqual([
						{ modelKey: c.modelKey, status: "error" },
						{ modelKey: c.modelKey, status: "error" },
					]);
					expect(h.worker.terminated).toBe(true);
					expect(warn.mock.calls).toEqual([
						[expect.stringContaining("worker error"), { error: "subprocess exited with signal SIGKILL" }],
					]);
				} finally {
					warn.mockRestore();
					await h.terminate();
				}
			});

			it("settles every pending request and reports error progress when the client terminates", async () => {
				const h = c.open();
				const request = h.request();
				const download = h.download();
				await h.terminate();
				expect(await outcome(request)).toEqual(c.onTerminate);
				expect(await download).toEqual(c.downloadOnTerminate);
				expect(h.progress).toEqual([
					{ modelKey: c.modelKey, status: "error" },
					{ modelKey: c.modelKey, status: "error" },
				]);
				expect(h.worker.terminated).toBe(true);
			});

			it("settles an aborted request, unrefs the worker and ignores the late answer", async () => {
				const h = c.open();
				try {
					const controller = new AbortController();
					const request = h.request(controller.signal);
					const id = h.worker.lastId();
					controller.abort();
					expect(await outcome(request)).toEqual(c.onAbort);
					expect(h.worker.unrefCalls).toBe(1);
					h.answer(id);
					expect(h.worker.unrefCalls).toBe(1);
					expect(h.worker.terminated).toBe(false);
				} finally {
					await h.terminate();
				}
			});

			it("consumes log, progress and pong without touching pending work", async () => {
				const h = c.open();
				const debug = spyOn(logger, "debug").mockImplementation(() => {});
				try {
					const request = h.request();
					const id = h.worker.lastId();
					h.emitLog("loading", { id });
					h.emitProgress(id, "ready");
					h.emitPong(id);
					expect(debug.mock.calls.filter(([message]) => message === "loading")).toEqual([["loading", { id }]]);
					expect(h.progress).toEqual([{ modelKey: c.modelKey, status: "ready" }]);
					expect(h.worker.unrefCalls).toBe(0);
					h.answer(id);
					expect(await request).toEqual(c.answered);
				} finally {
					debug.mockRestore();
					await h.terminate();
				}
			});
		});
	}
});
