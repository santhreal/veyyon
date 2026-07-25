/**
 * An MCP deadline is told apart from a user cancellation by the ERROR, not by
 * reading two signals after the fact.
 *
 * WHY THIS SUITE EXISTS. `createMCPTimeout` fired a bare `abortController.abort()`,
 * which raises the platform's generic "AbortError" with nothing on it to say
 * which of the two things happened. The only distinction left was an inference
 * over state: `isAbortError(error) && ourSignal.aborted && !callersSignal.aborted`.
 * That is correct only while the two never overlap. They do overlap: a user
 * pressing Ctrl-C microseconds before the timer leaves BOTH signals aborted, and
 * the check reads it as a timeout. The three HTTP and four SSE call sites act on
 * the answer, retrying and reporting "server did not respond in time" for work
 * the user deliberately stopped.
 *
 * The abort now carries a `TimeoutError`-named reason, so the error itself
 * answers the question wherever it is caught. The signal inference stays as an
 * explicitly narrow second test for transports that swallow the reason and throw
 * their own generic AbortError, which the MCP SDK's fetch wrappers do; it is
 * documented at the call site rather than being the whole mechanism.
 */
import { describe, expect, test } from "bun:test";
import { createMCPTimeout } from "@veyyon/coding-agent/mcp/timeout";
import { isAbortError, isCancellation, isTimeoutError } from "@veyyon/utils";

/** Wait for a signal to abort, then hand back its reason. */
function reasonAfterAbort(signal: AbortSignal): Promise<unknown> {
	if (signal.aborted) return Promise.resolve(signal.reason);
	return new Promise(resolve => {
		signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
	});
}

describe("createMCPTimeout aborts with a named reason", () => {
	/**
	 * The fix itself. A caller that reads `signal.reason` (which is what fetch
	 * rejects with) gets an error that says it was a deadline.
	 */
	test("the abort reason is a TimeoutError naming the limit", async () => {
		const operation = createMCPTimeout(5);
		const reason = await reasonAfterAbort(operation.signal!);
		operation.clear();

		expect(isTimeoutError(reason)).toBe(true);
		expect(isCancellation(reason)).toBe(true);
		expect((reason as Error).name).toBe("TimeoutError");
		expect((reason as Error).message).toBe("MCP call exceeded 5ms");
	});

	/** The reason classifies as a timeout, never as a plain cancellation. */
	test("the reason is not mistaken for a user abort", async () => {
		const operation = createMCPTimeout(5);
		const reason = await reasonAfterAbort(operation.signal!);
		operation.clear();

		expect(isAbortError(reason)).toBe(false);
		expect(operation.isTimeoutAbort(reason)).toBe(true);
	});

	/**
	 * The race that the old signal inference got wrong: both signals aborted.
	 * The error still says which one it was, so a user cancellation is not
	 * reported to them as a server timeout.
	 */
	test("a user abort racing the deadline still classifies as a cancellation", async () => {
		const caller = new AbortController();
		const operation = createMCPTimeout(50, caller.signal);
		const userError = new DOMException("cancelled by the user", "AbortError");
		caller.abort(userError);
		await Bun.sleep(80); // let the deadline fire too
		operation.clear();

		expect(caller.signal.aborted).toBe(true);
		expect(operation.isTimeoutAbort(userError)).toBe(false);
		expect(isAbortError(userError)).toBe(true);
	});

	/**
	 * The documented narrow second test. A transport that swallows the reason and
	 * throws its own generic AbortError is still classified as a timeout, because
	 * our controller fired and the caller's signal did not.
	 */
	test("a transport's generic AbortError still classifies as a timeout when only our deadline fired", async () => {
		const caller = new AbortController();
		const operation = createMCPTimeout(5, caller.signal);
		await reasonAfterAbort(operation.signal!);
		operation.clear();

		const swallowed = new DOMException("The operation was aborted.", "AbortError");
		expect(operation.isTimeoutAbort(swallowed)).toBe(true);
		expect(caller.signal.aborted).toBe(false);
	});

	/** An unrelated failure is never a timeout, whichever signal state it arrives in. */
	test("an ordinary error is never classified as a timeout", async () => {
		const operation = createMCPTimeout(5);
		await reasonAfterAbort(operation.signal!);
		operation.clear();

		expect(operation.isTimeoutAbort(new TypeError("fetch failed"))).toBe(false);
		expect(operation.isTimeoutAbort("aborted")).toBe(false);
		expect(operation.isTimeoutAbort(undefined)).toBe(false);
	});

	/** `clear()` cancels the timer, so a completed call never aborts afterwards. */
	test("clearing before the deadline leaves the signal unaborted", async () => {
		const operation = createMCPTimeout(10);
		operation.clear();
		await Bun.sleep(40);

		expect(operation.signal?.aborted).toBe(false);
		expect(operation.isTimeoutAbort(new DOMException("x", "AbortError"))).toBe(false);
	});

	/**
	 * A disabled timeout passes the caller's signal straight through and claims
	 * nothing: there is no deadline, so no error can be one.
	 */
	test("a disabled timeout forwards the caller's signal and classifies nothing", () => {
		const caller = new AbortController();
		const operation = createMCPTimeout(0, caller.signal);

		expect(operation.signal).toBe(caller.signal);
		expect(operation.isTimeoutAbort(new DOMException("x", "TimeoutError"))).toBe(false);
		expect(operation.isTimeoutAbort(new DOMException("x", "AbortError"))).toBe(false);
	});

	/** The caller's own abort still reaches the combined signal when a deadline is set. */
	test("the combined signal aborts when the caller aborts", async () => {
		const caller = new AbortController();
		const operation = createMCPTimeout(10_000, caller.signal);
		const userError = new DOMException("stop", "AbortError");
		caller.abort(userError);
		const reason = await reasonAfterAbort(operation.signal!);
		operation.clear();

		expect(reason).toBe(userError);
		expect(operation.isTimeoutAbort(reason)).toBe(false);
	});
});
