/**
 * A tool converting a caught error into a failure does not convert a
 * cancellation into one.
 *
 * WHY THIS SUITE EXISTS. Nine sites across seven tools wrote
 * `throw new ToolError(errorMessage(error))` inside a catch. It reads as a
 * formatting step and is not one: it replaces whatever was thrown with a fresh
 * object, so the name, the type, `cause` and any `ToolError.context` are gone.
 * The message survives, and the message is what a reader looks at, which is
 * exactly why the line survived review nine times.
 *
 * What it cost was the ability of anything downstream to tell a cancellation from
 * a failure, and `write` is the sharpest case. `commitFileContentAtomic` calls
 * `throwIfAborted` immediately before the rename, on purpose, so that a cancelled
 * write leaves the original file untouched; `write-abort-leaves-original.test.ts`
 * proves that it does. Then the surrounding catch rebuilt the resulting
 * `ToolAbortError` as a `ToolError`. The FILE was safe and the SIGNAL was lost, so
 * the agent loop saw an ordinary write failure, and its correct response to a
 * failed write is to write again. A guarantee about the filesystem does not help
 * if the caller is told the wrong thing about why it stopped.
 *
 * This is the third layer the same defect was found at in one pass, after the
 * registry wrapper (`wrapToolWithMetaNotice`) and the extension wrapper, which is
 * why the fix is one shared owner rather than nine local guards. `toolFailure`
 * returns the error rather than throwing it so the `throw` stays visible at the
 * call site: in a catch block, that the line terminates is the only thing about it
 * worth seeing.
 */
import { describe, expect, it } from "bun:test";
import { ToolAbortError, ToolError, toolFailure } from "@veyyon/coding-agent/tools/tool-errors";
import { isAbortError } from "@veyyon/utils";

describe("toolFailure", () => {
	it("returns a ToolAbortError unchanged, as the same object", () => {
		// THE REGRESSION. Rebuilding this as a `ToolError` is what made a cancelled
		// write indistinguishable from a failed one.
		const abort = new ToolAbortError("Operation aborted");

		expect(toolFailure(abort)).toBe(abort);
	});

	it("keeps a platform AbortError too, not only the coding agent's own type", () => {
		// `AbortSignal.throwIfAborted` and most platform APIs produce a
		// `DOMException` named "AbortError". It is the same event to the operator,
		// and it is the larger half of the cancellations a tool actually catches,
		// since anything calling into node or the browser gets this one.
		const platform = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
		const result = toolFailure(platform);

		expect(result).toBe(platform);
		expect(isAbortError(result)).toBe(true);
	});

	it("passes a ToolError through rather than rebuilding it", () => {
		// Rebuilding discards the `context` record, which is the only structured
		// thing a `ToolError` carries. Nothing reads it today, which is precisely
		// how a silent drop here would go unnoticed until the first consumer that
		// does.
		const original = new ToolError("pattern did not match", { path: "src/a.ts" });
		const result = toolFailure(original);

		expect(result).toBe(original);
		expect((result as ToolError).context).toEqual({ path: "src/a.ts" });
	});

	it("wraps a foreign error as a ToolError carrying its message", () => {
		// The case the original line existed for, which the fix must not lose: an
		// ENOENT from the filesystem or a parse error from a library becomes the
		// tool error type the agent loop renders.
		const result = toolFailure(new Error("ENOENT: no such file or directory"));

		expect(result).toBeInstanceOf(ToolError);
		expect(result.message).toBe("ENOENT: no such file or directory");
	});

	it("wraps a non-Error throw, which has no identity to keep", () => {
		const result = toolFailure("something went wrong");

		expect(result).toBeInstanceOf(ToolError);
		expect(result.message).toBe("something went wrong");
	});

	it("uses an explicit message when the caller supplies one, and keeps the context", () => {
		// Some call sites want to say something more useful than the underlying
		// failure did. That has to remain possible without discarding the context of
		// the error being replaced.
		const original = new ToolError("EACCES", { path: "/etc/hosts" });
		const result = toolFailure(original, "cannot write outside the workspace");

		expect(result.message).toBe("cannot write outside the workspace");
		expect((result as ToolError).context).toEqual({ path: "/etc/hosts" });
	});

	it("lets an abort outrank an explicit message override", () => {
		// The precedence, pinned because it is the one case where two rules meet. A
		// caller passing `what` is describing the FAILURE it expected to be handling;
		// if what actually happened was a cancellation, the caller's sentence is
		// wrong, and replacing the abort's own message with it would put a
		// misleading explanation on the operator's screen at the moment they pressed
		// Escape.
		const abort = new ToolAbortError("Edit cancelled after 1 of 3 files");
		const result = toolFailure(abort, "cannot write outside the workspace");

		expect(result).toBe(abort);
		expect(result.message).toBe("Edit cancelled after 1 of 3 files");
	});
});
