/**
 * Differential oracle: report_finding tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 * Frozen: never edited to make a test pass.
 *
 * `getPriorityDisplay` is carried verbatim because the row's mark, its label colour and its tone all
 * came out of it, and the priority table it reads is the one thing the conversion could have quietly
 * re-spelled.
 */

import type { Theme, ThemeColor } from "@veyyon/coding-agent/theme/theme";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";

export type FindingPriority = "P0" | "P1" | "P2" | "P3";

interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: "status.error" | "status.warning" | "status.info";
	color: ThemeColor;
}

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

function getPriorityDisplay(
	priority: FindingPriority,
	theme: Theme,
): { label: string; icon: string; color: ThemeColor } {
	const label = priority;
	const meta = PRIORITY_INFO[priority] ?? { symbol: "status.info", color: "muted" as const };
	return {
		label,
		icon: theme.styledSymbol(meta.symbol, meta.color),
		color: meta.color,
	};
}

export interface ReviewRenderArgs {
	priority: FindingPriority;
	title: string;
}

export interface ReviewRenderDetails {
	title: string;
	priority: FindingPriority;
	file_path: string;
	line_start: number;
	line_end: number;
}

export interface ReviewRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: ReviewRenderDetails;
}

export function renderCall(args: ReviewRenderArgs, theme: Theme): Component {
	const { label, icon, color } = getPriorityDisplay(args.priority, theme);
	const titleText = String(args.title).replace(/^\[P\d\]\s*/, "");
	return new Text(
		`${theme.fg("toolTitle", theme.bold("report_finding "))}${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg(
			"dim",
			titleText,
		)}`,
		0,
		0,
	);
}

export function renderResult(result: ReviewRenderResult, theme: Theme): Component {
	const { details } = result;
	if (!details) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}

	const { label, icon, color } = getPriorityDisplay(details.priority, theme);
	const location = `${details.file_path}:${details.line_start}${
		details.line_end !== details.line_start ? `-${details.line_end}` : ""
	}`;

	return new Text(
		`${theme.styledSymbol("tool.review", "accent")} ${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg(
			"dim",
			location,
		)}`,
		0,
		0,
	);
}
