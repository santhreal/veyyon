import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { isRecord } from "@veyyon/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine, truncateToWidth } from "../tui";
import { type FileSearchDetails, type FileSearchRenderArgs, fileSearchRenderer } from "./file-search";
import { formatErrorMessage, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";
import type { SearchToolDetails, SearchToolInput, SearchType } from "./search";
import {
	type StructureSearchDetails,
	type StructureSearchRenderArgs,
	structureSearchRenderer,
} from "./structure-search";
import { type TextSearchDetails, type TextSearchRenderArgs, textSearchRenderer } from "./text-search";

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
			return fileSearchRenderer.renderCall(args as FileSearchRenderArgs, options, uiTheme);
		}
		if (args?.type === "text") {
			return textSearchRenderer.renderCall(args as TextSearchRenderArgs, options, uiTheme);
		}
		if (args?.type === "structure") {
			return structureSearchRenderer.renderCall(args as StructureSearchRenderArgs, options, uiTheme);
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
			return fileSearchRenderer.renderResult(
				{ ...result, details: details as FileSearchDetails | undefined },
				options,
				uiTheme,
				args as FileSearchRenderArgs | undefined,
			);
		}
		if (type === "text") {
			return textSearchRenderer.renderResult(
				{ ...result, details: details as TextSearchDetails | undefined },
				options,
				uiTheme,
				args as TextSearchRenderArgs | undefined,
			);
		}
		if (type === "structure") {
			return structureSearchRenderer.renderResult(
				{ ...result, details: details as StructureSearchDetails | undefined },
				options,
				uiTheme,
				args as StructureSearchRenderArgs | undefined,
			);
		}
		return invalidSearchComponent(uiTheme, args, options.isPartial);
	},
};
