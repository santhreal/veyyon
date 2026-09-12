import { formatNumber } from "@veyyon/utils";
import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ToolView, ToolViewContext, ToolViewRenderer, ViewLine, ViewSection, ViewTone } from "@veyyon/view";
import { formatDurationCoarse } from "../session/account-format";
import { extractResultText, sanitizeErrorText, TRUNCATE_LENGTHS } from "../tools/core/render-utils";
import type { GoalToolInput } from "./goal-tool";
import type { GoalStatus, GoalToolDetails } from "./state";

function describeOp(op: string | undefined): string {
	if (op === "create") return "set";
	if (op === "get") return "check";
	return op ?? "?";
}

/**
 * The tone a goal's status badge carries, which every host reads as meaning rather than colour.
 */
function goalBadgeTone(status: GoalStatus): ViewTone {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

interface GoalRenderArgs {
	op?: GoalToolInput["op"];
	objective?: string;
}

interface GoalRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: GoalToolDetails;
	isError?: boolean;
}

/**
 * The card the goal tool asks its host to draw.
 *
 * It names no colour, no glyph, no width and no component: the objective is a muted italic span, the
 * status is a toned badge, and the panel is a `framedBlock` whose sections the host wraps to a width
 * the tool is never told. The terminal drew this exact shape before as a closure over the width it
 * passed in, which is what tied the tool to it.
 *
 * `emblem` is how the settled card keeps the goal's own mark instead of an outcome tick. A host with
 * no entry for the key draws the status icon instead, so the row survives a host that never heard of
 * this tool.
 */
export const goalToolView: Required<ToolViewRenderer<GoalRenderArgs, GoalRenderResult>> = {
	renderCall(args: GoalRenderArgs): ToolView {
		const objective = args.objective?.trim();
		const meta: ViewLine[] = [];
		if (args.op === "create" && objective) {
			meta.push([
				{
					text: `"${truncateToWidth(sanitizeStatusText(objective), TRUNCATE_LENGTHS.TITLE)}"`,
					tone: "muted",
					italic: true,
				},
			]);
		}
		return { kind: "statusRow", status: "pending", title: "Goal", description: describeOp(args.op), meta };
	},

	renderResult(result: GoalRenderResult, _context: ToolViewContext, args?: GoalRenderArgs): ToolView {
		const details = result.details;
		const description = describeOp(details?.op ?? args?.op);

		if (result.isError) {
			const message = extractResultText(result.content);
			return {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "error", title: "Goal", description },
				state: "error",
				// The two leading spaces are the indent `formatErrorDetail` wrote, kept as text
				// because a tool states its own layout inside a line and the host owns the frame
				// around it. Each line carries the tone; the string form coloured the whole block
				// once, which left every line after the first uncoloured.
				sections: [
					{
						lines: sanitizeErrorText(message || "Goal tool failed")
							.split("\n")
							.map(line => [{ text: "  " }, { text: line, tone: "error" as ViewTone }]),
					},
				],
			};
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			return {
				kind: "statusRow",
				status: "warning",
				title: "Goal",
				description,
				meta: [[{ text: "no active goal" }]],
			};
		}

		const used = formatNumber(goal.tokensUsed);
		const tokensLine =
			goal.tokenBudget !== undefined
				? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
				: `${used} tokens`;
		const metaParts = [tokensLine];
		if (goal.timeUsedSeconds > 0) {
			metaParts.push(`${formatDurationCoarse(goal.timeUsedSeconds * 1000)} elapsed`);
		}

		const sections: ViewSection[] = [
			{
				lines: [
					[
						{
							text: `"${truncateToWidth(sanitizeStatusText(goal.objective), TRUNCATE_LENGTHS.LONG)}"`,
							tone: "muted",
							italic: true,
						},
					],
					[{ text: metaParts.join(" · "), tone: "dim" }],
				],
			},
		];
		const report = details?.completionBudgetReport;
		if (report) {
			sections.push({
				label: "Report",
				lines: report.split("\n").map(line => [{ text: line, tone: "muted" as ViewTone }]),
			});
		}

		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				emblem: "tool.goal",
				title: "Goal",
				description,
				badge: { label: goal.status, tone: goalBadgeTone(goal.status) },
			},
			state: "success",
			sections,
		};
	},
};
