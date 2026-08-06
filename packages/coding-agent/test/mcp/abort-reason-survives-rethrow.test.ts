/**
 * A cancelled MCP call says WHY it was cancelled.
 *
 * WHY THIS SUITE EXISTS. `rethrowIfAborted` in `mcp/tool-bridge.ts` is the MCP
 * bridge's cancellation guard, and it was always correct about the thing that
 * matters most: it fires before every error-to-result conversion, so a cancelled
 * call is never quietly turned into an ordinary tool result the agent would
 * respond to by retrying. What it lost was the reason. Two of its three branches
 * minted a bare `new ToolAbortError()`, discarding both the message and the
 * original error, so three very different events collapsed into one sentence:
 *
 *  - an operator pressing Escape,
 *  - a deadline expiring (`TimeoutError`),
 *  - a parent tool cancelling a child.
 *
 * All three reached the operator as the generic "Operation aborted", and the
 * `TimeoutError` identity that lets a deadline be told from an interrupt went
 * with it. `session/messages.ts` renders the message verbatim unless it is the
 * generic sentinel, so a reason that survives into the message is a reason the
 * operator actually reads.
 *
 * This is the same defect `throwIfAborted` was fixed for in the tools layer and
 * `throwIfKernelAborted` in eval; the MCP bridge was the third site of the same
 * idea and the reconciliation missed it. It is now routed through the same
 * owners (`toolAbort` / `throwIfAborted`) rather than repeating the decision, so
 * the three cannot drift apart again.
 *
 * The tests below pin both halves. A reason that exists must survive; a bare
 * abort with nothing to say must still read as the sentinel, because a guard
 * that invents detail is its own kind of wrong.
 */
import { describe, expect, it } from "bun:test";
import { ToolAbortError, throwIfAborted, toolAbort } from "@veyyon/coding-agent/tools/tool-errors";

describe("toolAbort", () => {
	it("carries a TimeoutError's message and keeps the original on cause", () => {
		// The sharpest case. A deadline is the reason an operator most needs to
		// see, because the correct response to it (raise the timeout, split the
		// work) differs from the response to an interrupt.
		const timeout = new DOMException("The operation timed out", "TimeoutError");
		const aborted = toolAbort(timeout, "MCP call");
		expect(aborted).toBeInstanceOf(ToolAbortError);
		expect(aborted.message).toBe("MCP call: The operation timed out");
		expect(aborted.cause).toBe(timeout);
		expect((aborted.cause as DOMException).name).toBe("TimeoutError");
	});

	it("carries a string reason", () => {
		// `controller.abort("deadline")` is an ordinary spelling and the reason is
		// a bare string, not an Error.
		expect(toolAbort("parent tool cancelled", "MCP call").message).toBe("MCP call: parent tool cancelled");
	});

	it("falls back to naming the operation when the reason says nothing", () => {
		// A bare `controller.abort()` leaves `reason` undefined. There is nothing
		// to report, so the guard names the operation rather than inventing detail.
		expect(toolAbort(undefined, "MCP call").message).toBe("MCP call was aborted");
		expect(toolAbort(new Error(""), "MCP call").message).toBe("MCP call was aborted");
	});

	it("uses the generic sentinel when there is no reason and no operation name", () => {
		expect(toolAbort(undefined).message).toBe(ToolAbortError.MESSAGE);
	});

	it("returns an existing ToolAbortError unchanged rather than rewrapping it", () => {
		// Rewrapping would nest the message ("MCP call: MCP call: ...") and bury
		// the original cause one level deeper on every hop through a guard.
		const original = new ToolAbortError("read: deadline expired", { cause: "deadline" });
		expect(toolAbort(original, "MCP call")).toBe(original);
	});
});

describe("throwIfAborted routes through the same decision", () => {
	it("reports a signal's TimeoutError reason, identically to toolAbort", () => {
		// One owner, one answer: the signal-carried and error-carried paths must
		// produce the same sentence for the same reason, or the operator sees a
		// different message depending on which layer noticed the cancellation.
		const timeout = new DOMException("The operation timed out", "TimeoutError");
		const controller = new AbortController();
		controller.abort(timeout);
		let thrown: unknown;
		try {
			throwIfAborted(controller.signal, "MCP call");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ToolAbortError);
		expect((thrown as ToolAbortError).message).toBe(toolAbort(timeout, "MCP call").message);
		expect((thrown as ToolAbortError).cause).toBe(timeout);
	});

	// KEPT as an absence-of-throw contract: this guard sits in front of every MCP
	// error-to-result conversion, so one that fires on a live signal turns an
	// ordinary tool failure into a phantom cancellation. Every test above hands
	// it an already-aborted signal and would pass with the check dropped.
	it("does not throw when the signal is not aborted", () => {
		expect(() => throwIfAborted(new AbortController().signal, "MCP call")).not.toThrow();
		expect(() => throwIfAborted(undefined, "MCP call")).not.toThrow();
	});
});
