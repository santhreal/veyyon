import { describe, expect, it } from "bun:test";
import { EventStream } from "../src/utils/event-stream";

describe("EventStream iterator cleanup", () => {
	it("removes waiter when iterator is returned early while awaiting next item", async () => {
		const stream = new EventStream<string, string>(
			event => event === "done",
			event => event,
		);

		const iterator = stream[Symbol.asyncIterator]();
		// Start awaiting next item (queue is empty, so it registers a waiter)
		const nextPromise = iterator.next();
		expect(stream.waiting.length).toBe(1);

		// Consumer abandons the iteration early (e.g. break or timeout)
		await iterator.return?.();
		expect(stream.waiting.length).toBe(0);
		// The pending next() settles as done instead of hanging behind the return.
		expect(await nextPromise).toEqual({ value: undefined, done: true });

		// Next consumer or event pushed should not be delivered to the abandoned waiter
		stream.push("first-real-event");
		expect(stream.queue).toEqual(["first-real-event"]);

		// A subsequent consumer can read the queued event
		const secondIterator = stream[Symbol.asyncIterator]();
		const result = await secondIterator.next();
		expect(result).toEqual({ value: "first-real-event", done: false });
	});

	it("cleans up waiter when breaking out of a for-await loop", async () => {
		const stream = new EventStream<string, string>(
			event => event === "done",
			event => event,
		);

		stream.push("first");
		for await (const item of stream) {
			expect(item).toBe("first");
			break;
		}
		expect(stream.waiting.length).toBe(0);

		stream.push("second");
		const secondIterator = stream[Symbol.asyncIterator]();
		const result = await secondIterator.next();
		expect(result).toEqual({ value: "second", done: false });
	});

	it("wakes pending waiter when iterator.throw is called", async () => {
		const stream = new EventStream<string, string>(
			event => event === "done",
			event => event,
		);

		const iterator = stream[Symbol.asyncIterator]();
		const nextPromise = iterator.next();
		nextPromise.catch(() => {});
		expect(stream.waiting.length).toBe(1);

		const err = new Error("aborted");
		await expect(iterator.throw?.(err)).rejects.toThrow("aborted");
		expect(stream.waiting.length).toBe(0);
	});
});
