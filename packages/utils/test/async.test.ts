import { describe, expect, it } from "bun:test";
import { AsyncDrain, withTimeout } from "../src/async";

describe("withTimeout", () => {
	it("resolves with the promise value when it settles before the timeout", async () => {
		await expect(withTimeout(Promise.resolve(42), 1000, "too slow")).resolves.toBe(42);
	});

	it("rejects with an Error carrying the message when the timeout fires first", async () => {
		const never = new Promise<number>(() => {});
		await expect(withTimeout(never, 5, "operation timed out")).rejects.toThrow("operation timed out");
	});

	it("propagates the wrapped promise's own rejection when it loses the race", async () => {
		const failing = Promise.reject(new Error("inner failure"));
		await expect(withTimeout(failing, 1000, "too slow")).rejects.toThrow("inner failure");
	});

	it("throws the abort reason immediately when the signal is already aborted", async () => {
		const reason = new Error("caller aborted");
		const signal = AbortSignal.abort(reason);
		await expect(withTimeout(Promise.resolve(1), 1000, "too slow", signal)).rejects.toThrow("caller aborted");
	});
});

describe("AsyncDrain", () => {
	it("coalesces synchronous pushes into one handler call sharing one promise", async () => {
		const drain = new AsyncDrain<number>();
		const batches: number[][] = [];
		const p1 = drain.push(1, values => {
			batches.push([...values]);
		});
		const p2 = drain.push(2, () => {
			throw new Error("second handler must never run — it joins the first batch");
		});
		expect(p1).toBe(p2);
		await p1;
		expect(batches).toEqual([[1, 2]]);
	});

	it("starts a fresh batch after the previous window flushes", async () => {
		const drain = new AsyncDrain<string>();
		const batches: string[][] = [];
		const handler = (values: string[]): void => {
			batches.push([...values]);
		};
		await drain.push("a", handler);
		await drain.push("b", handler);
		expect(batches).toEqual([["a"], ["b"]]);
	});

	it("rejects the returned promise when the handler throws", async () => {
		const drain = new AsyncDrain<number>();
		await expect(
			drain.push(1, () => {
				throw new Error("handler blew up");
			}),
		).rejects.toThrow("handler blew up");
	});

	it("batches pushes that arrive within a positive delay window", async () => {
		const drain = new AsyncDrain<number>(25);
		const batches: number[][] = [];
		const handler = (values: number[]): void => {
			batches.push([...values]);
		};
		const p1 = drain.push(1, handler);
		const p2 = drain.push(2, handler);
		expect(p1).toBe(p2);
		await p1;
		expect(batches).toEqual([[1, 2]]);
	});

	it("awaits the handler's returned promise before the batch promise settles", async () => {
		const drain = new AsyncDrain<number>();
		let handlerDone = false;
		await drain.push(1, async () => {
			await Promise.resolve();
			handlerDone = true;
		});
		expect(handlerDone).toBe(true);
	});
});
