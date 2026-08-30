/**
 * The row a surface shows when it is holding content back.
 *
 * WHY THIS HAS AN OWNER. Thirty-nine surfaces wrote this row and no two agreed
 * on its shape: the advisor note card said `… +3 more notes`, the subagent comms
 * view `… 3 more lines · e expand`, the hook picker `[…3 more lines…]`, the
 * tool-tier notice `… +3 more (e to expand)` in italic muted, the LSP hover, the
 * tree lists and the todo reminder the same count in `muted` while the block
 * right above them used `dim`, the reminder invented `… 3 more in todo state`,
 * and half of them rolled their own plural, so a fold of one line read `… 1 more
 * lines`. Four decorations, three weights and two ways of naming the key, for one
 * fact: there is more, and here is how much.
 *
 * The row is the ellipsis, the counted phrase and — when the surface has a key
 * to name — the expand hint, in the product's one spelling of it. Indentation
 * and any rail belong to the caller, because a transcript note hangs from a rail
 * the card grammar does not have.
 *
 * {@link foldText} is the same sentence unpainted, for a caller that measures the
 * row before it fits it or wraps it in an envelope of its own. Text written for
 * the model rather than the screen — a todo digest, a workspace tree, a `--json`
 * pointer — takes the phrase straight from `formatMore` instead, since none of it
 * is a row and none of it may reach a painter.
 */
import { formatMore } from "@veyyon/utils/format";
import { theme } from "../theme/theme-binding";
import type { Theme } from "../theme/theme-class";
import { expandHintFor } from "../utils/key-hint";

export interface FoldRowOptions {
	/** What is hidden, singular; pluralised by the count. Defaults to `line`. */
	noun?: string;
	/**
	 * The chord that shows the rest, already spelled by `keyHint`. Omitted, or
	 * empty for a surface with nothing bound, and the row states the count alone.
	 */
	expandKey?: string;
	/**
	 * The theme to paint with. A message renderer is handed one — the HTML export
	 * renders a transcript in a theme that is not the session's — and a card reads
	 * the active one.
	 */
	theme?: Theme;
}

/** `… 3 more lines (<key> to expand)`, unpainted, for a caller that measures it. */
export function foldText(hidden: number, options: Pick<FoldRowOptions, "noun" | "expandKey"> = {}): string {
	const phrase = formatMore(options.noun ?? "line", hidden);
	return `… ${phrase}${expandHintFor(options.expandKey ?? "")}`;
}

/** `… 3 more lines (<key> to expand)`, in the one weight a fold row takes. */
export function foldRow(hidden: number, options: FoldRowOptions = {}): string {
	return (options.theme ?? theme).fg("dim", foldText(hidden, options));
}
