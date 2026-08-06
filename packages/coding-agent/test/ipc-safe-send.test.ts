import { afterEach, describe, expect, it, vi } from "bun:test";
import { safeSend } from "@veyyon/coding-agent/utils/ipc";
import { logger } from "@veyyon/utils";

/**
 * Contract for issue #2997: `safeSend` wraps `Subprocess.send()` so neither a
 * synchronous throw ("cannot be used after the process has exited") nor an
 * asynchronous EPIPE rejection (pipe broke between exit being observed and the
 * next send) can escape and crash the session via the global `unhandledRejection`
 * handler. The dead worker is detected separately via `onExit`; the send itself
 * must be fire-and-forget-safe.
 */
describe("safeSend", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("calls send with the message on the happy path", () => {
		const sent: unknown[] = [];
		const proc = { send: (m: unknown) => sent.push(m) };
		safeSend(proc, { type: "ping" }, "test");
		expect(sent).toEqual([{ type: "ping" }]);
	});

	// WHY the absence of a throw is not the whole contract: a send that fails
	// silently is the same defect wearing different clothes. The caller is
	// fire-and-forget, so the debug line carrying the label and the provider's
	// own message is the only record the failure happened at all.
	it("swallows a synchronous throw and records it under the caller's label", () => {
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const proc = {
			send: () => {
				throw new Error("Subprocess.send() cannot be used after the process has exited.");
			},
		};

		safeSend(proc, {}, "tts");

		expect(debug).toHaveBeenCalledTimes(1);
		expect(debug.mock.calls[0]?.[0]).toBe("tts: send to subprocess failed");
		expect(debug.mock.calls[0]?.[1]).toEqual({
			error: "Subprocess.send() cannot be used after the process has exited.",
		});
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

	it("neutralizes a resolved thenable without swallowing the message or logging a failure", async () => {
		// An async `send` that SUCCEEDS must still deliver, and must not be
		// reported as a failure: the `.then(undefined, noop)` guard attaches a
		// rejection handler and nothing else.
		const sent: unknown[] = [];
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const proc = {
			send: (m: unknown) => {
				sent.push(m);
				return Promise.resolve(undefined);
			},
		};

		safeSend(proc, { type: "ping" }, "test");
		// Drain the microtask queue so a stray rejection would surface.
		await Promise.resolve();
		await Promise.resolve();

		expect(sent).toEqual([{ type: "ping" }]);
		expect(debug).not.toHaveBeenCalled();
	});
});
