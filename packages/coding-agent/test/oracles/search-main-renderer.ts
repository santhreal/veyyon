/**
 * Differential oracle: the search tool's dispatching renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f.
 * Frozen: never edited to make a test pass.
 *
 * `search` is one tool over three searches, so main's entry was a dispatcher: it read the type off
 * the call or the details and handed the card to the file, text or structure view, drawing two rows
 * of its own -- the row for a call whose type has not arrived, and the row for a type that is not one
 * of the three -- plus a standalone error row for a failure that named no type.
 *
 * It imports the three sub-views from this branch rather than freezing copies of them, which is
 * deliberate: each has its own oracle and its own differential suite, so what is unproven here is the
 * dispatcher -- which view a call reaches, and the three rows the dispatcher draws itself. Freezing
 * the sub-views again would restate their suites and hide a dispatch that reached the wrong one.
 *
 * Only the import specifiers are rewritten to the package subpaths this branch publishes.
 */

import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { formatErrorMessage, replaceTabs, TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { FileSearchDetails, FileSearchRenderArgs } from "@veyyon/coding-agent/tools/search/file-search";
import { type FileSearchViewResult, fileSearchToolView } from "@veyyon/coding-agent/tools/search/file-search-view";
import type { SearchToolDetails, SearchToolInput, SearchType } from "@veyyon/coding-agent/tools/search/search";
import type {
	StructureSearchDetails,
	StructureSearchRenderArgs,
} from "@veyyon/coding-agent/tools/search/structure-search";
import {
	type StructureSearchViewResult,
	structureSearchToolView,
} from "@veyyon/coding-agent/tools/search/structure-search-view";
import type { TextSearchDetails, TextSearchRenderArgs } from "@veyyon/coding-agent/tools/search/text-search";
import { type TextSearchViewResult, textSearchToolView } from "@veyyon/coding-agent/tools/search/text-search-view";
import { renderStatusLine, truncateToWidth } from "@veyyon/coding-agent/modes/terminal/draw";
import { drawToolView } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { isRecord } from "@veyyon/utils";

function renderedType(args: unknown, details?: unknown): SearchType | undefined {
	if (isRecord(args) && (args.type === "files" || args.type === "text" || args.type === "structure")) {
		return args.type;
	}
	if (isRecord(details) && (details.type === "files" || details.type === "text" || details.type === "structure")) {
		return details.type;
	}
	return undefined;
}

function invalidSearchComponent(uiTheme: Theme, args: unknown, isPartial?: boolean): Component {
	if (isPartial) {
		return new Text(
			renderStatusLine({ icon: "pending", title: "Search", titleColor: "toolTitle", description: "…" }, uiTheme),
			1,
			0,
		);
	}
	// The type came from the model, so it reaches the row as arbitrary text.
	const received = isRecord(args) && typeof args.type === "string" ? args.type.trim() : "";
	const named = received ? replaceTabs(truncateToWidth(received, TRUNCATE_LENGTHS.CHIP)) : "(none)";
	return new Text(
		renderStatusLine(
			{
				icon: "warning",
				title: "Search",
				titleColor: "toolTitle",
				description: `invalid search type ${named} — expected files, text or structure`,
			},
			uiTheme,
		),
		1,
		0,
	);
}

export const searchToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: SearchToolInput, options: RenderResultOptions, uiTheme: Theme): Component {
		if (args?.type === "files") {
			return drawToolView(
				fileSearchToolView.renderCall(args as FileSearchRenderArgs, {
					expanded: options.expanded,
					partial: options.isPartial,
					frame: options.spinnerFrame,
				}),
				uiTheme,
				options.spinnerFrame,
			);
		}
		if (args?.type === "text") {
			return drawToolView(
				textSearchToolView.renderCall(args as TextSearchRenderArgs, {
					expanded: options.expanded,
					partial: options.isPartial,
					frame: options.spinnerFrame,
				}),
				uiTheme,
				options.spinnerFrame,
			);
		}
		if (args?.type === "structure") {
			return drawToolView(
				structureSearchToolView.renderCall(args as StructureSearchRenderArgs, {
					expanded: options.expanded,
					partial: options.isPartial,
					frame: options.spinnerFrame,
				}),
				uiTheme,
				options.spinnerFrame,
			);
		}
		return invalidSearchComponent(uiTheme, args, options.isPartial);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SearchToolInput,
	): Component {
		const type = renderedType(args, result.details);
		if (result.isError && !type) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}
		const details = result.details?.result;
		if (type === "files") {
			return drawToolView(
				fileSearchToolView.renderResult(
					{ ...result, details: details as FileSearchDetails | undefined } satisfies FileSearchViewResult,
					{ expanded: options.expanded, partial: options.isPartial, frame: options.spinnerFrame },
					args as FileSearchRenderArgs | undefined,
				),
				uiTheme,
				options.spinnerFrame,
			);
		}
		if (type === "text") {
			return drawToolView(
				textSearchToolView.renderResult(
					{ ...result, details: details as TextSearchDetails | undefined } satisfies TextSearchViewResult,
					{ expanded: options.expanded, partial: options.isPartial, frame: options.spinnerFrame },
					args as TextSearchRenderArgs | undefined,
				),
				uiTheme,
				options.spinnerFrame,
			);
		}
		if (type === "structure") {
			return drawToolView(
				structureSearchToolView.renderResult(
					{
						...result,
						details: details as StructureSearchDetails | undefined,
					} satisfies StructureSearchViewResult,
					{ expanded: options.expanded, partial: options.isPartial, frame: options.spinnerFrame },
					args as StructureSearchRenderArgs | undefined,
				),
				uiTheme,
				options.spinnerFrame,
			);
		}
		return invalidSearchComponent(uiTheme, args, options.isPartial);
	},
};
