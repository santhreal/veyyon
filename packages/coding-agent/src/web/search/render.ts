/**
 * Web Search TUI Rendering
 *
 * Tree-based rendering with collapsed/expanded states for web search results.
 */

import type { Component } from "@veyyon/tui";
import { Markdown } from "@veyyon/tui/components/markdown";
import { Text } from "@veyyon/tui/components/text";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import type { Theme } from "../../modes/theme/theme";
import {
	formatAge,
	formatCount,
	formatMoreItems,
	getDomain,
	PREVIEW_LIMITS,
	replaceTabs,
	truncateToWidth,
} from "../../tools/render-utils";
import { framedBlock, outputBlockContentWidth, renderStatusLine, urlHyperlink } from "../../tui";
import { getSearchProviderLabel } from "./provider";
import type { SearchResponse } from "./types";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function renderFallbackText(contentText: string, expanded: boolean, theme: Theme): Component {
	const header = renderStatusLine(
		{
			icon: "warning",
			title: "Web Search",
			description: "Response",
		},
		theme,
	);
	const lines = contentText.split("\n").filter(line => line.trim());
	return framedBlock(theme, width => {
		const maxLines = expanded ? lines.length : 6;
		const contentWidth = outputBlockContentWidth(width);
		const displayLines = lines.slice(0, maxLines).map(line => truncateToWidth(line.trim(), contentWidth));
		const remaining = lines.length - displayLines.length;
		const bodyLines: string[] = [];
		if (displayLines.length === 0) {
			bodyLines.push(theme.fg("muted", "No response data"));
		} else {
			for (const l of displayLines) {
				bodyLines.push(theme.fg("dim", l));
			}
			if (!expanded && remaining > 0) {
				bodyLines.push(theme.fg("muted", formatMoreItems(remaining, "line")));
			}
		}
		return {
			header,
			state: "warning",
			sections: [{ lines: bodyLines }],
			width,
		};
	});
}

export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

/** Render a web search failure as a framed error panel, matching the success layout. */
function renderSearchErrorPanel(message: string, providerLabel: string | undefined, theme: Theme): Component {
	const header = renderStatusLine({ icon: "error", title: "Web Search", description: providerLabel }, theme);
	const body = theme.fg("error", `Error: ${replaceTabs(message)}`);
	return framedBlock(theme, width => ({
		header,
		state: "error",
		sections: [{ lines: [body] }],
		width,
	}));
}

