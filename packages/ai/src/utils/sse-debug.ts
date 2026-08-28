import type { ServerSentEvent } from "@veyyon/utils/stream";
import type { RawSseEvent } from "../types";

type RawSseObserver = (event: RawSseEvent) => void;

export function notifyRawSseEvent(observer: RawSseObserver | undefined, event: ServerSentEvent | RawSseEvent): void {
	if (!observer) return;
	try {
		observer(event as RawSseEvent);
	} catch {}
}

export function resolveOpenAiSseEventName(event: RawSseEvent): void {
	if (event.event || !event.data || event.data === "[DONE]") return;
	try {
		const parsed: unknown = JSON.parse(event.data);
		if (typeof parsed !== "object" || parsed === null) return;
		const record = parsed as { type?: unknown; object?: unknown };
		const resolvedEvent =
			typeof record.type === "string" ? record.type : typeof record.object === "string" ? record.object : null;
		if (resolvedEvent) {
			event.event = resolvedEvent;
			event.raw = [`event: ${resolvedEvent}`, ...event.raw];
		}
	} catch {}
}
