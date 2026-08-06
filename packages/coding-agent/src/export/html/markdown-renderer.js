/*
 * Markdown rendering for the exported and shared session viewer.
 *
 * This lives in its own file, inlined into the template beside `template.js`, for one reason:
 * it is the sanitizer, and a sanitizer that cannot be tested is a sanitizer nobody has checked.
 * `template.js` is a monolithic DOM script that needs a browser to evaluate; this module needs
 * only a `marked` instance and two small functions, so a test drives the real renderer against
 * real payloads.
 *
 * What it guards. Every markdown token type that can carry markup is overridden:
 *
 *   text      escaped, so a bare `<img src=x onerror=...>` in a transcript renders as characters
 *   codespan  escaped
 *   code      escaped or syntax-highlighted, never passed through raw
 *   html      escaped; marked's default emits raw HTML tokens verbatim
 *   link      scheme-checked; marked's default emits `javascript:` hrefs untouched
 *
 * The last two were missing. Anyone who can land text in a transcript could reach them: a page
 * the fetch tool pulled in, a README in a cloned repo, an MCP tool result, a subagent return, or
 * prompt-injected model text. On `/share` the payload ran on the share origin, which is also the
 * collab web base, so same-origin script could read a live session's room key out of the URL
 * fragment. On `/export` it ran when the operator opened the file.
 */

/**
 * Bind the viewer's markdown renderer onto a `marked` instance.
 *
 * @param {object} marked - the vendored marked module, with `use` and `parse`
 * @param {object} deps
 * @param {(value: string) => string} deps.escapeHtml - entity-escapes `&`, `<`, `>` and `"`
 * @param {(code: string, lang: string | undefined) => string} deps.highlight - returns HTML for a
 *   code block body, already escaped; the viewer passes highlight.js, a test passes an escaper
 * @returns {(text: string) => string} parse a markdown string into sanitized HTML
 */
(function () {
	'use strict';

	function installMarkdownRenderer(marked, deps) {
		const escapeHtml = deps.escapeHtml;
		const highlight = deps.highlight;

		// A second pass over text tokens: marked has already resolved entities, so an escaped `&lt;`
		// arrives back as `<`. Re-escaping a tag opener keeps it inert without mangling prose that
		// merely contains a `<` before a space or a digit.
		function escapeHtmlTags(text) {
			return text.replace(/<(?=[a-zA-Z/])/g, "&lt;");
		}

		// http(s) and mailto pass. A relative or fragment target passes. Anything else that declares a
		// scheme (javascript:, data:, vbscript:) is refused, and the link renders as its own text.
		function safeHref(href) {
			const trimmed = String(href || "").trim();
			if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
			if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
			return trimmed;
		}

		marked.use({
			breaks: true,
			gfm: true,
			renderer: {
				code(token) {
					return `<pre><code class="hljs">${highlight(token.text, token.lang)}</code></pre>`;
				},
				text(token) {
					return escapeHtmlTags(escapeHtml(token.text));
				},
				codespan(token) {
					return `<code>${escapeHtml(token.text)}</code>`;
				},
				html(token) {
					return escapeHtml(token.text);
				},
				link(token) {
					const inner = this.parser.parseInline(token.tokens);
					const url = safeHref(token.href);
					if (url === null) return inner;
					const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : "";
					return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
				},
			},
		});

		return function safeMarkedParse(text) {
			return marked.parse(text);
		};
	}

	// Published as a global, the way the other inlined viewer scripts are. Declaring nothing at
	// top level also keeps the text import in index.ts free of a declaration file.
	globalThis.installMarkdownRenderer = installMarkdownRenderer;
})();
