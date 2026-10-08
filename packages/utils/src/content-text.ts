/**
 * Text of a message-content value, which is either a plain string or an array
 * of content blocks.
 *
 * This is the one owner for that flattening, across every package. Call sites
 * differ in ways a reader sees — the join separator, whether an image becomes a
 * placeholder or nothing, whether text is trimmed — so those differences are
 * options here rather than a helper, or a second owner, per variant.
 *
 * The input is `unknown` because callers pass provider payloads whose shape is
 * not guaranteed. A block contributes text only when it is an object with
 * `type === "text"` and a string `text`. Everything else contributes nothing at
 * all rather than an empty slot between two separators: a thinking block, a
 * tool call, a loose non-object, and a malformed text block whose `text` is
 * absent or is not a string. A malformed block carries no text, so it renders
 * like the other blocks that carry none.
 *
 * Assistant message content has its own owner, `assistantText` in `@veyyon/ai`;
 * prefer that when you already hold an `AssistantMessage`.
 */

/** The shape this reads: a block's discriminator and, for text blocks, its text. */
export interface ContentBlockLike {
	type: string;
	text?: string;
}

export interface ContentTextOptions {
	/** String placed between rendered blocks. Defaults to a newline. */
	separator?: string;
	/**
	 * How an image block renders: `"drop"` omits it, any other string is used as
	 * a literal placeholder. Defaults to `"drop"`.
	 */
	image?: "drop" | string;
	/** Trim each text block and skip the ones that become empty. Defaults to false. */
	trimBlocks?: boolean;
	/** Trim the value when the whole content is a plain string. Defaults to false. */
	trimString?: boolean;
}

export function contentText(content: unknown, options: ContentTextOptions = {}): string {
	const { separator = "\n", image = "drop", trimBlocks = false, trimString = false } = options;
	if (typeof content === "string") return trimString ? content.trim() : content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const part = blockPart(block, image, trimBlocks);
		if (part !== undefined) parts.push(part);
	}
	return parts.join(separator);
}

/** The fields of an untrusted block that {@link contentText} reads. */
interface UntrustedBlock {
	type?: unknown;
	text?: unknown;
}

/** What one block contributes: its text, the image placeholder, or nothing. */
function blockPart(block: unknown, image: string, trimBlocks: boolean): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	const { type, text } = block as UntrustedBlock;
	if (type === "image") return image === "drop" ? undefined : image;
	if (type !== "text" || typeof text !== "string") return undefined;
	if (!trimBlocks) return text;
	const value = text.trim();
	return value.length === 0 ? undefined : value;
}
