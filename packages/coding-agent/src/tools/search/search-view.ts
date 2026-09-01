/**
 * The card for `search`, which is one tool over three searches.
 *
 * The tool takes a `type` and runs a filename, content or syntax search, and each of those has its
 * own card: this states which one a call reaches. It is a dispatcher rather than a card of its own,
 * and the three rows it does describe are the ones no sub-view can: a call whose type has not
 * arrived yet, a type that is not one of the three, and a failure that named no type at all.
 *
 * The type is read off the call and then off the details, in that order, because the two disagree
 * exactly once: a streamed call whose `type` delta has not landed carries no type while its result
 * does. Reading the details second keeps a settled card on the right sub-view when the args were
 * never recorded.
 */

import { isRecord } from "@veyyon/utils";
import type { ToolView, ToolViewContext, ToolViewRenderer } from "@veyyon/view";
import { replaceTabs, sanitizeErrorText, TRUNCATE_LENGTHS, truncateToWidth } from "../core/render-utils";
import type { FileSearchDetails, FileSearchRenderArgs } from "./file-search";
import { type FileSearchViewResult, fileSearchToolView } from "./file-search-view";
import type { SearchToolDetails, SearchToolInput, SearchType } from "./search";
import type { StructureSearchDetails, StructureSearchRenderArgs } from "./structure-search";
import { type StructureSearchViewResult, structureSearchToolView } from "./structure-search-view";
import type { TextSearchDetails, TextSearchRenderArgs } from "./text-search";
import { type TextSearchViewResult, textSearchToolView } from "./text-search-view";

export interface SearchViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: SearchToolDetails;
	isError?: boolean;
}

/** The search this call is, or nothing: the type came from the model, so it may be absent or junk. */
function renderedType(args: unknown, details?: unknown): SearchType | undefined {
	if (isRecord(args) && (args.type === "files" || args.type === "text" || args.type === "structure")) {
		return args.type;
	}
	if (isRecord(details) && (details.type === "files" || details.type === "text" || details.type === "structure")) {
		return details.type;
	}
	return undefined;
}

/**
 * The row for a call with no usable type: still arriving, or naming a search that does not exist.
 *
 * A partial call is a row with nothing to say yet, so it says the tool and an ellipsis. A settled one
 * names what it received, which is arbitrary text from the model and is cut and tab-flattened before
 * it reaches a row.
 */
function invalidTypeRow(args: unknown, partial: boolean): ToolView {
	if (partial) {
		return { kind: "statusRow", status: "pending", title: "Search", titleTone: "title", description: "…" };
	}
	const received = isRecord(args) && typeof args.type === "string" ? args.type.trim() : "";
	const named = received ? replaceTabs(truncateToWidth(received, TRUNCATE_LENGTHS.CHIP)) : "(none)";
	return {
		kind: "statusRow",
		status: "warning",
		title: "Search",
		titleTone: "title",
		description: `invalid search type ${named} — expected files, text or structure`,
	};
}

export const searchToolView: Required<ToolViewRenderer<SearchToolInput, SearchViewResult>> = {
	renderCall(args: SearchToolInput, context: ToolViewContext): ToolView {
		const type = renderedType(args);
		if (type === "files") return fileSearchToolView.renderCall(args as FileSearchRenderArgs, context);
		if (type === "text") return textSearchToolView.renderCall(args as TextSearchRenderArgs, context);
		if (type === "structure") return structureSearchToolView.renderCall(args as StructureSearchRenderArgs, context);
		return invalidTypeRow(args, context.partial === true);
	},

	renderResult(result: SearchViewResult, context: ToolViewContext, args?: SearchToolInput): ToolView {
		const type = renderedType(args, result.details);
		// A failure with no type never reached a search, so no sub-view owns it: the tool's own message
		// is the whole card, and it is the one row here that states its own error mark.
		if (result.isError === true && type === undefined) {
			const text = result.content?.find(entry => entry.type === "text")?.text;
			return {
				kind: "textBlock",
				spans: [
					{ text: "", symbol: "status.error", tone: "error" },
					{ text: " " },
					{ text: `Error: ${sanitizeErrorText(text)}`, tone: "error" },
				],
			};
		}
		const details = result.details?.result;
		if (type === "files") {
			return fileSearchToolView.renderResult(
				{ ...result, details: details as FileSearchDetails | undefined } satisfies FileSearchViewResult,
				context,
				args as FileSearchRenderArgs | undefined,
			);
		}
		if (type === "text") {
			return textSearchToolView.renderResult(
				{ ...result, details: details as TextSearchDetails | undefined } satisfies TextSearchViewResult,
				context,
				args as TextSearchRenderArgs | undefined,
			);
		}
		if (type === "structure") {
			return structureSearchToolView.renderResult(
				{ ...result, details: details as StructureSearchDetails | undefined } satisfies StructureSearchViewResult,
				context,
				args as StructureSearchRenderArgs | undefined,
			);
		}
		return invalidTypeRow(args, context.partial === true);
	},
};
