/**
 * Concatenate the text of `type === "text"` content blocks with `separator`.
 *
 * The one owner of the "join message text blocks" loop that message consumers
 * (session, TTS, web providers, memory extraction, stats parsing) previously
 * each re-rolled. Blocks that are not objects (e.g. nulls in parsed JSONL) and
 * non-string `text` are skipped; empty strings are kept.
 */
export function joinTextBlocks(blocks: ReadonlyArray<unknown>, separator = "\n"): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
	}
	return parts.join(separator);
}

/**
 * Text of a message `content` payload that may be a plain string or a block
 * array: strings pass through, arrays go through {@link joinTextBlocks}, and
 * anything else is "".
 */
export function textFromContent(content: unknown, separator = "\n"): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? joinTextBlocks(content, separator) : "";
}
