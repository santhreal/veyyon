/**
 * What the web_search card shows, for any host.
 *
 * The tool half in `index.ts` runs the query; this half states what the card says about the answer it
 * came back with, and names no colour, no glyph and no width. A terminal draws the same panel it
 * always drew through `drawToolView`, and a browser draws its own from the same value: a source is a
 * title, a target a reader can follow and a tail of domain and age, rather than a hyperlink escape
 * around a truncated string, and the answer is a Markdown document the host lays out at its own
 * width instead of rows the tool wrapped for a terminal it was handed.
 *
 * The body is `data`: the answer and the sources are what a provider returned, so the outcome belongs
 * on the card's edge and not painted across the text. The two cards that ARE reports -- a failed
 * query and a response the tool could not read -- state the outcome across the plate, which is what
 * they always did.
 */

import { formatAge, formatCount } from "@veyyon/utils/format";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { StatusRowView, ToolView, ToolViewRenderer, ViewLine, ViewSection, ViewSpan } from "@veyyon/view";
import { PREVIEW_LIMITS } from "../../tools/core/render-limits";
import { getDomain } from "../../tools/core/render-utils";
import { getSearchProviderLabel } from "./provider";
import type { SearchRenderDetails, SearchResponse, SearchSource } from "./types";

/** Sources a collapsed card lists before it says how many it held back. */
const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

/** Lines of an unreadable response a collapsed card shows. */
const FALLBACK_PREVIEW_LINES = 6;

/** The columns a query keeps in a row, which is the length a query is a label at rather than a body. */
const QUERY_LABEL_WIDTH = 80;

/** The arguments the card reads off a web_search call. */
export interface WebSearchViewArgs {
	query?: string;
	/**
	 * The answer lines a one-shot compact caller asks for, which `veyyon q` passes and the TUI does
	 * not.
	 *
	 * A caller that caps the answer is printing the card once and exiting, so nothing in it is
	 * offered as expandable: the note says what was dropped and never how to see it.
	 */
	maxAnswerLines?: number;
}

/** The result the card reads, which is the tool's result shape narrowed to what a card shows. */
export interface WebSearchViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: SearchRenderDetails;
	isError?: boolean;
}

/** `Name: value`, where the name is secondary detail and the value is the text it introduces. */
function metadataLine(name: string, value: string): ViewLine {
	return [{ text: `${name}:`, tone: "muted" }, { text: ` ${value}` }];
}

/** The provider a card reports, by the label it is known by, or nothing when no provider ran. */
function providerLabelOf(provider: SearchResponse["provider"] | undefined): string | undefined {
	if (provider === undefined || provider === "none") return undefined;
	return getSearchProviderLabel(provider);
}

/** The head row of a card that failed, which names the provider that failed if one was reached. */
function errorHeader(details: SearchRenderDetails | undefined): StatusRowView {
	return {
		kind: "statusRow",
		status: "error",
		title: "Web Search",
		description: providerLabelOf(details?.response?.provider),
	};
}

/** A failed query, whose body is the message and nothing else. */
function errorView(message: string, details: SearchRenderDetails | undefined): ToolView {
	return {
		kind: "framedBlock",
		header: errorHeader(details),
		state: "error",
		sections: [{ lines: [[{ text: `Error: ${replaceTabs(message)}`, tone: "error" }]] }],
	};
}

/**
 * A response the tool could not read, shown as the text it returned.
 *
 * The lines are one row each: an unstructured response is a listing rather than prose, so a line too
 * long for the card ends where the columns do instead of becoming two rows of a body whose every
 * other entry is one.
 */
function fallbackView(contentText: string, expanded: boolean): ToolView {
	const lines = contentText.split("\n").filter(line => line.trim());
	const shown = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
	const remaining = lines.length - shown.length;
	return {
		kind: "framedBlock",
		header: { kind: "statusRow", status: "warning", title: "Web Search", description: "Response" },
		state: "warning",
		sections: [
			{
				lines:
					shown.length > 0
						? shown.map((line): ViewLine => [{ text: line.trim(), tone: "dim" }])
						: [[{ text: "No response data", tone: "muted" }]],
				clip: true,
				hidden:
					remaining > 0
						? { count: remaining, noun: { one: "line", many: "lines" }, revealable: !expanded }
						: undefined,
			},
		],
	};
}

/**
 * The answer, as the Markdown document the provider wrote.
 *
 * A compact caller's cap is applied to the document's own lines rather than to the rows a terminal
 * wraps them into, because the rows are the host's answer and the tool never sees a width. So the
 * note states the lines of the answer the card is not showing.
 */
