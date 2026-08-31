import { describe, expect, it } from "bun:test";
import { EventStream } from "../src/utils/event-stream";

function makeStream(): EventStream<string, string> {
	return new EventStream(
		event => event === "done",
		event => event,
	);
}

describe("EventStream", () => {
	it("starts with empty queue and not done", () => {
		const stream = makeStream();
		expect(stream.queue).toEqual([]);
		expect(stream.done).toBe(false);
		expect(stream.resultSettled).toBe(false);
	});
	it("push adds events to queue when no waiter", () => {
		const stream = makeStream();
		stream.push("event1");
		stream.push("event2");
		expect(stream.queue).toEqual(["event1", "event2"]);
	});
	it("push with complete event sets done and resultSettled", () => {
		const stream = makeStream();
		stream.push("done");
		expect(stream.done).toBe(true);
		expect(stream.resultSettled).toBe(true);
	});
	it("push after done is ignored", () => {
		const stream = makeStream();
		stream.push("done");
		stream.push("event-after");
		expect(stream.queue).not.toContain("event-after");
	});
	it("result promise resolves when complete event pushed", async () => {
		const stream = makeStream();
		stream.push("done");
		const result = await stream.result();
		expect(result).toBe("done");
	});
	it("end without result rejects result promise", async () => {
		const stream = makeStream();
		stream.end();
		expect(stream.done).toBe(true);
		expect(stream.result()).rejects.toBeDefined();
	});
	it("end with result resolves result promise", async () => {
		const stream = makeStream();
		stream.end("final-result");
		const result = await stream.result();
		expect(result).toBe("final-result");
	});
	it("end resolves waiting iterators with done", async () => {
		const stream = makeStream();
		const iter = stream[Symbol.asyncIterator]();
		const nextPromise = iter.next();
		stream.end();
		const result = await nextPromise;
		expect(result.done).toBe(true);
	});
	it("fail rejects waiting iterators", async () => {
		const stream = makeStream();
		const iter = stream[Symbol.asyncIterator]();
		const nextPromise = iter.next();
		const error = new Error("stream failed");
		stream.fail(error);
		await expect(nextPromise).rejects.toBe(error);
	});
	it("fail sets done and resultSettled", () => {
		const stream = makeStream();
		stream.fail(new Error("fail"));
		expect(stream.done).toBe(true);
		expect(stream.resultSettled).toBe(true);
	});
	it("fail after done is ignored", () => {
		const stream = makeStream();
		stream.push("done");
		stream.fail(new Error("fail"));
		// Should not throw
	});
	it("deliver adds to queue when no waiter", () => {
		const stream = makeStream();
		stream.deliver("event");
		expect(stream.queue).toEqual(["event"]);
	});
	it("endWaiting resolves all waiting with done", async () => {
		const stream = makeStream();
		const iter = stream[Symbol.asyncIterator]();
		const nextPromise = iter.next();
		stream.endWaiting();
		const result = await nextPromise;
		expect(result.done).toBe(true);
	});
	it("hasPendingLocalWork is false initially", () => {
		const stream = makeStream();
		expect(stream.hasPendingLocalWork).toBe(false);
	});
	it("trackLocalWork tracks pending work", async () => {
		const stream = makeStream();
		const { promise, resolve } = Promise.withResolvers<string>();
		const workPromise = stream.trackLocalWork(promise);
		expect(stream.hasPendingLocalWork).toBe(true);
		resolve("done");
		const result = await workPromise;
		expect(result).toBe("done");
		expect(stream.hasPendingLocalWork).toBe(false);
	});
	it("iterates over pushed events", async () => {
		const stream = makeStream();
		stream.push("a");
		stream.push("b");
		stream.push("done");
		const events: string[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		expect(events).toEqual(["a", "b", "done"]);
	});
	it("iterator yields queued events then waits", async () => {
		const stream = makeStream();
		stream.push("queued");
		const iter = stream[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toBe("queued");
		expect(first.done).toBe(false);
		// Now queue is empty, next() will wait
		const secondPromise = iter.next();
		stream.push("delivered");
		const second = await secondPromise;
		expect(second.value).toBe("delivered");
	});
});
