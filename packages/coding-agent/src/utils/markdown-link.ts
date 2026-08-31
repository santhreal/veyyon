/**
 * Build an inline GitHub-flavored Markdown link, `[text](url)`, that survives
 * external data in either half. This is the single owner of Markdown-link
 * construction for producers that interpolate scraped text and URLs; import it
 * rather than hand-rolling another `` `[${text}](${url})` `` template.
 *
 * Two different characters break the two halves of a link:
 *   - In the text, an unescaped `]` closes the label early (`[[2024] Report]`
 *     becomes `[2024`), so `[`, `]`, and the escape character `\` are
 *     backslash-escaped, and newlines collapse to a space.
 *   - In a bare destination, an unescaped `)` closes the link early (a
 *     Wikipedia `/wiki/Foo_(disambiguation)` URL truncates at the first `)`),
 *     an unbalanced `(` is equally unsafe, and a raw space ends the
 *     destination. Those three are percent-encoded (`%28`, `%29`, `%20`), which
 *     every server decodes back to the original character, so the link resolves
 *     to exactly the same resource. Newlines and tabs are stripped.
 *
 * The sibling `escapeMarkdownTableCell` owns table-cell escaping; this owns
 * links. Keep them separate: a table cell escapes `|`, a link escapes brackets
 * and parentheses, and mixing the two contracts corrupts one surface or the
 * other.
 */

/** Escape link *label* text so `[`/`]` cannot truncate it. */
export function markdownLinkText(text: string): string {
	return text
		.replace(/[\r\n]+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/([[\]])/g, "\\$1");
}

/**
 * Make a URL safe as a bare Markdown link *destination*: percent-encode the
 * characters that would end it early (`(`, `)`, space) and strip newlines/tabs.
 * `%28`/`%29`/`%20` round-trip to `(`/`)`/space on the server, so the target is
 * unchanged.
 */
export function markdownLinkUrl(url: string): string {
	return url
		.replace(/[\r\n\t]+/g, "")
		.replace(/ /g, "%20")
		.replace(/\(/g, "%28")
		.replace(/\)/g, "%29");
}

/** Build `[text](url)` with both halves escaped for external content. */
export function markdownLink(text: string, url: string): string {
	return `[${markdownLinkText(text)}](${markdownLinkUrl(url)})`;
}
