import type { CustomQueryHandler } from "puppeteer-core";

/** The puppeteer query handler for Playwright's `:has-text()`: its registered name and selector prefix. */
export const HAS_TEXT_HANDLER = "veyyonHasText";

/** What a has-text selector asks for, as its payload after `veyyonHasText/` carries it. */
export interface HasTextQuery {
	readonly css: string;
	readonly text: string;
}

/** The selector puppeteer resolves through {@link hasTextQueryHandler}. */
export function hasTextSelector(query: HasTextQuery): string {
	return `${HAS_TEXT_HANDLER}/${JSON.stringify(query)}`;
}

/**
 * The elements under the root that match the payload's CSS and whose text holds its text, case and
 * spacing aside, as Playwright's `:has-text()` matches, less any that holds another match: a bare
 * `:has-text("Save")` is the element with the text, not `<body>`. An element's text is Playwright's
 * `elementText`: its text nodes and its children's text, a shadow root's included, and a submit or
 * button input's value; a `<script>`, `<noscript>`, `<style>` or anything in `<head>` has none, so a
 * page whose `<title>` or inline script holds the text still resolves to the element showing it.
 * Puppeteer serializes these functions into the page, so they reach nothing outside themselves.
 */
export const hasTextQueryHandler: CustomQueryHandler = {
	queryAll: (root, payload) => {
		interface TextNode {
			readonly nodeType: number;
			readonly nodeName: string;
			readonly nodeValue: string | null;
			readonly childNodes: ArrayLike<TextNode>;
			readonly shadowRoot?: TextNode | null;
			readonly type?: string;
			readonly value?: string;
			readonly ownerDocument: { readonly head: { contains(other: TextNode): boolean } | null } | null;
			contains(other: TextNode): boolean;
		}
		const query = JSON.parse(payload) as { css: string; text: string };
		const fold = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
		const wanted = fold(query.text);
		const texts = new Map<TextNode, string>();
		const textOf = (node: TextNode): string => {
			const known = texts.get(node);
			if (known !== undefined) return known;
			let text = "";
			const skipped =
				node.nodeName === "SCRIPT" ||
				node.nodeName === "NOSCRIPT" ||
				node.nodeName === "STYLE" ||
				node.ownerDocument?.head?.contains(node) === true;
			if (!skipped) {
				if (node.nodeName === "INPUT" && (node.type === "submit" || node.type === "button")) {
					text = node.value ?? "";
				} else {
					for (const child of Array.from(node.childNodes)) {
						// A text node is 3 and a CDATA section 4; a comment or processing instruction holds no text.
						if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue ?? "";
						else if (child.nodeType === 1) text += textOf(child);
					}
					if (node.shadowRoot) text += textOf(node.shadowRoot);
				}
			}
			texts.set(node, text);
			return text;
		};
		const scope = root as unknown as { querySelectorAll(css: string): ArrayLike<TextNode> };
		const matches = Array.from(scope.querySelectorAll(query.css)).filter(element =>
			fold(textOf(element)).includes(wanted),
		);
		const innermost = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));
		return innermost as unknown as Iterable<typeof root>;
	},
};