/** Render web search result with tree-based layout */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;

	// Handle error case as a framed panel, matching the success layout.
	if (details?.error) {
		const errorProvider = details.response?.provider;
		const errorProviderLabel =
			errorProvider && errorProvider !== "none" ? getSearchProviderLabel(errorProvider) : undefined;
		return renderSearchErrorPanel(details.error, errorProviderLabel, theme);
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	const response = details?.response;
	if (!response) {
		return renderFallbackText(rawText, options.expanded, theme);
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const sourceCount = sources.length;
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const provider = response.provider;

	// Get answer text
	const answerText = typeof response.answer === "string" ? response.answer.trim() : "";
	const contentText = answerText || rawText;

	const providerLabel = provider !== "none" ? getSearchProviderLabel(provider) : "None";
	const queryPreview = args?.query
		? truncateToWidth(args.query, 80)
		: searchQueries[0]
			? truncateToWidth(searchQueries[0], 80)
			: undefined;
	const success = sourceCount > 0;
	const header = renderStatusLine(
		success
			? {
					iconOverride: theme.styledSymbol("tool.webSearch", "accent"),
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount)],
				}
			: {
					icon: "warning",
					title: "Web Search",
					description: providerLabel,
					meta: [formatCount("source", sourceCount)],
				},
		theme,
	);

	const authShort =
		response.authMode === "oauth" ? "OAuth" : response.authMode === "api_key" ? "API" : response.authMode;
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const metaLines: string[] = [`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerInfo)}`];
	if (response.usage) {
		const usageParts: string[] = [];
		if (response.usage.inputTokens !== undefined) usageParts.push(`in ${response.usage.inputTokens}`);
		if (response.usage.outputTokens !== undefined) usageParts.push(`out ${response.usage.outputTokens}`);
		if (response.usage.totalTokens !== undefined) usageParts.push(`total ${response.usage.totalTokens}`);
		if (response.usage.searchRequests !== undefined) usageParts.push(`search ${response.usage.searchRequests}`);
		if (usageParts.length > 0)
			metaLines.push(`${theme.fg("muted", "Usage:")} ${theme.fg("text", usageParts.join(theme.sep.dot))}`);
	}

	const answerMarkdown = contentText ? new Markdown(contentText, 0, 0, getMarkdownTheme()) : undefined;

	return framedBlock(theme, width => {
		// Read mutable state at render time
		const { expanded } = options;

		// Answer lines: full markdown when expanded, capped markdown preview when collapsed.
		const contentWidth = outputBlockContentWidth(width);
		const renderedAnswer = answerMarkdown ? answerMarkdown.render(contentWidth) : [];
		let answerLines: readonly string[];
		if (renderedAnswer.length === 0) {
			answerLines = [theme.fg("muted", "No answer text returned")];
		} else if (args?.maxAnswerLines !== undefined && !expanded) {
			// CLI compact mode (`veyyon q`) caps the answer; the TUI passes no cap and shows it in full.
			// `renderedAnswer` is the Markdown component's shared cache — slice copies before appending.
			const capped = renderedAnswer.slice(0, args.maxAnswerLines);
			const remaining = renderedAnswer.length - capped.length;
			if (remaining > 0) {
				capped.push(theme.fg("muted", formatMoreItems(remaining, "line")));
			}
			answerLines = capped;
		} else {
			answerLines = renderedAnswer;
		}

		const maxSources = expanded ? sources.length : Math.min(sources.length, MAX_COLLAPSED_ITEMS);
		const sourceLines: string[] = [];
		for (let i = 0; i < maxSources; i++) {
			const src = sources[i]!;
			const titleText =
				typeof src.title === "string" && src.title.trim()
					? src.title
					: typeof src.url === "string" && src.url.trim()
						? src.url
						: "Untitled";
			const url = typeof src.url === "string" ? src.url : "";
			const domain = url ? getDomain(url) : "";
			const age = formatAge(src.ageSeconds) || (typeof src.publishedDate === "string" ? src.publishedDate : "");
			const metaParts: string[] = [];
			if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
			if (age) metaParts.push(theme.fg("muted", age));
			const metaSep = theme.fg("dim", theme.sep.dot);
			const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(metaSep)}` : "";
			const titleBudget = Math.max(12, contentWidth - Bun.stringWidth(metaSuffix));
			const title = theme.fg("accent", truncateToWidth(titleText, titleBudget));
			const linkedTitle = url ? urlHyperlink(url, title) : title;
			sourceLines.push(`${linkedTitle}${metaSuffix}`);
		}
		const remainingSources = sources.length - maxSources;
		if (!expanded && remainingSources > 0) {
			sourceLines.push(theme.fg("muted", formatMoreItems(remainingSources, "source")));
		}

		return {
			header,
			state: sourceCount > 0 ? "success" : "warning",
			sections: [
				...(queryPreview
					? [
							{
								lines: [`${theme.fg("muted", "Query:")} ${theme.fg("text", queryPreview)}`],
							},
						]
					: []),
				{
					label: theme.fg("toolTitle", "Answer"),
					lines: answerLines,
				},
				{
					label: theme.fg("toolTitle", "Sources"),
					lines: sourceLines.length > 0 ? sourceLines : [theme.fg("muted", "No sources returned")],
				},
				{ label: theme.fg("toolTitle", "Metadata"), lines: metaLines },
			],
			width,
		};
	});
}

/** Render web search call (query preview) */
export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const query = truncateToWidth(args.query ?? "", 80);
	const text = renderStatusLine({ icon: "pending", title: "Web Search", description: query }, theme);
	return new Text(text, 0, 0);
}

export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	mergeCallAndResult: true,
};
