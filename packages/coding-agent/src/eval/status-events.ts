/**
 * How a cell's status-event list is updated as the backend reports progress.
 *
 * This lives beside the event type rather than with the renderer that draws it, because the module that PRODUCES
 * the events is `tools/eval.ts`, which runs code and has nothing to draw. It used to import this from
 * `tools/eval-render.ts`, and that one import cost 367 modules: the renderer pulls in `Markdown` and `Text` from
 * `@veyyon/tui`, the theme engine, the markdown theme, the settings store and the framed-block helpers. A tool
 * that starts a Python kernel paid all of it to append to an array.
 */

import type { EvalStatusEvent } from "./types";

/**
 * Record a status event, replacing the previous event for the same subagent instead of appending a second one.
 *
 * Agent events are the one kind that SUPERSEDE rather than accumulate: a subagent reports pending, then running,
 * then completed under one `id`, and the reader wants its current state, not its history. Appending each would
 * make one subagent look like three, and the count is what the status line shows. Every other op is a distinct
 * thing that happened, so it is appended.
 */
export function upsertStatusEvent(events: EvalStatusEvent[], event: EvalStatusEvent): void {
	if (event.op === "agent" && typeof event.id === "string") {
		const id = event.id;
		const index = events.findIndex(candidate => candidate.op === "agent" && candidate.id === id);
		if (index >= 0) {
			events[index] = event;
			return;
		}
	}
	events.push(event);
}
