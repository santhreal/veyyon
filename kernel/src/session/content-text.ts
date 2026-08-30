/**
 * User, custom, and message content is either a plain string or an array of
 * blocks. Several call sites flatten that array back to a string, each with
 * slightly different rules: a different join separator, dropping image blocks
 * versus rendering a placeholder, and trimming or not. Those differences are
 * real (they change what the reader sees), so instead of a helper per variant
 * this is the ONE owner and the differences live in an explicit options object
 * at each call site.
 *
 * The input is typed by what this function actually reads — a block's `type`
 * discriminator and, for text blocks, its `text`. That covers the narrow
 * user/custom `(TextContent | ImageContent)[]` union and the wider message
 * union (which also carries thinking and tool-call blocks) without a cast;
 * non-text, non-image blocks are simply skipped.
 *
 * Assistant message content has its own owner, `assistantText` in @veyyon/ai;
 * prefer that when you already hold an `AssistantMessage`.
 */
export interface ContentBlockLike {
	type: string;
	text?: string;
}

export interface ContentTextOptions {
	/** String placed between text blocks. Defaults to a newline. */
	separator?: string;
	/**
	 * How an image block renders: "drop" omits it, any other string is used as
	 * a literal placeholder. Defaults to "drop".
	 */
	image?: "drop" | string;
	/** Trim each text block and skip the ones that become empty. Defaults to false. */
	trimBlocks?: boolean;
	/** Trim the value when the whole content is a plain string. Defaults to false. */
	trimString?: boolean;
}

export function contentText(content: string | readonly ContentBlockLike[], options: ContentTextOptions = {}): string {
	const { separator = "\n", image = "drop", trimBlocks = false, trimString = false } = options;
	if (typeof content === "string") return trimString ? content.trim() : content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			// Guard on `typeof` rather than `?? ""`: at the message boundary a
			// block may be malformed (a non-string `text`), and a bare `.trim()`
			// on that would throw. A non-string text reads as absent here.
			const text = typeof block.text === "string" ? block.text : "";
			const value = trimBlocks ? text.trim() : text;
			if (trimBlocks && value.length === 0) continue;
			parts.push(value);
		} else if (block.type === "image" && image !== "drop") {
			parts.push(image);
		}
	}
	return parts.join(separator);
}
