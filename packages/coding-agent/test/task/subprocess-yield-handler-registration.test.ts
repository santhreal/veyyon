/**
 * Contracts: the task executor can read a subagent's yield without help from anyone else.
 *
 * HOW A SUBAGENT FINISHES. It calls `yield`. The executor sees a `tool_execution_end` for that tool
 * name, looks the tool up in `subprocessToolRegistry`, and uses the handler to pull the result out
 * and to decide the run is over. No handler means no extracted data, which means `yieldCalled` is
 * never set, which means the subagent is prompted again for a result it already gave, twice more,
 * and the run ends with `SYSTEM WARNING: Subagent exited without calling yield tool` and exit code
 * 1. The subagent did nothing wrong and nothing says so.
 *
 * WHY THAT WAS REACHABLE. The handler is registered as a side effect of loading `tools/yield.ts`,
 * and `task/executor.ts` did not import it. In production the registration arrived by luck of import
 * order: a spawned session builds its own `yield` tool, which loads the module, and an in-process
 * child does that before it can emit a yield event. The requirement was real, unstated and
 * unenforced, and it broke the moment the child session was a stub instead of a real one: 17 tests
 * across `test/task/` and `test/eval/` failed with reminder counts of 4 where 2 was expected and
 * exit code 1 where 0 was expected, none of which named the registry.
 *
 * This suite pins the requirement at its own level, so a future import cleanup that drops the
 * side-effect import fails HERE, with the reason, rather than as a wave of unrelated-looking
 * subagent failures.
 */
import { describe, expect, it } from "bun:test";
import { subprocessToolRegistry, YIELD_TOOL_NAME } from "@veyyon/coding-agent/task/subprocess-tool-registry";
// The import under test. Importing the executor is the ONLY thing this file does to arrange the
// registration: nothing here imports `tools/yield`, which is exactly the condition that used to
// leave the handler missing.
import "@veyyon/coding-agent/task/executor";

describe("importing the task executor", () => {
	/**
	 * The handler has to do both jobs, not merely exist. `extractData` is what sets `yieldCalled` (via
	 * `recordExtractedToolData`), and `shouldTerminate` is what ends the run; a handler with only one
	 * of them would satisfy a `toBeDefined` check and still hang or still over-remind.
	 */
	it("registers a handler that can both extract a result and end the run", () => {
		const handler = subprocessToolRegistry.getHandler(YIELD_TOOL_NAME);

		expect(typeof handler?.extractData).toBe("function");
		expect(typeof handler?.shouldTerminate).toBe("function");
	});

	/**
	 * The successful yield, end to end through the handler: the executor hands it the event it
	 * received and expects the payload back plus permission to stop. These are the exact values the
	 * failing tests were missing, so they are asserted by value rather than by shape.
	 */
	it("reads a successful yield's data back out and calls the run finished", () => {
		const handler = subprocessToolRegistry.getHandler(YIELD_TOOL_NAME);
		const event = {
			toolName: YIELD_TOOL_NAME,
			toolCallId: "tool-1",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data: { done: true } },
			},
			isError: false,
		};

		expect(handler?.extractData?.(event)).toEqual({
			data: { done: true },
			status: "success",
			error: undefined,
			type: undefined,
			useLastTurn: undefined,
			schemaOverridden: undefined,
		});
		expect(handler?.shouldTerminate?.(event)).toBe(true);
	});

	/**
	 * An aborted yield is still a yield: the subagent answered, and the answer is that it stopped. If
	 * this returned `undefined` the executor would treat an abort as no result at all and remind an
	 * agent that is already gone.
	 */
	it("treats an aborted yield as a result, carrying its reason", () => {
		const handler = subprocessToolRegistry.getHandler(YIELD_TOOL_NAME);

		expect(
			handler?.extractData?.({
				toolName: YIELD_TOOL_NAME,
				toolCallId: "tool-2",
				result: { content: [], details: { status: "aborted", error: "user cancelled" } },
				isError: false,
			}),
		).toEqual({
			data: undefined,
			status: "aborted",
			error: "user cancelled",
			type: undefined,
			useLastTurn: undefined,
			schemaOverridden: undefined,
		});
	});

	/**
	 * A rejected yield is not a result. The executor must keep waiting, because the subagent still has
	 * to answer, and extracting a value here would end the run on a failed call.
	 */
	it("extracts nothing from a yield that did not succeed", () => {
		const handler = subprocessToolRegistry.getHandler(YIELD_TOOL_NAME);

		expect(
			handler?.extractData?.({
				toolName: YIELD_TOOL_NAME,
				toolCallId: "tool-3",
				result: { content: [], details: { status: "error", error: "schema mismatch" } },
				isError: true,
			}),
		).toBeUndefined();
	});

	/**
	 * The name is one constant shared by the tool, the executor and the renderer. A second literal
	 * would compile and silently stop matching after a rename, which is the failure this constant
	 * exists to prevent, so its value is pinned.
	 */
	it("keys the protocol on the shared name constant", () => {
		expect(YIELD_TOOL_NAME).toBe("yield");
	});
});
