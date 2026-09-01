/**
 * How a parent learns what its children delegated.
 *
 * A spawned agent that spawns agents of its own emits a `task` tool event like any other, and the
 * executor turns that event into `extractedToolData.task` on the child's progress and result. That
 * slot is what the task card walks to draw a nested tree, so without this registration a two-level
 * delegation reports one level and the work below it is invisible until the whole tree settles.
 *
 * It is its own module because it is a side effect: importing it registers the handler, and the
 * reader that needs it says so with a side-effect import rather than relying on import order.
 */

import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { TaskToolDetails } from "./types";

/** Whether a tool result's details are a task snapshot, which is the one shape worth accumulating. */
function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

subprocessToolRegistry.register<TaskToolDetails>("task", {
	extractData: event => {
		const details = event.result?.details;
		return isTaskToolDetails(details) ? details : undefined;
	},
});
