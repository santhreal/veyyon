/**
 * The one reader of the `async` block a long-running tool reports on its result.
 *
 * `task`, `bash` and the session's job reconciler all write `details.async`, and
 * six call sites across the event controller and the tool-execution component
 * each re-derived it with their own inline
 * `(details as { async?: { state?: string } })?.async?.state`. Two of those sites
 * decide whether a tool card is still live, and they disagreed: the live event
 * path kept a running background `task` in `pendingTools` and marked its result
 * partial, while the transcript rebuild settled every result unconditionally. A
 * terminal resize, a theme switch or a session switch rebuilds the transcript,
 * so a running subagent's card was sealed mid-flight and its later progress had
 * nowhere to land.
 */

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

/**
 * Whether this result belongs to a subagent still running in the background.
 *
 * `task` only: a backgrounded `bash` job also reports `state: "running"`, but its
 * card is settled when the call returns and its outcome arrives as a separate
 * job completion. Widening this predicate would keep those cards live with
 * nothing left to update them.
 */
export function isLiveBackgroundTask(toolName: string | undefined, details: unknown): boolean {
	return toolName === "task" && asyncToolState(details) === "running";
}
