import { isRecord } from "@veyyon/utils/type-guards";

/** Flatten content; paragraph-preserving projections retain empty chunk boundaries. */
export function contentToText(content: unknown, separator = "\n", preserveEmptyBoundaries = false): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	let first = true;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (preserveEmptyBoundaries ? !first : text.length > 0) text += separator;
			text += block.text;
			first = false;
		}
	}
	return text;
}
