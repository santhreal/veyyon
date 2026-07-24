import type { ServerSentEvent } from "@veyyon/utils";
import type { RawSseEvent } from "../types";

type RawSseObserver = (event: RawSseEvent) => void;

export function notifyRawSseEvent(observer: RawSseObserver | undefined, event: ServerSentEvent | RawSseEvent): void {
	if (!observer) return;
	try {
		// Pass the event through without cloning `raw`. The only wired observer
		// (`RawSseDebugBuffer.recordEvent`) treats `raw` as owned and never
		// mutates it; new observers must adhere to the same contract.
		// `ServerSentEvent` and `RawSseEvent` are structurally identical
		// (`event: string | null`, `data: string`, `raw: string[]`).
		observer(event as RawSseEvent);
	} catch {
		// Raw stream observers are diagnostic only and must not affect generation.
	}
}

/**
 * Fill in the semantic event name for an OpenAI-family SSE record in place.
 *
 * The OpenAI Responses and Chat Completions streams frequently omit the SSE
 * `event:` line, carrying the event's semantic name inside the JSON payload
 * instead: the Responses API puts it in `type` (`response.output_text.delta`,
 * ...) and the Completions API puts it in `object` (`chat.completion.chunk`).
 * The raw-SSE debug observer wants a named event, so when `event.event` is
 * absent we parse the data line, resolve the name (`type` first, then
 * `object`), write it onto `event.event`, and prepend a synthetic
 * `event: <name>` line to `event.raw` so the recorded transcript matches what
 * a named stream would have looked like.
 *
 * This enrichment is best-effort and diagnostic-only. `[DONE]` sentinels and
 * non-JSON data lines are left untouched, and a malformed JSON body is
 * swallowed rather than thrown: the raw event still flows through unenriched,
 * and a parse failure here must never disturb the generation path. Shared by
 * `openai-completions`, `openai-responses`, and `azure-openai-responses`, whose
 * observers were byte-for-byte identical before this was hoisted (ONE PLACE).
 */
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
	} catch {
		// Non-JSON data lines (or partial frames) carry no resolvable name; leave
		// the event unenriched. Diagnostic-only, must not throw into the stream.
	}
}
