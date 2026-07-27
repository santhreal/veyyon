import type { AssistantMessage, TextContent } from "../types";

/** The text blocks of an assistant message, in order (thinking/tool blocks excluded). */
export function assistantTextBlocks(message: Pick<AssistantMessage, "content">): string[] {
	return message.content.filter((block): block is TextContent => block.type === "text").map(block => block.text);
}

/**
 * Text blocks joined into one string. Separator defaults to "\n" (block
 * boundaries usually mean paragraph breaks); pass "" for raw concatenation.
 * Trim at the call site when needed — trimming is a presentation choice.
 */
export function assistantText(message: Pick<AssistantMessage, "content">, separator = "\n"): string {
	return assistantTextBlocks(message).join(separator);
}

/**
 * The text blocks of a message whose content has not been validated yet.
 *
 * Same extraction as {@link assistantTextBlocks}, for callers reading content off a
 * boundary where it arrives as `unknown`: a session log on disk, a benchmark transcript, a
 * memory record. Anything that is not an array of `{ type: "text", text: string }` blocks
 * contributes nothing, rather than throwing on a `null` entry or yielding `undefined` in
 * the middle of the text.
 *
 * It exists because two callers needed exactly this and each hand-rolled it
 * (`coding-agent/src/mnemopi/state.ts` and `typescript-edit-benchmark/src/argot-bench.ts`),
 * which meant three copies of the rule for what counts as assistant text. When a new
 * content-block shape lands, the copies do not stop working, they silently return less
 * text than the message contained.
 */
export function assistantTextBlocksFromUnknown(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const blocks: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") blocks.push(candidate.text);
	}
	return blocks;
}

/** {@link assistantTextBlocksFromUnknown}, joined. Separator defaults to `"\n"`. */
export function assistantTextFromUnknown(content: unknown, separator = "\n"): string {
	return assistantTextBlocksFromUnknown(content).join(separator);
}
