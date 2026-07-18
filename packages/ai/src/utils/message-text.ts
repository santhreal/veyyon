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
