/** How a cell's status-event list is updated as the backend reports progress. This lives beside the event type rather than with the renderer that draws it, because the module that PRODUCES */

import type { EvalStatusEvent } from "./types";

/** Record a status event, replacing the previous event for the same subagent instead of appending a second one. Agent events are the one kind that SUPERSEDE rather than accumulate: a subagent reports pending, then running, */
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
