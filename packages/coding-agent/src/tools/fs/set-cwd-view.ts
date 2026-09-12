import type { AgentToolResult } from "@veyyon/agent-core";
import type { FramedBlockView, TextBlockView, ToolViewRenderer, ViewLine } from "@veyyon/view";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../core/render-utils";
import { SET_CWD_TOOL_NAME } from "./reroot-hint";
import type { SetCwdToolDetails, SetCwdToolInput } from "./set-cwd";

/**
 * The call and result cards as views, so this tool names no host.
 *
 * The call row is a text block rather than a status row: the row is the tool's own title with the
 * requested path after it, and a status row would put an outcome icon in front of a call that has
 * not finished. The result is a framed block whose header states the move.
 */
export const setCwdToolView: Required<ToolViewRenderer<SetCwdToolInput, AgentToolResult<SetCwdToolDetails>>> = {
	renderCall(args): TextBlockView {
		const pathArg = (args as Partial<SetCwdToolInput> | null)?.path;
		const label = typeof pathArg === "string" ? truncateToWidth(shortenPath(pathArg), TRUNCATE_LENGTHS.TITLE) : "…";
		return { kind: "textBlock", spans: [{ text: `${SET_CWD_TOOL_NAME} ${label}`, tone: "title" }] };
	},

	renderResult(result): FramedBlockView {
		const details = result.details;
		// A no-op used to render exactly like a real move: the same green frame
		// naming the same directory. Reading back a run of retries, there was no
		// way to tell a change from a repeat of the same no-op.
		const line = !details
			? "cwd"
			: details.previous !== details.cwd
				? `${shortenPath(details.previous)} → ${shortenPath(details.cwd)}`
				: `${shortenPath(details.cwd)} (already here)`;
		// The rule delta is the part of a re-root that changes how the agent behaves,
		// so it belongs on the header rather than only in the model's copy of the
		// result. A move that silently swapped the governing AGENTS.md looked
		// identical to one that changed nothing.
		const applied = details?.rulesApplied?.length ?? 0;
		const dropped = details?.rulesDropped?.length ?? 0;
		const meta: ViewLine[] = [[{ text: line }]];
		if (applied > 0 || dropped > 0) {
			const counts = [applied > 0 ? `+${applied}` : "", dropped > 0 ? `-${dropped}` : ""].filter(Boolean).join(" ");
			meta.push([{ text: `${counts} ${applied + dropped === 1 ? "rule file" : "rule files"}` }]);
		}
		return {
			kind: "framedBlock",
			header: { kind: "statusRow", status: "success", title: "cwd", meta },
			sections: [],
		};
	},
};