function answerSection(answer: string, args: WebSearchViewArgs | undefined, expanded: boolean): ViewSection {
	const text = answer.trim();
	if (!text) return { label: "Answer", lines: [[{ text: "No answer text returned", tone: "muted" }]] };
	const cap = args?.maxAnswerLines;
	if (cap === undefined || expanded) return { label: "Answer", lines: [[{ text }]], markdown: true };
	const lines = text.split("\n");
	const kept = lines.slice(0, cap);
	const remaining = lines.length - kept.length;
	return {
		label: "Answer",
		lines: [[{ text: kept.join("\n") }]],
		markdown: true,
		// A one-shot caller printed the card and exited, so the count is stated and no gesture with it.
		hidden: remaining > 0 ? { count: remaining, noun: { one: "line", many: "lines" }, revealable: false } : undefined,
	};
}

/**
 * One source: its title, the page it names, and the domain and age it came from.
 *
 * The domain and the age are the row's tail, so a host that lays a row out in columns keeps them and
 * cuts the title, which is the reading main's own budget arithmetic had: the meta kept every column
 * it asked for and the title took what was left.
 */
function sourceLine(source: SearchSource): ViewLine {
	const url = typeof source.url === "string" ? source.url : "";
	const titleText =
		typeof source.title === "string" && source.title.trim() ? source.title : url.trim() ? url : "Untitled";
	const age = formatAge(source.ageSeconds) || (typeof source.publishedDate === "string" ? source.publishedDate : "");
	const domain = url ? getDomain(url) : "";
	const row: ViewSpan[] = [{ text: titleText, tone: "accent", link: url || undefined }];
	if (domain) row.push({ text: `(${domain})`, tone: "dim", trailing: true });
	// The space is the tool's, because a host puts nothing between two runs it was handed: the domain
	// and the age are two facts of one aside, and the row states how they are read together.
	if (age) row.push({ text: domain ? ` ${age}` : age, tone: "muted", trailing: true });
	return row;
}

/** The sources the answer rests on, and how many of them a collapsed card is not listing. */
function sourcesSection(sources: readonly SearchSource[], expanded: boolean): ViewSection {
	const shown = expanded ? sources : sources.slice(0, MAX_COLLAPSED_ITEMS);
	const remaining = sources.length - shown.length;
	return {
		label: "Sources",
		lines: shown.length > 0 ? shown.map(sourceLine) : [[{ text: "No sources returned", tone: "muted" }]],
		clip: true,
		hidden:
			remaining > 0
				? { count: remaining, noun: { one: "source", many: "sources" }, revealable: !expanded }
				: undefined,
	};
}

/** What the query cost and which model answered it, as the provider reported them. */
function metadataSection(response: SearchResponse, providerLabel: string): ViewSection {
	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const lines: ViewLine[] = [metadataLine("Provider", providerInfo)];
	const usage = response.usage;
	if (usage) {
		const parts: string[] = [];
		if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
		if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
		if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
		if (usage.searchRequests !== undefined) parts.push(`search ${usage.searchRequests}`);
		// Joined by the tool because these are its words: a host's separator belongs between the facts of
		// a row it lays out, and this is one fact stated as a sentence.
		if (parts.length > 0) lines.push(metadataLine("Usage", parts.join(", ")));
	}
	return { label: "Metadata", lines };
}

/** How web_search describes its call and its result. */
export const webSearchToolView: Required<ToolViewRenderer<WebSearchViewArgs, WebSearchViewResult>> = {
	renderCall(args): ToolView {
		return {
			kind: "statusRow",
			status: "pending",
			title: "Web Search",
			description: truncateToWidth(args?.query ?? "", QUERY_LABEL_WIDTH),
		};
	},

	renderResult(result, context, args): ToolView {
		const details = result.details;
		if (details?.error) return errorView(details.error, details);
		const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
		const response = details?.response;
		if (!response) return fallbackView(rawText, context.expanded);

		const sources = Array.isArray(response.sources) ? response.sources : [];
		const searchQueries = Array.isArray(response.searchQueries)
			? response.searchQueries.filter((item): item is string => typeof item === "string")
			: [];
		const providerLabel = response.provider !== "none" ? getSearchProviderLabel(response.provider) : "None";
		const answer = typeof response.answer === "string" ? response.answer.trim() : "";
		const queryText = args?.query ?? searchQueries[0];
		const found = sources.length > 0;

		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				// A card that found sources is titled by the tool's own mark; one that found none reports
				// that, which is the only thing about the query worth an outcome icon.
				...(found ? { emblem: "tool.webSearch" } : { status: "warning" as const }),
				title: "Web Search",
				description: providerLabel,
				meta: [[{ text: formatCount("source", sources.length) }]],
			},
			state: found ? "success" : "warning",
			// The answer and its sources are what the provider returned, not a verdict on them.
			contents: "data",
			sections: [
				...(queryText
					? [{ lines: [metadataLine("Query", truncateToWidth(queryText, QUERY_LABEL_WIDTH))] }]
					: []),
				answerSection(answer || rawText, args, context.expanded),
				sourcesSection(sources, context.expanded),
				metadataSection(response, providerLabel),
			],
		};
	},
};
