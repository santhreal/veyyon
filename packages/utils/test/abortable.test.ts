import { describe, expect, it } from "bun:test";
import { AbortError, abortableSource, once, untilAborted } from "../src/abortable";

function chunkStream(chunks: readonly string[]): ReadableStream<string> {
	return new ReadableStream<string>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("abortableSource", () => {
	it("yields every chunk in order on natural EOF", async () => {
		const seen: string[] = [];
		for await (const chunk of abortableSource(chunkStream(["a", "b", "c"]))) seen.push(chunk);
		expect(seen).toEqual(["a", "b", "c"]);
	});

	it("throws AbortError immediately for a pre-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort(new Error("watchdog timeout"));
		const iterate = async () => {
			for await (const _ of abortableSource(chunkStream(["a"]), controller.signal)) {
				// unreachable
			}
		};
		const error = await iterate().catch(e => e);
		expect(error).toBeInstanceOf(AbortError);
		expect((error as Error).message).toBe("Aborted: watchdog timeout");
	});

	it("cancels the source when aborted mid-iteration", async () => {
		let cancelled = false;
		const controller = new AbortController();
		const stream = new ReadableStream<string>({
			pull(streamController) {
				streamController.enqueue("chunk");
			},
			cancel() {
				cancelled = true;
			},
		});
		const iterate = async () => {
			for await (const _ of abortableSource(stream, controller.signal)) {
				controller.abort();
			}
		};
		await expect(iterate()).rejects.toBeInstanceOf(AbortError);
		expect(cancelled).toBe(true);
	});

	it("cancels the source on early break so the backend request stops", async () => {
		let cancelled = false;
		const stream = new ReadableStream<string>({
			pull(controller) {
				controller.enqueue("chunk");
			},
			cancel() {
				cancelled = true;
			},
		});
		for await (const _ of abortableSource(stream)) break;
		expect(cancelled).toBe(true);
	});
});

describe("untilAborted", () => {
	it("passes through resolution and rejection when no signal is given", async () => {
		await expect(untilAborted(undefined, Promise.resolve(7))).resolves.toBe(7);
		await expect(untilAborted(null, () => Promise.reject(new Error("inner")))).rejects.toThrow("inner");
	});

	it("rejects with AbortError when the signal fires before the promise settles", async () => {
		const controller = new AbortController();
		const never = new Promise<number>(() => {});
		const pending = untilAborted(controller.signal, never);
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(AbortError);
	});

	it("rejects immediately for an already-aborted signal without calling the thunk", async () => {
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const pending = untilAborted(controller.signal, () => {
			called = true;
			return Promise.resolve(1);
		});
		await expect(pending).rejects.toBeInstanceOf(AbortError);
		expect(called).toBe(false);
	});
});

describe("once", () => {
	it("calls the function a single time and caches the value", () => {
		let calls = 0;
		const memo = once(() => {
			calls += 1;
			return { calls };
		});
		const first = memo();
		expect(memo()).toBe(first);
		expect(calls).toBe(1);
	});

	it("caches falsy results too", () => {
		let calls = 0;
		const memo = once(() => {
			calls += 1;
			return undefined;
		});
		expect(memo()).toBeUndefined();
		expect(memo()).toBeUndefined();
		expect(calls).toBe(1);
	});
});
