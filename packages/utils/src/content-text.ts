/**
 * Text of an untyped message-content value.
 *
 * A raw string is returned as-is. An array of content blocks contributes each
 * block's `text` (only blocks with `type === "text"` and a string `text`;
 * malformed or non-text blocks, including thinking/tool blocks, are skipped),
 * joined by `separator` (default "\n"). Anything else yields "".
 *
 * Tolerant by design: callers pass provider payloads of unknown shape. This is
 * the ONE owner for that text-only extraction. Trim at the call site when
 * needed — trimming is a presentation choice.
 *
 * It is deliberately narrower than collab-web's `messageText`, which also
 * pulls `thinking` blocks and unwraps message-like `{ content }` objects; that
 * richer contract stays separate.
 */
export function contentText(content: unknown, separator = "\n"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const rec = block as { type?: unknown; text?: unknown };
			if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
		}
	}
	return parts.join(separator);
}
