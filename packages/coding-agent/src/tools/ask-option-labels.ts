/**
 * The option labels the ask runtime adds to a question, and which no caller may use for an option of its own.
 *
 * These three strings are not decoration. Each one is compared by STRING EQUALITY against whatever the picker
 * hands back, and the comparison is what decides the behaviour: `Other (type your own)` opens the free-text
 * prompt, `Chat about this` abandons the question and returns to the conversation, `Next →` advances to the
 * following question. So a label that is rendered in one module and compared in another has to be the same
 * bytes in both, and if it is not, the branch simply never fires. The selection is handed back to the model as
 * a literal answer of "Other (type your own)", nothing throws, and nothing is logged.
 *
 * WHAT WAS SPREAD OUT. All three were declared in `tools/ask.ts`, which renders the options and compares the
 * result, and again in `modes/controllers/extension-ui-controller.ts`, which does the same for the extension UI
 * path, under a second set of names (`ASK_OTHER_OPTION`, `ASK_CHAT_OPTION`, `ASK_NEXT_OPTION`).
 * `modes/components/ask-dialog.ts` held a third copy of the first one, because it is the module that draws the
 * row. Three modules, two spellings per label, and no test compared them.
 *
 * The reserved-label CONTRACT made the split worse rather than harmless. `tools/ask.ts` validates the model's
 * question against these labels and rejects a question whose own options collide with one, so the check and the
 * rendering had to agree about the same three strings while reading two different declarations of them. The
 * prompt in `prompts/tools/ask.md` states the first label verbatim, telling the model not to add its own
 * "Other" option, so a drift there means the user sees two.
 *
 * This module has no imports, so the dialog and the controller pay one module for a label rather than reaching
 * into the tool that owns the whole ask flow.
 */

/** Opens the free-text prompt so the user can answer in their own words. */
export const ASK_OTHER_OPTION_LABEL = "Other (type your own)";

/** Abandons the question and returns to the conversation. */
export const ASK_CHAT_OPTION_LABEL = "Chat about this";

/**
 * Advances to the next question in a multi-question ask.
 *
 * The arrow is part of the label and not a separate glyph: it is compared as bytes, so a plain-ASCII `->`
 * written by hand somewhere would look the same in a terminal and never match.
 */
export const ASK_NEXT_OPTION_LABEL = "Next →";

/**
 * Every label the runtime may add, in the order a reader should think about them: answer differently, leave, or
 * move on.
 *
 * A question whose own options collide with one of these is rejected, because the collision is unresolvable at
 * selection time. The picker returns a label, not an index, so an option genuinely labelled "Other (type your
 * own)" would be indistinguishable from the runtime's own row and the user's answer would be replaced by an
 * empty free-text prompt.
 */
export const RESERVED_ASK_OPTION_LABELS: readonly string[] = [
	ASK_OTHER_OPTION_LABEL,
	ASK_CHAT_OPTION_LABEL,
	ASK_NEXT_OPTION_LABEL,
];

/** Whether a caller-supplied option label collides with one the runtime adds. */
export function isReservedAskOptionLabel(label: string): boolean {
	return RESERVED_ASK_OPTION_LABELS.includes(label);
}
