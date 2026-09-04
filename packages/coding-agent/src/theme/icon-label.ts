/**
 * Join an icon to the text it labels, leaving no gap when the icon is empty.
 *
 * An icon in a symbol preset is allowed to be EMPTY, and in the unicode preset
 * thirty-one of them are: `icon.model`, `icon.git`, `icon.context`, `icon.cost`,
 * `icon.job`, `icon.agents`, `icon.cache`, `icon.throughput` and more all render
 * as the empty string there. Writing `` `${theme.icon.job} ${count}` `` then
 * produces a leading space and an unlabelled number: the status line shows ` 5`
 * where it means `⚙ 5`, and the reader cannot tell what the five counts.
 *
 * The separator belongs to the join, not to the caller, so it exists only when
 * there is something to separate. This was a private helper inside the status
 * line's segment builders while a dozen other surfaces wrote the template by
 * hand, which is why the bug was visible in some rows of the same line and not
 * others.
 *
 * A leaf module with no imports on purpose: every icon-rendering surface can
 * take it without pulling the theme engine in behind it, the same discipline
 * `./symbol-theme` documents for itself.
 */
export function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}
