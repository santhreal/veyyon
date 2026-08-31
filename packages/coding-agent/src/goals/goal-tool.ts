import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { formatNumber, prompt } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";
import type { ToolView, ToolViewContext, ToolViewRenderer, ViewSection, ViewSpan, ViewTone } from "@veyyon/view";
import { type } from "arktype";
import { toolsPrompts } from "../prompts/tools/rows";
import { formatDurationCoarse } from "../slash-commands/helpers/format";
import type { ToolSession } from "../tools";
import { sanitizeErrorText, TRUNCATE_LENGTHS } from "../tools/core/render-utils";
import { ToolError } from "../tools/core/tool-errors";
import { completionBudgetReport, remainingTokens } from "./runtime";
import type { Goal, GoalStatus, GoalToolDetails } from "./state";

const goalSchema = type({
	op: type("'create' | 'get' | 'complete' | 'resume' | 'drop'").describe("goal operation"),
	"objective?": type("string").describe("goal objective"),
});

export type GoalToolInput = typeof goalSchema.infer;

export interface GoalToolResponse {
	goal: Goal | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
}

export function buildGoalToolResponse(
	goal: Goal | null | undefined,
	options?: { includeCompletionReport?: boolean; budgetsEnabled?: boolean },
): GoalToolResponse {
	const resolvedGoal = goal ?? null;
	return {
		goal: resolvedGoal,
		remainingTokens: options?.budgetsEnabled ? remainingTokens(resolvedGoal) : null,
		completionBudgetReport:
			options?.includeCompletionReport && resolvedGoal?.status === "complete"
				? completionBudgetReport(
						options.budgetsEnabled ? resolvedGoal : { ...resolvedGoal, tokenBudget: undefined },
					)
				: null,
	};
}

function validateCreateParams(params: GoalToolInput): { objective: string } {
	const objective = params.objective?.trim();
	if (!objective) {
		throw new ToolError("objective is required when op=create");
	}
	return { objective };
}

export class GoalTool implements AgentTool<typeof goalSchema, GoalToolDetails> {
	readonly name = "goal";
	readonly label = "Goal";
	readonly description = prompt.render(toolsPrompts["tools/goal"].text);
	readonly parameters = goalSchema;
	readonly strict = true;
	readonly intent = "omit" as const;
	/**
	 * The tool's own card, as data. Declared here so the live tool carries it and any host that draws
	 * a transcript reads it off the tool rather than from a terminal-side registry.
	 */
	readonly view = goalToolView;
	/** The result card is the whole card: it repeats the header the call row drew. */
	readonly mergeCallAndResult = true;
	readonly #session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
	}

	async execute(
		_toolCallId: string,
		params: GoalToolInput,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GoalToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GoalToolDetails>> {
		if ("token_budget" in params) {
			throw new ToolError("token_budget is not supported; model goal budgets are controlled in Settings.");
		}
		const runtime = this.#session.getGoalRuntime?.();
		if (!runtime) {
			throw new ToolError("Goal mode is not active.");
		}

		const budgetsEnabled = this.#session.settings.get("goal.modelBudgetsEnabled");
		let response: GoalToolResponse;
		if (params.op === "create") {
			const created = await runtime.createGoal(validateCreateParams(params));
			response = buildGoalToolResponse(created.goal, { budgetsEnabled });
		} else if (params.op === "get") {
			const state = this.#session.getGoalModeState?.();
			response = buildGoalToolResponse(state?.goal ?? null, { budgetsEnabled });
		} else if (params.op === "resume") {
			const resumed = await runtime.resumeGoal();
			response = buildGoalToolResponse(resumed.goal, { budgetsEnabled });
		} else if (params.op === "drop") {
			const dropped = await runtime.dropGoal();
			response = buildGoalToolResponse(dropped ?? null, { budgetsEnabled });
		} else {
			const completed = await runtime.completeGoalFromTool();
			response = buildGoalToolResponse(completed, { includeCompletionReport: true, budgetsEnabled });
		}
		let text: string;
		if (response.goal) {
			text = `Goal: ${response.goal.objective}\nStatus: ${response.goal.status}\nTokens: ${response.goal.tokensUsed} used`;
			if (budgetsEnabled && response.goal.tokenBudget !== undefined) {
				text += ` / ${response.goal.tokenBudget} budget`;
			}
			if (budgetsEnabled && response.remainingTokens !== null) {
				text += `\nRemaining tokens: ${response.remainingTokens}`;
			}
			if (response.completionBudgetReport) {
				text += `\n\n${response.completionBudgetReport}`;
			}
		} else {
			text = "No active goal.";
		}
		return {
			content: [{ type: "text", text }],
			details: {
				op: params.op,
				goal: response.goal,
				remainingTokens: response.remainingTokens,
				completionBudgetReport: response.completionBudgetReport,
			},
		};
	}
}

function describeOp(op: string | undefined): string {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		default:
			return op ?? "?";
	}
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
		const meta: ViewSpan[] = [];
		if (args.op === "create" && objective) {
			meta.push({
				text: `"${truncateToWidth(objective, TRUNCATE_LENGTHS.TITLE)}"`,
				tone: "muted",
				italic: true,
			});
		}
		return { kind: "statusRow", status: "pending", title: "Goal", description: describeOp(args.op), meta };
	},

	renderResult(result: GoalRenderResult, _context: ToolViewContext, args?: GoalRenderArgs): ToolView {
		const details = result.details;
		const description = describeOp(details?.op ?? args?.op);

		if (result.isError) {
			const message = result.content?.find(part => part.type === "text")?.text ?? "";
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
				meta: [{ text: "no active goal" }],
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
							text: `"${truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG)}"`,
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
