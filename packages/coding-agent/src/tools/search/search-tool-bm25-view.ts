/**
 * What the tool-discovery card shows, for any host.
 *
 * The tool half in `search-tool-bm25.ts` decides which tools a query matched; this half states what
 * the card says about them and names no colour, no glyph and no width. The matches are a list, so
 * the card states one line per tool and the count it kept back, and the host draws the marks, the
 * indent and the sentence that says how to see the rest.
 */

import { truncateToWidth } from "@veyyon/utils/width";
import type {
	FramedBlockView,
	HeadedBlockView,
	StatusRowView,
	ToolView,
	ToolViewRenderer,
	ViewLine,
	ViewSpan,
} from "@veyyon/view";
import { formatCount, replaceTabs, TRUNCATE_LENGTHS } from "../core/render-utils";
import type { SearchToolBm25Details, SearchToolBm25Match, SearchToolBm25Params } from "./search-tool-bm25";

/** Matches a collapsed card lists before it says how many more it found. */
export const COLLAPSED_MATCH_LIMIT = 5;

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface SearchToolBm25ViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: SearchToolBm25Details;
	isError?: boolean;
}

/** What every card of this tool is titled. */
const TOOL_DISCOVERY_TITLE = "Tool Discovery";

/** The emblem a card with matches is titled by, instead of an outcome icon. */
const SEARCH_EMBLEM = "icon.search";

/** Columns a matched tool's label keeps, which is also the budget the header gives the query. */
const MATCH_LABEL_LEN = 72;

/** Columns a matched tool's summary keeps, so one verbose description does not fill the card. */
const MATCH_DESCRIPTION_LEN = 96;

/** The unit the held-back count is in, which the host words. */
const MATCH_NOUN = { one: "tool", many: "tools" } as const;

/** One matched tool: what it is called, where it came from, how well it scored and what it does. */
function matchLine(match: SearchToolBm25Match): ViewLine {
	const spans: ViewSpan[] = [{ text: truncateToWidth(replaceTabs(match.label), MATCH_LABEL_LEN), tone: "accent" }];
	if (match.server_name) spans.push({ text: ` ${replaceTabs(match.server_name)}`, tone: "muted" });
	spans.push({ text: ` score ${match.score.toFixed(3)}`, tone: "dim" });
	const description = replaceTabs(match.description.trim());
	if (description) {
		spans.push({ text: ` ${truncateToWidth(description, MATCH_DESCRIPTION_LEN)}`, tone: "muted" });
	}
	return spans;
}

/**
 * The card a result with no details shows, which is whatever text the tool did return.
 *
 * A result that carries no details is a run that ended some other way than by searching — the
 * discovery mode was off, the inventory could not be read — so the card reports the text rather
 * than framing an empty list.
 */
function fallbackCard(text: string): HeadedBlockView {
	return {
		kind: "headedBlock",
		header: { kind: "statusRow", status: "warning", title: TOOL_DISCOVERY_TITLE },
		lines: (text || "Tool discovery completed")
			.split("\n")
			.map(line => [{ text: truncateToWidth(replaceTabs(line), TRUNCATE_LENGTHS.LINE), tone: "dim" }] as ViewLine),
	};
}

/** The row a settled card is headed by: what was searched, and what the search cost and found. */
function resultHeader(details: SearchToolBm25Details): StatusRowView {
	const matched = details.tools.length > 0;
	return {
		kind: "statusRow",
		...(matched ? { emblem: SEARCH_EMBLEM } : { status: "warning" as const }),
		title: TOOL_DISCOVERY_TITLE,
		description: truncateToWidth(replaceTabs(details.query), MATCH_LABEL_LEN),
		meta: [
			[{ text: formatCount("match", details.tools.length) }],
			[{ text: `${details.active_selected_tools.length} active` }],
			[{ text: `${details.total_tools} total` }],
			[{ text: `limit:${details.limit}` }],
		],
	};
}

export const searchToolBm25ToolView: Required<ToolViewRenderer<SearchToolBm25Params, SearchToolBm25ViewResult>> = {
	renderCall(args): StatusRowView {
		const query = typeof args.query === "string" ? replaceTabs(args.query.trim()) : "";
		return {
			kind: "statusRow",
			status: "pending",
			title: TOOL_DISCOVERY_TITLE,
			description: query || "(empty query)",
			meta: args.limit ? [[{ text: `limit:${args.limit}` }]] : undefined,
		};
	},

	renderResult(result, context): ToolView {
		const details = result.details;
		if (!details) {
			return fallbackCard(
				result.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.filter((text): text is string => typeof text === "string" && text.length > 0)
					.join("\n"),
			);
		}
		const header = resultHeader(details);
		if (details.tools.length === 0) {
			return {
				kind: "headedBlock",
				header,
				lines: [
					[
						{
							text:
								details.total_tools === 0
									? "No discoverable tools are currently loaded."
									: "No matching tools found.",
							tone: "muted",
						},
					],
				],
			};
		}
		// The card cuts the list itself and says how much it cut, because how many matches are worth
		// a collapsed card is the tool's judgement and how the reader asks for the rest is the host's.
		const shown = context.expanded ? details.tools.length : Math.min(details.tools.length, COLLAPSED_MATCH_LIMIT);
		const held = details.tools.length - shown;
		const card: FramedBlockView = {
			kind: "framedBlock",
			header,
			state: "success",
			// A record of what the inventory holds, not an outcome the card reports: the state belongs
			// to the search that produced it and the body is the listing it found.
			contents: "listing",
			sections: [
				{
					list: true,
					lines: details.tools.slice(0, shown).map(matchLine),
					...(held > 0 ? { hidden: { count: held, noun: MATCH_NOUN, revealable: !context.expanded } } : {}),
				},
			],
		};
		return card;
	},
};
