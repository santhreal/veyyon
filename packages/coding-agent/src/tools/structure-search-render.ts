/**
 * Terminal drawing for the structure search tool. The tool half in `structure-search.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../theme/theme";
import {
	Ellipsis,
	fileHyperlink,
	framedBlock,
	outputBlockContentWidth,
	renderStatusLine,
	truncateToWidth,
} from "../tui";
import { classifyGroupedLines, groupLineIndicesByBlank } from "./grouped-file-output";
import { toPathList } from "./path-utils";
import {
	appendParseErrorsBulletList,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatMoreItems,
	formatParseErrorsCountLabel,
	formatScopeMeta,
	replaceTabs,
} from "./render-utils";
import {
	COLLAPSED_MATCH_LIMIT,
	MATCH_LIMIT_NOTICE_PREFIX,
	type StructureSearchDetails,
	type StructureSearchRenderArgs,
} from "./structure-search";

function renderBudgetedAstGrepGroups(
	groups: string[][],
	maxLines: number,
	uiTheme: Theme,
	expanded: boolean,
): string[] {
	if (groups.length === 0 || maxLines <= 0) return [];
	if (expanded) {
		const lines: string[] = [];
		for (const group of groups) {
			lines.push(replaceTabs(group[0]!));
			for (let j = 1; j < group.length; j++) {
				lines.push(`  ${replaceTabs(group[j]!)}`);
			}
		}
		return lines;
	}

	let fittingCount = groups.length;
	let fittedLineCount = 0;
	for (let i = 0; i < groups.length; i++) {
		const count = groups[i]!.length;
		const remainingAfter = groups.length - (i + 1);
		const reservedSummaryLines = remainingAfter > 0 ? 1 : 0;
		if (fittedLineCount + count + reservedSummaryLines > maxLines) {
			fittingCount = i;
			break;
		}
		fittedLineCount += count;
		fittingCount = i + 1;
	}

	const visibleGroups = groups.slice(0, fittingCount);
	const remaining = groups.length - fittingCount;
	const hasSummary = remaining > 0 && (maxLines === Infinity || fittedLineCount < maxLines);

	const lines: string[] = [];
	for (const group of visibleGroups) {
		lines.push(replaceTabs(group[0]!));
		for (let j = 1; j < group.length; j++) {
			lines.push(`  ${replaceTabs(group[j]!)}`);
		}
	}
	if (hasSummary) {
		lines.push(uiTheme.fg("dim", formatMoreItems(remaining, "match")));
	}
	return lines;
}
export const structureSearchRenderer = {
	inline: true,
	renderCall(args: StructureSearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		const scopePaths = toPathList(args.path);
		if (scopePaths.length) meta.push(formatScopeMeta(scopePaths));
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const description = args.input || "?";
		const text = renderStatusLine({ icon: "pending", title: "Search structure", description, meta }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: StructureSearchDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: StructureSearchRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 0, 0);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (matchCount === 0) {
			const description = args?.input;
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "Search structure", description, meta }, uiTheme);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (details?.parseErrors?.length) {
				lines.push(uiTheme.fg("warning", "Query may be mis-scoped; narrow `path` before concluding absence"));
				appendParseErrorsBulletList(lines, details.parseErrors, uiTheme, details.parseErrorsTotal);
			}
			return new Text(lines.join("\n"), 0, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const description = args?.input;
		const header = renderStatusLine(
			{
				...(limitReached
					? { icon: "warning" as const }
					: { iconOverride: uiTheme.fg("accent", uiTheme.symbol("icon.search")) }),
				title: "Search structure",
				description,
				meta,
			},
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across the blank-line groups the tree list collapses by.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		const styledLines = allLines.map((line, index) => {
			const ctx = contexts[index]!;
			if (ctx.kind === "dir") {
				const styled = uiTheme.fg("accent", line);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (ctx.kind === "file") {
				const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (line.startsWith("  meta:")) return uiTheme.fg("dim", line);
			return uiTheme.fg("toolOutput", line);
		});
		const matchGroups = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith(MATCH_LIMIT_NOTICE_PREFIX) && !first.startsWith("Parse issues:");
			})
			.map(indices => indices.map(index => styledLines[index]!));

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; page with skip or narrow path"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}

		return framedBlock(uiTheme, width => {
			const budget = Math.max((options.expanded ? Infinity : COLLAPSED_MATCH_LIMIT) - extraLines.length, 0);
			const matchLines = renderBudgetedAstGrepGroups(matchGroups, budget, uiTheme, Boolean(options.expanded));
			const innerWidth = outputBlockContentWidth(width);
			const bodyLines = [...matchLines, ...extraLines].map(l => truncateToWidth(l, innerWidth, Ellipsis.Omit));
			return {
				header,
				sections: [{ lines: bodyLines }],
				state: limitReached ? "warning" : "success",
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
