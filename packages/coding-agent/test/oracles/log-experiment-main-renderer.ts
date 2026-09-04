/**
 * Differential oracle: log_experiment tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f
 * Frozen: never edited to make a test pass.
 */

import { formatNum } from "@veyyon/coding-agent/autoresearch/helpers";
import type { LogDetails } from "@veyyon/coding-agent/autoresearch/types";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";

export interface LogExperimentRenderArgs {
	metric: number;
	status: "keep" | "discard" | "crash" | "checks_failed";
	description: string;
	metrics?: Record<string, number>;
	asi?: Record<string, unknown>;
	commit?: string;
	justification?: string;
	flag_runs?: Array<{ run_id: number; reason: string }>;
}

export interface LogExperimentRenderResult {
	content: Array<{ type: string; text?: string }>;
	details?: LogDetails;
}

function renderSummary(details: LogDetails, theme: Theme): string {
	const { experiment, state } = details;
	const color = experiment.status === "keep" ? "success" : experiment.status === "discard" ? "warning" : "error";
	let summary = `${theme.fg(color, experiment.status.toUpperCase())} ${theme.fg("muted", truncateToWidth(replaceTabs(experiment.description), 100))}`;
	summary += ` ${theme.fg("accent", `${state.metricName}=${formatNum(experiment.metric, state.metricUnit)}`)}`;
	if (state.bestMetric !== null) {
		summary += ` ${theme.fg("dim", `baseline ${formatNum(state.bestMetric, state.metricUnit)}`)}`;
	}
	if (state.confidence !== null) {
		summary += ` ${theme.fg("dim", `conf ${state.confidence.toFixed(1)}x`)}`;
	}
	if (details.scopeDeviations.length > 0) {
		summary += ` ${theme.fg("warning", `deviations:${details.scopeDeviations.length}`)}`;
	}
	return summary;
}

export function renderCall(args: LogExperimentRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
	const color = args.status === "keep" ? "success" : args.status === "discard" ? "warning" : "error";
	const description = truncateToWidth(replaceTabs(args.description), 100);
	return new Text(
		`${theme.fg("toolTitle", theme.bold("log_experiment"))} ${theme.fg(color, args.status)} ${theme.fg("muted", description)}`,
		0,
		0,
	);
}

export function renderResult(
	result: LogExperimentRenderResult,
	_options: RenderResultOptions,
	theme: Theme,
): Component {
	const details = result.details;
	if (!details) {
		return new Text(replaceTabs(result.content.find(part => part.type === "text")?.text ?? ""), 0, 0);
	}
	return new Text(renderSummary(details, theme), 0, 0);
}
