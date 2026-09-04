/**
 * What the resolve card shows, for any host.
 *
 * The tool half in `resolve.ts` decides what happened to the pending action; this half states what
 * the card says about it and names no colour, no glyph and no width. The result is a notice rather
 * than a row or a panel: a resolution is one decision, and the card carries that decision across its
 * whole body, which a terminal fills as a plate and a browser as a callout.
 */

import { truncateToWidth } from "@veyyon/utils/width";
import type { NoticeView, StatusRowView, ToolViewRenderer, ViewLine } from "@veyyon/view";
import { replaceTabs } from "../core/render-utils";
import type { ResolveParams, ResolveToolDetails } from "./resolve";

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface ResolveViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: ResolveToolDetails;
	isError?: boolean;
}

/** Columns of reason the call row carries before the rest is dropped. */
const CALL_REASON_WIDTH = 72;

/** The separator a label uses to name its source before its summary. */
const SOURCE_SEPARATOR = ": ";

/**
 * The two halves of a label, which names the source of the pending action before what it does.
 *
 * A label with no separator is all summary: the source is what the resolve card sets off at the end
 * of its headline, and inventing one from a label that never stated it would name the wrong tool.
 */
function splitLabel(label: string): { source?: string; summary: string } {
	const index = label.indexOf(SOURCE_SEPARATOR);
	if (index <= 0) return { summary: label };
	return { source: label.slice(0, index).trim(), summary: label.slice(index + SOURCE_SEPARATOR.length).trim() };
}

export const resolveToolView: Required<ToolViewRenderer<ResolveParams, ResolveViewResult>> = {
	renderCall(args): StatusRowView {
		const reason = args.reason?.trim();
		const shown = reason ? truncateToWidth(reason, CALL_REASON_WIDTH, "") : undefined;
		return {
			kind: "statusRow",
			status: "pending",
			title: "Resolve",
			description: args.action,
			badge: {
				label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
				tone: args.action === "apply" ? "success" : "warning",
			},
			meta: shown === undefined ? undefined : [[{ text: shown, tone: "muted" }]],
		};
	},

	renderResult(result): NoticeView {
		const details = result.details;
		const action = details?.action ?? "apply";
		const applied = action === "apply" && !result.isError;
		const { source, summary } = splitLabel(replaceTabs(details?.label ?? "pending action"));
		// A resolution that reports nothing is still a decision, so the card states the absence rather
		// than drawing an empty line under the headline.
		const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
		const verb = applied ? "Accept" : action === "apply" ? "Failed" : "Discard";
		const headline: ViewLine = [{ text: `${verb}:`, bold: true }, { text: ` ${summary}` }];
		return {
			kind: "notice",
			state: result.isError ? "error" : applied ? "success" : "warning",
			mark: applied ? "tool.resolve" : "status.error",
			headline,
			tag: source,
			body: [[{ text: reason, italic: true }]],
		};
	},
};
