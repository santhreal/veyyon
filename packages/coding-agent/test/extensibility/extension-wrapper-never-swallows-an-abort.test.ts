/**
 * An extension's `tool_result` handler cannot turn a cancellation into a
 * resolved result.
 *
 * WHY THIS SUITE EXISTS. `ExtensionToolWrapper` deliberately converts a thrown
 * tool error into a resolved `isError: true` result whenever a `tool_result`
 * handler returns replacement content. That is the right behavior for a tool
 * that FAILED: the handler wrote better failure text, and forcing the original
 * exception through would discard it. It is the wrong behavior for a tool the
 * operator CANCELLED, and the difference matters because the agent loop responds
 * to the two in opposite ways. A failure is something to read and retry. A
 * cancellation is something to stop for. Swallowing the abort into a result made
 * the loop re-issue the exact work the user had just interrupted, and the only
 * way to notice was to watch it happen.
 *
 * The bug is conditional on an extension being loaded with a `tool_result`
 * handler, which is why it outlived the same defect in the registry wrapper
 * (`wrapToolWithMetaNotice`, which flattened every tool error into a plain
 * `Error`): with no extensions the path is never taken, so nothing in a default
 * session exercises it. That is precisely the shape of thing a test has to hold,
 * because the next reader has no reason to look here.
 *
 * `isAbortError` is the predicate, not `instanceof ToolAbortError`, so a
 * `DOMException` named "AbortError" from the platform is caught by the same
 * check as the coding agent's own cancellation. Both are the operator stopping
 * the work, and a wrapper that honored one and swallowed the other would be a
 * worse bug than the original.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ToolAbortError, ToolError } from "@veyyon/coding-agent/tools/tool-errors";
import { type } from "arktype";

/** Replacement content a `tool_result` handler hands back. */
const REPLACEMENT = [{ type: "text" as const, text: "rewritten by the extension" }];

/**
 * A runner with exactly one `tool_result` handler, which is the condition that
 * opens the swallowing path. Everything else answers "no handlers" so the test
 * exercises one branch rather than the whole approval pipeline.
 */
function runnerWithResultHandler(): ExtensionRunner {
	return {
		hasHandlers: (event: string) => event === "tool_result",
		hasUI: () => false,
		getUIContext: () => ({}),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => ({ content: REPLACEMENT }),
		createContext: () => ({}),
	} as unknown as ExtensionRunner;
}

function toolThrowing(thrown: unknown): AgentTool {
	return {
		name: "throws",
		label: "Throws",
		summary: "throws what the test gave it",
		description: "throws what the test gave it",
		parameters: type({}),
		execute: async () => {
			throw thrown;
		},
	} as unknown as AgentTool;
}

/** Run the wrapped tool in yolo mode and return the result or the rejection. */
async function outcomeOf(tool: AgentTool): Promise<unknown> {
	const wrapped = new ExtensionToolWrapper(tool, runnerWithResultHandler());
	return await wrapped
		.execute("call-1", {} as never, undefined, undefined, {
			settings: { get: (path: string) => (path === "tools.approvalMode" ? "yolo" : undefined) },
		} as never)
		.then(
			result => result,
			(err: unknown) => err,
		);
}

describe("ExtensionToolWrapper and a cancelled tool", () => {
	it("rethrows a ToolAbortError instead of returning the handler's replacement content", async () => {
		// THE REGRESSION. Before the fix this resolved with `REPLACEMENT` and
		// `isError: true`, so the cancellation reached the agent loop as an ordinary
		// failure carrying text an extension had written about it.
		const original = new ToolAbortError("Eval cancelled: cell 1 (py) started and did NOT finish");
		const outcome = await outcomeOf(toolThrowing(original));

		expect(outcome).toBe(original);
	});

	it("rethrows a platform AbortError too, not only the coding agent's own type", async () => {
		// A `DOMException` named "AbortError" is what `AbortSignal.throwIfAborted`
		// and most platform APIs produce. It is the same event as far as the
		// operator is concerned, and honoring only `ToolAbortError` would leave the
		// larger half of real cancellations still being swallowed.
		const platformAbort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
		const outcome = await outcomeOf(toolThrowing(platformAbort));

		expect(outcome).toBe(platformAbort);
	});

	it("still lets a handler rewrite the content of a genuine failure", async () => {
		// NON-VACUITY, and the behavior the swallowing path exists for. The fix must
		// be narrow: an ordinary `ToolError` still becomes a resolved result carrying
		// the extension's replacement content, or the fix has quietly removed the
		// feature instead of correcting it.
		const outcome = (await outcomeOf(toolThrowing(new ToolError("no matches found")))) as {
			content: unknown;
			isError?: boolean;
		};

		expect(outcome.content).toEqual(REPLACEMENT);
		expect(outcome.isError).toBe(true);
	});

	it("still lets a handler rewrite the content of a success", async () => {
		// The other half of non-vacuity: the wrapper has not become a pure
		// rethrower, and a call that never threw is still routed through the
		// handler.
		const succeeding = {
			name: "ok",
			label: "Ok",
			summary: "succeeds",
			description: "succeeds",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "original" }], details: undefined }),
		} as unknown as AgentTool;

		const outcome = (await outcomeOf(succeeding)) as { content: unknown; isError?: boolean };

		expect(outcome.content).toEqual(REPLACEMENT);
		expect(outcome.isError).toBeUndefined();
	});
});
