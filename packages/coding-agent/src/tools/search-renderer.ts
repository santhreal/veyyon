import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { isRecord } from "@veyyon/utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui";
import {
	fileSearchRenderer,
	type FileSearchDetails,
	type FileSearchRenderArgs,
} from "./glob";
import {
	textSearchRenderer,
	type TextSearchDetails,
	type TextSearchRenderArgs,
} from "./grep";
import {
	structureSearchRenderer,
	type StructureSearchDetails,
	type StructureSearchRenderArgs,
} from "./ast-grep";
import type { SearchToolDetails, SearchToolInput, SearchType } from "./search";

function renderedType(args: unknown, details?: unknown): SearchType | undefined {
	if (isRecord(args) && (args.type === "files" || args.type === "text" || args.type === "structure")) {
		return args.type;
	}
	if (isRecord(details) && (details.type === "files" || details.type === "text" || details.type === "structure")) {
		return details.type;
	}
	return undefined;
}

function innerDetails(details: unknown): unknown {
	return isRecord(details) && "result" in details ? details.result : undefined;
}

function invalidSearchComponent(uiTheme: Theme): Component {
	return new Text(
		renderStatusLine(
			{ icon: "warning", title: "Search", titleColor: "toolTitle", description: "invalid search type" },
			uiTheme,
		),
		1,
		0,
	);
}

export const searchToolRenderer = {
	inline: true,
	renderCall(args: SearchToolInput, options: RenderResultOptions, uiTheme: Theme): Component {
		if (args.type === "files") {
			return fileSearchRenderer.renderCall(args as FileSearchRenderArgs, options, uiTheme);
		}
		if (args.type === "text") {
			return textSearchRenderer.renderCall(args as TextSearchRenderArgs, options, uiTheme);
		}
		if (args.type === "structure") {
			return structureSearchRenderer.renderCall(args as StructureSearchRenderArgs, options, uiTheme);
		}
		return invalidSearchComponent(uiTheme);
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: SearchToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: SearchToolInput,
	): Component {
		const type = renderedType(args, result.details);
		const details = innerDetails(result.details);
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
		return invalidSearchComponent(uiTheme);
	},
};
