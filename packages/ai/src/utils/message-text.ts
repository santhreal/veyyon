import type { AssistantMessage, TextContent } from "../types";

export function assistantTextBlocks(message: Pick<AssistantMessage, "content">): string[] {
	return message.content.filter((block): block is TextContent => block.type === "text").map(block => block.text);
}

export function assistantText(message: Pick<AssistantMessage, "content">, separator = "\n"): string {
	return assistantTextBlocks(message).join(separator);
}

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

export function assistantTextFromUnknown(content: unknown, separator = "\n"): string {
	return assistantTextBlocksFromUnknown(content).join(separator);
}
