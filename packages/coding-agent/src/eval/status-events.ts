/**
 * How a cell's status-event list is updated. Lives beside the event type, not the renderer, because
 * `tools/eval.ts` produces events and has nothing to draw. Importing from `eval-render.ts` cost 367 modules.
 */

import type { EvalStatusEvent } from "./types";

/**
 * Record a status event, replacing the previous one for the same subagent. Agent events supersede
 * (pending → running → completed under one `id`); every other op is appended.
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
