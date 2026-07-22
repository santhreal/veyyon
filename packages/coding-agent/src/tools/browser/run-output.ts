import type { ImageContent, TextContent } from "@veyyon/ai";
import { stringifyJsonSafe, tryParseJson } from "@veyyon/utils";
import type { JsDisplayOutput } from "../../eval/js/shared/types";

/**
 * Accumulates a browser run's result entries: explicit `display()` payloads,
 * screenshot captions/images, and buffered stream text (`console.*`, `print`,
 * `display()` of strings/primitives — `JsRuntime.displayValue` emits those via
 * `onText`). Stream text is buffered and flushed as one entry before the next
 * display/screenshot (and on `finish()`) so it reaches the tool result in
 * order instead of vanishing into the debug log.
 */
export class RunOutput {
	readonly #displays: Array<TextContent | ImageContent> = [];
	#textBuffer = "";

	/** Buffer a stream-text chunk; it joins the entries at the next push or on finish(). */
	pushText(chunk: string): void {
		this.#textBuffer += chunk;
	}

	/** Append a `display()` payload (image/json/status), flushing buffered text first. */
	pushDisplay(output: JsDisplayOutput): void {
		if (output.type === "image") {
			this.push({ type: "image", data: output.data, mimeType: output.mimeType });
			return;
		}
		if (output.type === "json") {
			this.push({ type: "text", text: safeJsonStringify(output.data) });
			return;
		}
		// status — surface as compact JSON so helper side effects (read/write/env) appear in
		// the cell result alongside explicit display() output.
		this.push({ type: "text", text: safeJsonStringify(output.event) });
	}

	/** Append a pre-built entry (e.g. a screenshot caption/image), flushing buffered text first. */
	push(entry: TextContent | ImageContent): void {
		this.#flush();
		this.#displays.push(entry);
	}

	/** Flush any remaining stream text and return the ordered entries. */
	finish(): Array<TextContent | ImageContent> {
		this.#flush();
		return this.#displays;
	}

	#flush(): void {
		if (!this.#textBuffer) return;
		// Entries are newline-joined at render; drop the stream's trailing newline.
		this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
		this.#textBuffer = "";
	}
}

/**
 * Render a value as JSON for a run's display output.
 *
 * Delegates to the shared owner in `@veyyon/utils`. This used to be one of five
 * hand-rolled copies that all ended in `String(value)`, so a cyclic or bigint
 * value displayed as the literal text `[object Object]` (see `stringifyJsonSafe`).
 */
export function safeJsonStringify(value: unknown): string {
	return stringifyJsonSafe(value, 2);
}

/**
 * Pass a return value across the run boundary: structured-cloneable as-is, else
 * a JSON round trip.
 *
 * The last resort used to be `String(value)`, which hands back `[object Object]`
 * as though it were the value the caller returned. A string that cannot be told
 * apart from a real result is worse than a visibly failed one, so an
 * unrepresentable value now comes back as the same `[unserializable ...]` marker
 * `safeJsonStringify` produces, which names the type and the reason.
 */
export function cloneSafe(value: unknown): unknown {
	if (value === undefined) return undefined;
	try {
		structuredClone(value);
		return value;
	} catch {}
	// The shared renderer, so a value that survives here comes back with its
	// functions and symbols named rather than dropped on the floor.
	const rendered = stringifyJsonSafe(value);
	if (!rendered.startsWith("[unserializable ")) {
		const parsed = tryParseJson<unknown>(rendered);
		if (parsed !== null) return parsed;
	}
	// Primitives always survive one of the paths above, so anything here is an
	// object that cannot cross the boundary at all.
	return typeof value === "object" || typeof value === "function" ? safeJsonStringify(value) : String(value);
}
