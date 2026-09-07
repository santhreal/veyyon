/**
 * WHY. A spawned agent that spawns agents of its own emits a `task` tool event, and the executor
 * turns that event into `extractedToolData.task` on the child's progress and result; the task
 * card walks that slot to draw a nested tree. The `task` handler is registered as a side effect of
 * loading `task/nested-task-details.ts`, which the executor imports for that side effect. Drop
 * the import and a two-level delegation reports one level, with nothing red anywhere: the
 * executor still runs, the card still draws, and the work below the first level is invisible
 * until the whole tree settles.
 *
 * Pinned at the registry, the way `subprocess-yield-handler-registration.test.ts` pins `yield`:
 * importing the executor is the only arrangement this file makes. Does not cover how the card
 * draws the tree it is handed.
 */
import { describe, expect, it } from "bun:test";
// The import under test: nothing here imports `task/nested-task-details` itself.
import "@veyyon/coding-agent/task/executor";
import { subprocessToolRegistry } from "@veyyon/coding-agent/task/subprocess-tool-registry";

describe("a parent reads what its children delegated", () => {
	it("registers a task handler when the executor loads", () => {
		expect(subprocessToolRegistry.hasHandler("task")).toBe(true);
	});

	it("extracts a task snapshot, which is a details object with a results array", () => {
		const details = { results: [{ agent: "deep", name: "Child", exitCode: 0 }], summary: "one child" };
		const extracted = subprocessToolRegistry.getHandler("task")?.extractData?.({
			toolName: "task",
			toolCallId: "tool-1",
			result: { content: [{ type: "text", text: "1 task finished" }], details },
			isError: false,
		});

		expect(extracted).toBe(details);
	});

	it("extracts nothing from a task event whose details are not a snapshot", () => {
		const handler = subprocessToolRegistry.getHandler("task");
		const event = (details: unknown) => ({
			toolName: "task",
			toolCallId: "tool-1",
			result: { content: [{ type: "text", text: "" }], details },
			isError: false,
		});

		expect(handler?.extractData?.(event(undefined))).toBeUndefined();
		expect(handler?.extractData?.(event(null))).toBeUndefined();
		expect(handler?.extractData?.(event("results"))).toBeUndefined();
		expect(handler?.extractData?.(event({ results: "not a list" }))).toBeUndefined();
		expect(handler?.extractData?.(event({ summary: "no results slot" }))).toBeUndefined();
	});

	it("does not end the run on a task event, since the child is still working", () => {
		const handler = subprocessToolRegistry.getHandler("task");
		expect(handler?.shouldTerminate).toBeUndefined();
	});
});
