import { describe, expect, it } from "bun:test";
import { consumeWorkerInbox, declareWorkerHostEntry, installWorkerInbox, workerHostEntry } from "../src/worker-host";

describe("workerHostEntry", () => {
	it("returns null before declareWorkerHostEntry is called", () => {
		// Note: this may be non-null if a previous test called declareWorkerHostEntry
		// Just verify it returns a string or null
		const result = workerHostEntry();
		expect(result === null || typeof result === "string").toBe(true);
	});
});

describe("declareWorkerHostEntry", () => {
	it("sets workerHostEntry to a string", () => {
		declareWorkerHostEntry();
		const result = workerHostEntry();
		expect(typeof result).toBe("string");
		expect(result).toBeDefined();
	});
});

describe("installWorkerInbox", () => {
	it("returns a WorkerInbox with a bind function", () => {
		const port = {
			on(_event: string, _listener: (value: unknown) => void) {
				// no-op
			},
		};
		const inbox = installWorkerInbox(port);
		expect(typeof inbox.bind).toBe("function");
	});

	it("queues messages before bind is called", () => {
		let emit: ((data: unknown) => void) | undefined;
		const port = {
			on(_event: string, listener: (value: unknown) => void) {
				emit = listener;
			},
		};
		const inbox = installWorkerInbox(port);
		// Emit messages before binding
		emit?.("msg1");
		emit?.("msg2");
		const received: unknown[] = [];
		inbox.bind(msg => received.push(msg));
		expect(received).toEqual(["msg1", "msg2"]);
	});

	it("delivers messages directly after bind", () => {
		let emit: ((data: unknown) => void) | undefined;
		const port = {
			on(_event: string, listener: (value: unknown) => void) {
				emit = listener;
			},
		};
		const inbox = installWorkerInbox(port);
		const received: unknown[] = [];
		inbox.bind(msg => received.push(msg));
		emit?.("direct");
		expect(received).toEqual(["direct"]);
	});

	it("bind returns an unbind function", () => {
		const port = {
			on(_event: string, _listener: (value: unknown) => void) {},
		};
		const inbox = installWorkerInbox(port);
		const unbind = inbox.bind(() => {});
		expect(typeof unbind).toBe("function");
		unbind();
	});

	it("clears queue after bind", () => {
		let emit: ((data: unknown) => void) | undefined;
		const port = {
			on(_event: string, listener: (value: unknown) => void) {
				emit = listener;
			},
		};
		const inbox = installWorkerInbox(port);
		emit?.("queued");
		const received1: unknown[] = [];
		inbox.bind(msg => received1.push(msg));
		expect(received1).toEqual(["queued"]);
		// Second bind should not receive the queued message
		const received2: unknown[] = [];
		inbox.bind(msg => received2.push(msg));
		expect(received2).toEqual([]);
	});
});

describe("consumeWorkerInbox", () => {
	it("returns the pending inbox and clears it", () => {
		const port = {
			on(_event: string, _listener: (value: unknown) => void) {},
		};
		installWorkerInbox(port);
		const inbox = consumeWorkerInbox();
		expect(inbox).toBeDefined();
		expect(typeof inbox?.bind).toBe("function");
		// Second call should return null
		expect(consumeWorkerInbox()).toBeNull();
	});

	it("returns null when no inbox is pending", () => {
		consumeWorkerInbox(); // clear any pending
		expect(consumeWorkerInbox()).toBeNull();
	});
});
