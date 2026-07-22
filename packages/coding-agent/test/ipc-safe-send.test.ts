import { describe, expect, it } from "bun:test";
import { isThenable, safeSend } from "@veyyon/coding-agent/utils/ipc";

/**
 * Contract for issue #2997: `safeSend` wraps `Subprocess.send()` so neither a
 * synchronous throw ("cannot be used after the process has exited") nor an
 * asynchronous EPIPE rejection (pipe broke between exit being observed and the
 * next send) can escape and crash the session via the global `unhandledRejection`
 * handler. The dead worker is detected separately via `onExit`; the send itself
 * must be fire-and-forget-safe.
 */
describe("safeSend", () => {
	it("calls send with the message on the happy path", () => {
		const sent: unknown[] = [];
		const proc = { send: (m: unknown) => sent.push(m) };
		safeSend(proc, { type: "ping" }, "test");
		expect(sent).toEqual([{ type: "ping" }]);
	});

	it("swallows a synchronous throw without rethrowing", () => {
		const proc = {
			send: () => {
				throw new Error("Subprocess.send() cannot be used after the process has exited.");
			},
		};
		expect(() => safeSend(proc, {}, "test")).not.toThrow();
	});

	it("neutralizes a rejected thenable returned by send so it cannot become an unhandled rejection", async () => {
		const epipe = Object.assign(new Error("EPIPE: broken pipe, send"), { code: "EPIPE", syscall: "send" });
		const proc = { send: () => Promise.reject(epipe) };
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			safeSend(proc, {}, "test");
			// Drain the microtask queue deterministically (two microtask ticks:
			// one for the promise rejection, one for the .then(noop) handler).
			await Promise.resolve();
			await Promise.resolve();
			expect(unhandled).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("neutralizes a resolved thenable without affecting the happy path", async () => {
		const proc = { send: () => Promise.resolve(undefined) };
		expect(() => safeSend(proc, {}, "test")).not.toThrow();
		// Drain the microtask queue so a stray rejection would surface.
		await Promise.resolve();
		await Promise.resolve();
	});
});

/**
 * isThenable is the promise-detection guard safeSend and the IPC layer use to decide whether a
 * send result needs a `.catch` attached (an async rejection to swallow) versus a plain synchronous
 * return. It had no direct test. It must accept a real Promise, a bare thenable object, AND a
 * callable that also carries a `then` (functions are objects), while rejecting null/undefined
 * (the `!= null` guard), plain objects, and an object whose `then` is not callable. A regression
 * that treated a non-thenable as thenable would attach `.catch` to `undefined` and throw; one that
 * missed a real thenable would let its rejection escape to `unhandledRejection`.
 */
describe("isThenable", () => {
	// Attach the property through a variable key so the identifier `then` never
	// appears statically (biome's noThenProperty lint rejects a literal `then`).
	const thenKey = "then";
	const withThen = (value: unknown): Record<string, unknown> => {
		const target: Record<string, unknown> = {};
		target[thenKey] = value;
		return target;
	};

	it("accepts a real Promise, a bare thenable object, and a callable carrying then", () => {
		expect(isThenable(Promise.resolve(1))).toBe(true);
		expect(isThenable(withThen(() => {}))).toBe(true);
		const callableThenable = Object.assign(() => {}, {}) as (() => void) & Record<string, unknown>;
		callableThenable[thenKey] = () => {};
		expect(isThenable(callableThenable)).toBe(true);
	});

	it("rejects null and undefined", () => {
		expect(isThenable(null)).toBe(false);
		expect(isThenable(undefined)).toBe(false);
	});

	it("rejects a plain object and a primitive", () => {
		expect(isThenable({})).toBe(false);
		expect(isThenable(5)).toBe(false);
	});

	it("rejects an object whose then is not a function", () => {
		expect(isThenable(withThen(5))).toBe(false);
	});
});
