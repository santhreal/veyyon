/** The option labels the ask runtime adds to a question, and which no caller may use for an option of its own. These three strings are not decoration. Each one is compared by STRING EQUALITY against whatever the picker */

/** The fourth label of this family, ` (Recommended)`, is NOT here. It is the only one a package outside coding-agent has to read: `@veyyon/tool-render` strips it when rendering an answer for HTML export and */

/** Opens the free-text prompt so the user can answer in their own words. */
export const ASK_OTHER_OPTION_LABEL = "Other (type your own)";

/** Abandons the question and returns to the conversation. */
export const ASK_CHAT_OPTION_LABEL = "Chat about this";

/** Advances to the next question in a multi-question ask. The arrow is part of the label and not a separate glyph: it is compared as bytes, so a plain-ASCII `->` */
export const ASK_NEXT_OPTION_LABEL = "Next →";

/** Every label the runtime may add, in the order a reader should think about them: answer differently, leave, or move on. */
export const RESERVED_ASK_OPTION_LABELS: readonly string[] = [
	ASK_OTHER_OPTION_LABEL,
	ASK_CHAT_OPTION_LABEL,
	ASK_NEXT_OPTION_LABEL,
];

/** Whether a caller-supplied option label collides with one the runtime adds. */
export function isReservedAskOptionLabel(label: string): boolean {
	return RESERVED_ASK_OPTION_LABELS.includes(label);
}
