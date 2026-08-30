/**
 * Differential oracle: goal tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 * Frozen: never edited to make a test pass.
 */

import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { GoalStatus, GoalToolDetails } from "@veyyon/coding-agent/goals/state";
import { formatDurationCoarse } from "@veyyon/coding-agent/slash-commands/helpers/format";
import type { Theme, ThemeColor } from "@veyyon/coding-agent/theme/theme";
import { formatErrorDetail, TRUNCATE_LENGTHS } from "@veyyon/coding-agent/tools/render-utils";
import { framedBlock, renderStatusLine } from "@veyyon/coding-agent/tui";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { formatNumber } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";

export interface GoalRenderArgs {
	op?: "create" | "get" | "complete" | "resume" | "drop";
	objective?: string;
}

export interface GoalRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: GoalToolDetails;
	isError?: boolean;
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

function goalBadgeColor(status: GoalStatus): ThemeColor {
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

export function renderCall(args: GoalRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const description = describeOp(args.op);
	const meta: string[] = [];
	const trimmedObjective = args.objective?.trim();
	if (args.op === "create" && trimmedObjective) {
		const objective = truncateToWidth(trimmedObjective, TRUNCATE_LENGTHS.TITLE);
		meta.push(uiTheme.italic(uiTheme.fg("muted", `"${objective}"`)));
	}
	return new Text(renderStatusLine({ icon: "pending", title: "Goal", description, meta }, uiTheme), 0, 0);
}

export function renderResult(
	result: GoalRenderResult,
	_options: RenderResultOptions,
	uiTheme: Theme,
	args?: GoalRenderArgs,
): Component {
	const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
	const details = result.details;
	const op = details?.op ?? args?.op;
	const description = describeOp(op);

	if (result.isError) {
		const header = renderStatusLine({ icon: "error", title: "Goal", description }, uiTheme);
		return framedBlock(uiTheme, width => ({
			header,
			sections: [{ lines: formatErrorDetail(fallbackText || "Goal tool failed", uiTheme).split("\n") }],
			state: "error",
			borderColor: "error",
			width,
		}));
	}

	const goal = details?.goal ?? null;
	if (!goal) {
		return new Text(
			renderStatusLine({ icon: "warning", title: "Goal", description, meta: ["no active goal"] }, uiTheme),
			0,
			0,
		);
	}

	const header = renderStatusLine(
		{
			iconOverride: uiTheme.styledSymbol("tool.goal", "accent"),
			title: "Goal",
			description,
			badge: { label: goal.status, color: goalBadgeColor(goal.status) },
		},
		uiTheme,
	);

	const lines: string[] = [];
	const objectiveText = truncateToWidth(goal.objective.trim(), TRUNCATE_LENGTHS.LONG);
	lines.push(uiTheme.italic(uiTheme.fg("muted", `"${objectiveText}"`)));

	const used = formatNumber(goal.tokensUsed);
	const tokensLine =
		goal.tokenBudget !== undefined
			? `${used} / ${formatNumber(goal.tokenBudget)} tokens (${formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed))} left)`
			: `${used} tokens`;
	const metaParts = [tokensLine];
	if (goal.timeUsedSeconds > 0) {
		metaParts.push(`${formatDurationCoarse(goal.timeUsedSeconds * 1000)} elapsed`);
	}
	lines.push(uiTheme.fg("dim", metaParts.join(" · ")));

	const report = details?.completionBudgetReport;
	const sections: Array<{ label?: string; lines: string[] }> = [{ lines }];
	if (report) {
		sections.push({ label: "Report", lines: report.split("\n").map(line => uiTheme.fg("muted", line)) });
	}

	return framedBlock(uiTheme, width => ({
		header,
		sections,
		state: "success",
		borderColor: "borderMuted",
		width,
	}));
}
