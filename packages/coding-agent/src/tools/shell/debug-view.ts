/**
 * What the debug card shows, for any host.
 *
 * The tool half in `debug.ts` decides what the adapter did; this half states what the card says
 * about it and names no colour, no glyph and no width. The card is a panel of fetched data rather
 * than a report: the body is the adapter's own output and the session it came from, so a host states
 * the outcome on the card's edge and leaves the transcript on its ordinary ground.
 *
 * A debug result arrives in pieces while a session runs, which is why the view reads `partial`: the
 * same payload is a running card on one update and a settled one on the next, and only the surface
 * knows which.
 */

import { truncateToWidth } from "@veyyon/utils/width";
import type { FramedBlockView, StatusRowView, ToolViewRenderer, ViewLine, ViewSection } from "@veyyon/view";
import { formatSessionSnapshot } from "../../debug/session-snapshot";
import { PREVIEW_LIMITS, replaceTabs, shortenPath, TRUNCATE_LENGTHS } from "../core/render-utils";
import type { DebugParams, DebugToolDetails } from "./debug";

/** The arguments the card reads off a debug call, which is any subset the model has sent so far. */
export interface DebugViewArgs extends Partial<DebugParams> {}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface DebugViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: DebugToolDetails;
	isError?: boolean;
}

/** The emblem a settled debug card is titled by, instead of a success tick. */
const DEBUG_EMBLEM = "tool.debug";

/** The action a row names, with the underscores of a DAP request read as words. */
function spellAction(action: string): string {
	return action.replaceAll("_", " ");
}

/**
 * What the call row says the request is about, which is the first argument that identifies a target.
 *
 * The order is the order a reader recognises the call by: the program a launch names, then the
 * source line a breakpoint sits on, then the symbol, the expression, the command, and the references
 * a memory or instruction request carries. Each is cut to a column budget rather than to a width,
 * because a view is never told how wide the surface is.
 */
function summarizeCall(args: DebugViewArgs): string {
	const action = args.action ? spellAction(args.action) : "request";
	const target = args.program
		? shortenPath(args.program)
		: args.file && args.line !== undefined
			? `${shortenPath(args.file)}:${args.line}`
			: args.function ||
				args.expression ||
				args.command ||
				args.memory_reference ||
				args.instruction_reference ||
				args.data_id ||
				args.name;
	if (!target) return action;
	return `${action} ${truncateToWidth(target, TRUNCATE_LENGTHS.TITLE)}`;
}

/** The session the result came from, as the lines the tool already formats for a reader. */
function sessionSection(details: DebugToolDetails | undefined): ViewSection | undefined {
	if (details?.snapshot === undefined) return undefined;
	const lines = formatSessionSnapshot(details.snapshot).map((line): ViewLine => [{ text: replaceTabs(line) }]);
	return { label: "Session", lines };
}

/** The head of what the adapter said, and how much of it the card is not showing. */
function outputSection(result: DebugViewResult, expanded: boolean): ViewSection {
	const text = result.content.find(block => block.type === "text")?.text ?? "No output";
	const rawLines = replaceTabs(text).split("\n");
	const limit = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
	const lines = rawLines
		.slice(0, limit)
		.map((line): ViewLine => [{ text: truncateToWidth(line, TRUNCATE_LENGTHS.LINE) }]);
	const remaining = rawLines.length - lines.length;
	return {
		label: "Output",
		lines,
		hidden:
			remaining > 0 ? { count: remaining, noun: { one: "line", many: "lines" }, revealable: !expanded } : undefined,
	};
}

/** The row a debug card is headed by, which states the request and how the last update ended. */
function header(action: string, settled: boolean, isError: boolean): StatusRowView {
	return {
		kind: "statusRow",
		status: settled && !isError ? "success" : isError ? "error" : "running",
		emblem: settled && !isError ? DEBUG_EMBLEM : undefined,
		title: "Debug",
		description: action,
	};
}

export const debugToolView: Required<ToolViewRenderer<DebugViewArgs, DebugViewResult>> = {
	renderCall(args): StatusRowView {
		return { kind: "statusRow", status: "pending", title: "Debug", description: summarizeCall(args) };
	},

	renderResult(result, context, args): FramedBlockView {
		const action = spellAction(args?.action ?? result.details?.action ?? "debug");
		const isError = Boolean(result.isError);
		const session = sessionSection(result.details);
		return {
			kind: "framedBlock",
			header: header(action, context.partial !== true, isError),
			state: isError ? "error" : "success",
			// The body is the adapter's own transcript, not a verdict on it.
			contents: "data",
			sections:
				session === undefined
					? [outputSection(result, context.expanded)]
					: [session, outputSection(result, context.expanded)],
		};
	},
};
