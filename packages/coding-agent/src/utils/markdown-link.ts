/** Build an inline GitHub-flavored Markdown link, `[text](url)`, that survives external data in either half. This is the single owner of Markdown-link */

/** Escape link *label* text so `[`/`]` cannot truncate it. */
export function markdownLinkText(text: string): string {
	return text
		.replace(/[\r\n]+/g, " ")
		.replace(/\\/g, "\\\\")
		.replace(/([[\]])/g, "\\$1");
}

/** Make a URL safe as a bare Markdown link *destination*: percent-encode the characters that would end it early (`(`, `)`, space) and strip newlines/tabs. */
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
