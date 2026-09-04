import type * as turndownModule from "@veyyon/utils/turndown";
import type TurndownService from "turndown";

/**
 * Cached import of the (heavy) turndown module. Lazy so turndown and
 * turndown-plugin-gfm stay off the startup graph; memoized so `createTurndown`
 * and `normalizeTablesHtml` share a single dynamic import.
 */
let turndownModulePromise: Promise<typeof turndownModule> | undefined;

function getTurndownModule(): Promise<typeof turndownModule> {
	turndownModulePromise ||= import("@veyyon/utils/turndown");
	return turndownModulePromise;
}

/** Module-level Turndown instance — built lazily on first use. */
let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= getTurndownModule().then(module => module.createTurndown());
	return turndownPromise;
}

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion, then normalizes tables so a
 * `<td>`-first table (no explicit `<thead>`) still renders as a GFM table rather
 * than being kept as a raw `<table>` blob — the same normalization the markit
 * docx/epub converters apply.
 */
export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const [module, turndown] = await Promise.all([getTurndownModule(), getTurndown()]);
	return turndown.turndown(module.normalizeTablesHtml(cleaned)).trim();
}
