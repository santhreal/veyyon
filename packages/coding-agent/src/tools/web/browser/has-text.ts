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
 * `:has-text("Save")` is the element with the text, not `<body>`. Puppeteer serializes these functions
 * into the page, so they reach nothing outside themselves.
 */
export const hasTextQueryHandler: CustomQueryHandler = {
	queryAll: (root, payload) => {
		interface Candidate {
			textContent: string | null;
			contains(other: Candidate): boolean;
		}
		const query = JSON.parse(payload) as { css: string; text: string };
		const fold = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
		const wanted = fold(query.text);
		const scope = root as unknown as { querySelectorAll(css: string): ArrayLike<Candidate> };
		const matches = Array.from(scope.querySelectorAll(query.css)).filter(element =>
			fold(element.textContent ?? "").includes(wanted),
		);
		const innermost = matches.filter(element => !matches.some(other => other !== element && element.contains(other)));
		return innermost as unknown as Iterable<typeof root>;
	},
};
