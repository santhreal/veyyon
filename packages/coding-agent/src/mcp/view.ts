/**
 * What an MCP tool's card shows, for any host.
 *
 * An MCP tool is somebody else's tool reached over a protocol, so the card states two things this
 * repository does not own: the arguments that went out, and whatever came back. Both are values
 * rather than prose, which is why the card is a walk of the structure when the server answered with
 * JSON and its raw rows when it did not.
 *
 * The card is a headed block: a row naming `server/tool`, then the rows under it. What indent those
 * rows sit at, how many the terminal has room for and how a reader is told there is more are the
 * host's, which is the change the conversion makes visible -- the rows sat flush against the card's
 * left edge and now sit two columns under the row that heads them, the same two columns every other
 * frameless card uses. The tree branch each row opened with is gone with them: `└─` was terminal
 * chrome for a structure the lines already state as depth.
 */

import type { HeadedBlockView, StatusRowView, ToolViewContext, ToolViewRenderer, ViewLine } from "@veyyon/view";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "../tools/core/json-tree-render";
import { jsonTreeViewLines } from "../tools/core/json-tree-view";
import { stripOutputNotice } from "../tools/core/output-meta";
// The words a truncation is named by, from the leaf that owns them rather than from the styled
// helper beside it: a view states the sentence and never the colour it is drawn in.
import { formatTruncationMetaNotice } from "../tools/core/output-notice";
import type { MCPToolDetails } from "./tool-bridge";

/**
 * The columns the one-line argument preview spends before it drops the arguments that do not fit.
 *
 * A content bound rather than a terminal's width, for the reason every view carries one: the tool
 * has no width and the host has no way to drop a whole key/value pair from a line it is cutting. The
 * number is what an eighty-column card left for the preview after its indent and its connector.
 */
const INLINE_ARGS_WIDTH = 76;

/** The rows a raw text answer spends before the card says how many are left. */
const RAW_OUTPUT_ROWS_COLLAPSED = 4;
const RAW_OUTPUT_ROWS_EXPANDED = 12;

/** The result an MCP card reads: the text the server returned, and what the bridge recorded of it. */
export interface MCPViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: MCPToolDetails;
	isError?: boolean;
}

function argsRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** The walk bounds a card spends at each disclosure. */
function treeBounds(expanded: boolean): { maxDepth: number; maxLines: number; maxScalarLen: number } {
	return expanded
		? {
				maxDepth: JSON_TREE_MAX_DEPTH_EXPANDED,
				maxLines: JSON_TREE_MAX_LINES_EXPANDED,
				maxScalarLen: JSON_TREE_SCALAR_LEN_EXPANDED,
			}
		: {
				maxDepth: JSON_TREE_MAX_DEPTH_COLLAPSED,
				maxLines: JSON_TREE_MAX_LINES_COLLAPSED,
				maxScalarLen: JSON_TREE_SCALAR_LEN_COLLAPSED,
			};
}

/**
 * The value a text answer carries, when it carries one.
 *
 * A server answers with text whatever it means by it, so a body that opens with a brace or a bracket
 * is read as a structure and stated as one. A body that does not parse is rows of text, which is the
 * reading that invents nothing.
 */
function parsedStructure(text: string): unknown {
	if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The row the head of the card is, for a call still in flight. */
function callHeader(label: string): StatusRowView {
	return { kind: "statusRow", status: "pending", title: label };
}

/** The row the head of the card is, once the server answered. */
function resultHeader(result: MCPViewResult): StatusRowView {
	const isError = result.isError ?? result.details?.isError ?? false;
	const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
	if (isError) return { kind: "statusRow", status: "error", title };
	// The tool's own mark rather than a state glyph: a settled MCP call is one of many in a
	// transcript, and what a reader picks it out by is that it went to a server.
	return { kind: "statusRow", emblem: "tool.mcp", emblemTone: "accent", title };
}

function renderCall(rawArgs: unknown, _context: ToolViewContext, label: string): HeadedBlockView {
	const args = argsRecord(rawArgs);
	const preview = Object.keys(args).length > 0 ? formatArgsInline(args, INLINE_ARGS_WIDTH) : "";
	return {
		kind: "headedBlock",
		header: callHeader(label),
		lines: preview ? [[{ text: preview, tone: "dim" }]] : [],
	};
}

function renderResult(result: MCPViewResult, context: ToolViewContext, rawArgs?: unknown): HeadedBlockView {
	const expanded = context.expanded === true;
	const lines: ViewLine[] = [];
	let hidden: HeadedBlockView["hidden"];

	// The arguments are shown on the expanded card alone: a settled call is read for what came back,
	// and what went out is what a reader opens the card to check.
	const args = argsRecord(rawArgs);
	if (expanded && Object.keys(args).length > 0) {
		lines.push([{ text: "Args", tone: "dim" }]);
		const walked = jsonTreeViewLines(args, treeBounds(true));
		lines.push(...walked.lines);
		if (walked.truncated) lines.push([{ text: "…", tone: "dim" }]);
		lines.push([]);
	}
	const textContent = result.content?.find(entry => entry.type === "text")?.text ?? "";
	// The spill notice is written for the model, not for a reader: it appends `[Showing… artifact://N]`
	// to the body, which would make a JSON answer unparseable and bury the recovery link in prose.
	const body = stripOutputNotice(textContent, result.details?.meta).trimEnd();
	const truncation = result.details?.meta?.truncation;

	if (body === "") {
		lines.push([{ text: "(no output)", tone: "dim" }]);
	} else {
		const structure = parsedStructure(body);
		if (structure !== undefined) {
			const walked = jsonTreeViewLines(structure, treeBounds(expanded));
			lines.push(...walked.lines);
			// A collapsed structure always offers more, because expanding it deepens the walk and
			// lengthens every scalar in it, whether or not this one was cut.
			hidden = expanded
				? walked.truncated
					? { count: 0, revealable: false }
					: undefined
				: { count: 0, revealable: true };
			if (expanded && walked.truncated) lines.push([{ text: "…", tone: "dim" }]);
		} else {
			const rows = body.split("\n");
			const max = expanded ? RAW_OUTPUT_ROWS_EXPANDED : RAW_OUTPUT_ROWS_COLLAPSED;
			for (const row of rows.slice(0, max)) lines.push([{ text: row, tone: "output" }]);
			const remaining = rows.length - max;
			hidden =
				remaining > 0
					? { count: remaining, noun: { one: "line", many: "lines" }, revealable: !expanded }
					: expanded
						? undefined
						: { count: 0, revealable: true };
		}
	}

	if (truncation !== undefined) {
		lines.push([{ text: formatTruncationMetaNotice(truncation), tone: "warning", badge: true }]);
	}

	return {
		kind: "headedBlock",
		header: resultHeader(result),
		lines,
		...(hidden === undefined ? {} : { hidden }),
	};
}

/**
 * The card one MCP tool draws, bound to the tool it names.
 *
 * A factory rather than a constant because the call row states which tool was called, and until the
 * server answers, the only party that knows that is the tool object itself: a call carries arguments
 * and no name of its own.
 */
export function createMCPToolView(label: string): Required<ToolViewRenderer<unknown, MCPViewResult>> {
	return {
		renderCall: (rawArgs, context) => renderCall(rawArgs, context, label),
		renderResult: (result, context, rawArgs) => renderResult(result, context, rawArgs),
	};
}
