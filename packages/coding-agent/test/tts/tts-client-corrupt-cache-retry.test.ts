/**
 * Corrupt-cache recovery in TtsClient: a worker that fails a model load on
 * corrupt cached weights has the bad bytes memoized process-wide (proven live
 * — an in-process purge+re-download retry still fails, a fresh process with
 * the same file succeeds), so the client must restart the worker subprocess
 * and retry/replay once. Non-corrupt errors must NOT retry.
 */
import { describe, expect, it } from "bun:test";
import type { RefCountedWorkerHandle } from "../../src/subprocess/worker-client";
import { TtsClient } from "../../src/tts/tts-client";
import type { TtsWorkerInbound, TtsWorkerOutbound } from "../../src/tts/tts-protocol";

const CORRUPT_ERROR =
	"Load model from /cache/tiny-models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx failed:Protobuf parsing failed.";

/**
 * Fake worker whose behavior is scripted per spawned instance: `respond` is
 * called for every inbound message with an emit callback for outbound ones.
 */
function makeFakeWorkerFactory(
	respondForSpawn: (spawnIndex: number) => (message: TtsWorkerInbound, emit: (m: TtsWorkerOutbound) => void) => void,
): { spawn: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>; spawns: () => number } {
	let spawnCount = 0;
	const spawn = (): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> => {
		const respond = respondForSpawn(spawnCount++);
		const listeners = new Set<(message: TtsWorkerOutbound) => void>();
		return {
			send(message) {
				// Async like real IPC so the caller finishes registering pendings.
				queueMicrotask(() => {
					respond(message, m => {
						for (const listener of listeners) listener(m);
					});
				});
			},
			onMessage(handler) {
				listeners.add(handler);
				return () => listeners.delete(handler);
			},
			onError() {
				return () => {};
			},
			async terminate() {},
			ref() {},
			unref() {},
		};
	};
	return { spawn, spawns: () => spawnCount };
}

describe("TtsClient corrupt-cache recovery", () => {
	it("synthesize retries once on a fresh worker after a corrupt-cache error", async () => {
		const factory = makeFakeWorkerFactory(spawnIndex => (message, emit) => {
			if (message.type !== "synthesize") return;
			if (spawnIndex === 0) emit({ type: "error", id: message.id, error: CORRUPT_ERROR });
			else emit({ type: "audio", id: message.id, pcm: new Float32Array([0.25]), sampleRate: 24_000 });
		});
		const client = new TtsClient(factory.spawn);
		const audio = await client.synthesize("kokoro", "hello");
		expect(audio).not.toBeNull();
		expect(audio!.sampleRate).toBe(24_000);
		expect(Array.from(audio!.pcm)).toEqual([0.25]);
		expect(factory.spawns()).toBe(2);
		await client.terminate();
	});

	it("synthesize does not retry a non-corrupt worker error", async () => {
		const factory = makeFakeWorkerFactory(() => (message, emit) => {
			if (message.type !== "synthesize") return;
			emit({ type: "error", id: message.id, error: "No TTS devices configured" });
		});
		const client = new TtsClient(factory.spawn);
		const audio = await client.synthesize("kokoro", "hello");
		expect(audio).toBeNull();
		expect(factory.spawns()).toBe(1);
		await client.terminate();
	});

	it("synthesize gives up after the second corrupt-cache failure", async () => {
		const factory = makeFakeWorkerFactory(() => (message, emit) => {
			if (message.type !== "synthesize") return;
			emit({ type: "error", id: message.id, error: CORRUPT_ERROR });
		});
		const client = new TtsClient(factory.spawn);
		const audio = await client.synthesize("kokoro", "hello");
		expect(audio).toBeNull();
		expect(factory.spawns()).toBe(2);
		await client.terminate();
	});

	it("synthesizeStream replays pushed segments on a fresh worker after a corrupt-cache error", async () => {
		const seenByFreshWorker: TtsWorkerInbound[] = [];
		const factory = makeFakeWorkerFactory(spawnIndex => {
			if (spawnIndex === 0) {
				return (message, emit) => {
					if (message.type === "stream-start") {
						emit({ type: "error", id: message.id, error: CORRUPT_ERROR });
					}
				};
			}
			const pushed: string[] = [];
			return (message, emit) => {
				seenByFreshWorker.push(message);
				if (message.type === "stream-push") pushed.push(message.text);
				if (message.type === "stream-end") {
					pushed.forEach((text, index) => {
						emit({
							type: "audio-chunk",
							id: message.id,
							index,
							text,
							pcm: new Float32Array([index]),
							sampleRate: 24_000,
						});
					});
					emit({ type: "stream-done", id: message.id });
				}
			};
		});
		const client = new TtsClient(factory.spawn);
		const stream = client.synthesizeStream("kokoro");
		stream.push("first segment.");
		stream.push("second segment.");
		stream.end();
		const chunks: string[] = [];
		for await (const chunk of stream.chunks) chunks.push(chunk.text);
		expect(chunks).toEqual(["first segment.", "second segment."]);
		expect(factory.spawns()).toBe(2);
		// The fresh worker got the full session replayed: start, both pushes, end.
		expect(seenByFreshWorker.map(m => m.type)).toEqual(["stream-start", "stream-push", "stream-push", "stream-end"]);
		await client.terminate();
	});

	it("synthesizeStream fails the iterator on a non-corrupt error without respawning", async () => {
		const factory = makeFakeWorkerFactory(() => (message, emit) => {
			if (message.type === "stream-start") {
				emit({ type: "error", id: message.id, error: "No TTS devices configured" });
			}
		});
		const client = new TtsClient(factory.spawn);
		const stream = client.synthesizeStream("kokoro");
		stream.push("hello.");
		stream.end();
		await expect(async () => {
			for await (const _chunk of stream.chunks) {
				// consume
			}
		}).toThrow("No TTS devices configured");
		expect(factory.spawns()).toBe(1);
		await client.terminate();
	});
});
