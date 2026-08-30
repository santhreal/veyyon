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
 *
 * {@link droppedRow} is the row's sibling, and the split is the whole reason both
 * live here. A fold row is an offer: the content is held and a key reveals it, so
 * it is quiet. A dropped row is a loss: the content is gone and no key brings it
 * back, so it carries the warning weight and never names an expand key. Five
 * surfaces used to state that loss in the fold row's own clothes — `... (widget
 * truncated)` in muted with three literal dots, `(truncated at line 20)` in dim
 * twice, an error block's `… 3 more lines` in muted, a rebuilt branch's `3 tool
 * calls elided —` in dim italic — so a row that could never expand looked exactly
 * like the one below it that could, and the streaming drop spelled its own plural
 * and read `1 earlier lines dropped`.
 */
import { formatCount, formatMore } from "@veyyon/utils/format";
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

export interface DroppedRowOptions {
	/** What is gone, singular; pluralised by the count. Defaults to `line`. */
	noun?: string;
	/**
	 * Why it is gone, stated last in parentheses, in the same slot the withheld
	 * -picture row puts its cause. Omitted when the surface has nothing to add
	 * beyond the count.
	 */
	cause?: string;
	/** The theme to paint with, for a renderer handed one rather than reading the active theme. */
	theme?: Theme;
}

/** `… 3 lines dropped (preview limit)`, unpainted, for a caller that measures it. */
export function droppedText(dropped: number, options: Pick<DroppedRowOptions, "noun" | "cause"> = {}): string {
	const phrase = formatCount(options.noun ?? "line", dropped);
	const cause = options.cause ? ` (${options.cause})` : "";
	return `… ${phrase} dropped${cause}`;
}

/** `… 3 lines dropped (preview limit)`, in the one weight a loss takes. */
export function droppedRow(dropped: number, options: DroppedRowOptions = {}): string {
	return (options.theme ?? theme).fg("warning", droppedText(dropped, options));
}
