/**
 * The registry wrapper every tool passes through does not destroy the identity
 * of the errors those tools throw.
 *
 * WHY THIS SUITE EXISTS. `wrapToolWithMetaNotice` wraps EVERY tool the session
 * registers, and its catch was `throw new Error(renderError(e))`. That looks
 * harmless and reads as a formatting step, and it cost nothing visible, which is
 * exactly why it survived: `renderError` returns `e.message` for any `Error`
 * (`ToolError.render()` is the base implementation returning `this.message`, and
 * nothing in the codebase overrides it), so the text was always byte-identical
 * and every error message still read correctly.
 *
 * What it destroyed was the TYPE and the NAME, which is what cancellation
 * handling in this codebase is built on. A `ToolAbortError` thrown by edit, eval,
 * bash or the LSP arrived at every consumer as a plain `Error` named "Error", so
 * the roughly twenty `instanceof ToolAbortError` branches stopped matching, and
 * so did `isAbortError`, which is name-based on purpose because `@veyyon/utils`
 * cannot import the class. Its doc says "the name is the contract"; the wrapper
 * broke the contract for every registered tool at once. `cause` went too, taking
 * the `TimeoutError` identity `throwIfAborted` goes out of its way to keep.
 *
 * The failure is invisible at the point it happens and shows up as behavior:
 * a cancelled tool reads as an ordinary failure, so the agent loop re-reads and
 * retries what the operator had just told it to stop doing, while the message it
 * shows still says "cancelled". That is the shape a silent fallback takes when
 * the thing it silently drops is a type.
 *
 * These tests assert on the wrapper directly rather than through a real tool.
 * The wrapper is the shared owner: every tool inherits whatever it does, so
 * proving it here proves it once for all of them, and a failure names the
 * mechanism instead of whichever tool happened to be the example.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { wrapToolWithMetaNotice } from "@veyyon/coding-agent/tools/output-meta";
import { ToolAbortError, ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { isAbortError } from "@veyyon/utils";
import { type } from "arktype";

/** A minimal registered tool whose only job is to throw what the test hands it. */
function throwingTool(thrown: unknown): AgentTool {
	const tool = {
		name: "throws",
		label: "Throws",
		summary: "throws whatever the test gave it",
		description: "throws whatever the test gave it",
		parameters: type({}),
		execute: async () => {
			throw thrown;
		},
	} as unknown as AgentTool;
	return wrapToolWithMetaNotice(tool);
}

/** Run the wrapped tool and return whatever came out of it. */
async function thrownBy(tool: AgentTool): Promise<unknown> {
	return await tool.execute("call-1", {} as never, undefined, undefined, undefined).then(
		result => result,
		(err: unknown) => err,
	);
}

describe("wrapToolWithMetaNotice error identity", () => {
	it("rethrows a ToolAbortError as a ToolAbortError", async () => {
		// THE HEADLINE REGRESSION. Losing this is what made every cancellation read
		// as an ordinary failure downstream.
		const original = new ToolAbortError("Edit cancelled after 1 of 3 files");
		const caught = await thrownBy(throwingTool(original));

		expect(caught).toBeInstanceOf(ToolAbortError);
		expect(caught).toBe(original);
	});

	it("keeps the name that isAbortError actually reads", async () => {
		// `isAbortError` matches on `error.name`, not on the class, because
		// `@veyyon/utils` cannot import `ToolAbortError` (the dependency runs the
		// other way). `new Error(message)` produces name "Error", so the rewrap
		// defeated the name-based check just as thoroughly as the instanceof one,
		// and that check is the one used at the most call sites.
		const caught = await thrownBy(throwingTool(new ToolAbortError("Operation aborted")));

		expect((caught as Error).name).toBe("ToolAbortError");
		expect(isAbortError(caught)).toBe(true);
	});

	it("keeps the cause, so a timeout is still distinguishable from a cancel", async () => {
		// `throwIfAborted` deliberately puts the original reason on `cause` so code
		// that needs the `TimeoutError` identity can still find it. Rebuilding the
		// error dropped `cause` silently, which collapsed "the deadline expired"
		// and "the user pressed Escape" into the same thing at every consumer.
		const reason = Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" });
		const caught = await thrownBy(throwingTool(new ToolAbortError("lsp: deadline exceeded", { cause: reason })));

		expect((caught as Error).cause).toBe(reason);
	});

	it("rethrows a ToolError as a ToolError, keeping its context", async () => {
		// `ToolError` carries a `context` record that the rewrap also discarded.
		// Nothing reads it today, which is precisely why a silent drop here would
		// go unnoticed until the first consumer that does.
		const original = new ToolError("pattern did not match", { path: "src/a.ts" });
		const caught = await thrownBy(throwingTool(original));

		expect(caught).toBeInstanceOf(ToolError);
		expect((caught as ToolError).context).toEqual({ path: "src/a.ts" });
	});

	it("preserves the message exactly, which is what the old code was for", async () => {
		// The rewrap existed to put `renderError(e)` in the message. That is a no-op
		// for every Error in this codebase, and this pins that the message survives
		// the change: fixing the identity must not cost the text.
		const caught = await thrownBy(throwingTool(new ToolError("no matches for `foo` in src/")));

		expect((caught as Error).message).toBe("no matches for `foo` in src/");
	});

	it("still wraps a non-Error throw so the agent loop has something to render", async () => {
		// The one case with no identity to keep. A bare string thrown from a tool
		// has to become an Error, or the loop has no message to show.
		const caught = await thrownBy(throwingTool("something went wrong"));

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe("something went wrong");
	});

	it("does not swallow the throw", async () => {
		// KEPT, and deliberately shallow. NON-VACUITY: every assertion above inspects
		// a rejection, so all of them would be satisfied by a wrapper that resolved
		// and returned undefined. "Something was thrown" is the whole contract here.
		const tool = throwingTool(new ToolError("boom"));
		const caught = await thrownBy(tool);

		expect(caught).toBeInstanceOf(Error);
	});

	it("still returns a successful result untouched", async () => {
		// The other half of non-vacuity: the wrapper must not have become a pure
		// rethrower. A tool that succeeds still gets its result back.
		const tool = wrapToolWithMetaNotice({
			name: "ok",
			label: "Ok",
			summary: "succeeds",
			description: "succeeds",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "done" }], details: undefined }),
		} as unknown as AgentTool);

		const result = (await thrownBy(tool)) as { content: { type: string; text: string }[] };
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
	});
});
