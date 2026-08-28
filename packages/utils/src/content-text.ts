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
