/** The one reader of the `async` block a long-running tool reports on its result. `task`, `bash` and the session's job reconciler all write `details.async`, and */

/** The lifecycle a tool reports for work that outlives its call. */
export type AsyncToolState = "running" | "completed" | "failed";

/** The shape a tool writes under `details.async`. */
export interface AsyncToolDetails {
	async?: { state?: string; jobId?: string; type?: string };
}

/** The reported state, or `undefined` when the tool reported none. */
export function asyncToolState(details: unknown): string | undefined {
	return (details as AsyncToolDetails | undefined)?.async?.state;
}

/** Whether the tool reported work that has finished, either way. */
export function isFinalAsyncToolState(details: unknown): boolean {
	const state = asyncToolState(details);
	return state === "completed" || state === "failed";
}

/** Whether this result belongs to a subagent still running in the background. `task` only: a backgrounded `bash` job also reports `state: "running"`, but its */
export function isLiveBackgroundTask(toolName: string | undefined, details: unknown): boolean {
	return toolName === "task" && asyncToolState(details) === "running";
}
