import { describe, expect, it } from "bun:test";
import { AbortError, abortableSource, lazy, untilAborted } from "../src/abortable";

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

	it("rejects with AbortError carrying the abort reason when the signal fires first", async () => {
		const controller = new AbortController();
		const never = new Promise<number>(() => {});
		const pending = untilAborted(controller.signal, never);
		controller.abort(new Error("watchdog timeout"));
		const error = await pending.then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(AbortError);
		expect((error as Error).message).toBe("Aborted: watchdog timeout");
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

describe("lazy", () => {
	it("builds nothing until the value is read", () => {
		let calls = 0;
		lazy(() => {
			calls += 1;
			return calls;
		});
		expect(calls).toBe(0);
	});

	it("builds on the first read and returns that value on every later read", () => {
		let calls = 0;
		const held = lazy(() => {
			calls += 1;
			return { calls };
		});
		const first = held.value;
		expect(held.value).toBe(first);
		expect(calls).toBe(1);
	});

	it("holds a falsy value without building it again", () => {
		let calls = 0;
		const held = lazy(() => {
			calls += 1;
			return undefined;
		});
		expect(held.value).toBeUndefined();
		expect(held.value).toBeUndefined();
		expect(calls).toBe(1);
	});

	it("builds again after a build that throws", () => {
		let calls = 0;
		const held = lazy(() => {
			calls += 1;
			if (calls === 1) throw new Error("first build fails");
			return calls;
		});
		expect(() => held.value).toThrow("first build fails");
		expect(held.value).toBe(2);
		expect(held.value).toBe(2);
	});
});
